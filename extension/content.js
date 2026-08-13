/*
  Lowballer content script — layered extraction.

  Reads ONLY the listing page the user is already looking at, in their own
  logged-in tab, when they click the button. No cookie access, no background
  crawling, no requests made on the user's behalf.

  ── Why it's built in layers ────────────────────────────────────────────────
  CSS class names are the most volatile thing on a web page — Facebook ships
  generated class names that change on every deploy. So selectors are the LAST
  resort here, not the first. We try, in order of stability:

    L1  JSON-LD (schema.org)   — publishers maintain it for Google; changes rarely
    L2  Meta tags (OpenGraph)  — maintained for link previews; changes rarely
    L3  Embedded JSON keys     — API *field names* (marketplace_listing_title,
                                 primaryDamage…). Far more stable than classes.
    L4  Semantic DOM           — h1, [itemprop], data-testid. Moderately stable.
    L5  Visible text + regex   — always works as long as a human can read the page.

  Every field records which layer produced it. If the high-stability layers all
  miss, we still ship the full visible text and mark confidence "low" — the site
  hands that to Claude, which parses prose fine. A site redesign degrades the
  result instead of breaking it.
*/

(() => {
  if (window.__lowballerInjected) return;
  window.__lowballerInjected = true;

  const DEFAULT_BASE = "https://lowballer.com";
  const PAYLOAD_VERSION = 2;

  // ── utilities ─────────────────────────────────────────────────────────────
  const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s || "").toString().slice(0, n);
  const digits = (s) => (s == null ? "" : String(s).replace(/[^\d]/g, ""));

  /** Pull the first plausible USD amount out of a string. */
  function parseMoney(s) {
    if (s == null) return "";
    const str = String(s);
    const m = str.match(/\$\s?([\d][\d,]*)(?:\.\d{2})?/) || str.match(/^([\d][\d,]*)(?:\.\d{2})?$/);
    if (!m) return "";
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? String(n) : "";
  }

  /** Safe layer runner — one bad layer must never kill extraction. */
  function attempt(fn, fallback = null) {
    try {
      return fn();
    } catch (e) {
      return fallback;
    }
  }

  // ── L1: JSON-LD ───────────────────────────────────────────────────────────
  const LD_TYPES = /product|vehicle|car|offer|individualproduct|item/i;

  function walkLd(node, out, depth = 0) {
    if (!node || depth > 6) return out;
    if (Array.isArray(node)) {
      node.forEach((n) => walkLd(n, out, depth + 1));
      return out;
    }
    if (typeof node !== "object") return out;

    const type = node["@type"];
    const typeStr = Array.isArray(type) ? type.join(" ") : String(type || "");
    if (LD_TYPES.test(typeStr) || node.offers || node.name) {
      if (!out.title && node.name) out.title = String(node.name);
      if (!out.description && node.description) out.description = String(node.description);
      if (!out.condition && node.itemCondition) {
        out.condition = String(node.itemCondition).replace(/.*\//, "").replace(/Condition$/, "");
      }
      if (!out.brand && node.brand) out.brand = String(node.brand?.name || node.brand);
      if (!out.mileage && node.mileageFromOdometer) {
        out.mileage = digits(node.mileageFromOdometer?.value ?? node.mileageFromOdometer);
      }
      if (!out.year && node.vehicleModelDate) out.year = digits(node.vehicleModelDate).slice(0, 4);
      if (!out.model && node.model) out.model = String(node.model?.name || node.model);
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      if (!out.price && offer?.price != null) out.price = parseMoney(offer.price);
      if (!out.price && node.price != null) out.price = parseMoney(node.price);
    }
    Object.values(node).forEach((v) => {
      if (v && typeof v === "object") walkLd(v, out, depth + 1);
    });
    return out;
  }

  function layerJsonLd() {
    const out = {};
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      attempt(() => walkLd(JSON.parse(s.textContent), out));
    });
    return out;
  }

  // ── L2: meta tags ─────────────────────────────────────────────────────────
  function meta(...names) {
    for (const n of names) {
      const el =
        document.querySelector(`meta[property="${n}"]`) ||
        document.querySelector(`meta[name="${n}"]`) ||
        document.querySelector(`meta[itemprop="${n}"]`);
      const c = el?.getAttribute("content");
      if (c && c.trim()) return c.trim();
    }
    return "";
  }

  function layerMeta() {
    return {
      title: meta("og:title", "twitter:title"),
      description: meta("og:description", "twitter:description", "description"),
      price: parseMoney(meta("product:price:amount", "og:price:amount", "price")),
    };
  }

  // ── L3: embedded JSON field names ─────────────────────────────────────────
  /*
    Sites embed their API responses in inline <script> tags. The FIELD NAMES in
    those payloads are backend contract names — they survive redesigns that
    obliterate every CSS class on the page. We search the raw script text for
    known keys rather than parsing the whole (often enormous) blob.
  */
  function scriptText(limit = 3_000_000) {
    let buf = "";
    for (const s of document.querySelectorAll("script:not([src])")) {
      const t = s.textContent;
      if (!t || t.length < 40) continue;
      buf += t + "\n";
      if (buf.length > limit) break;
    }
    return buf;
  }

  /** Find "key":"value" or "key":123 for the first key that hits. */
  function jsonKey(blob, keys, { numeric = false } = {}) {
    for (const key of keys) {
      const re = numeric
        ? new RegExp(`"${key}"\\s*:\\s*"?(-?[\\d.]+)"?`)
        : new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,600})"`);
      const m = blob.match(re);
      if (m && m[1]) {
        if (numeric) return m[1];
        // unescape \" \\ \/ and \uXXXX
        return attempt(() => JSON.parse(`"${m[1]}"`), m[1].replace(/\\"/g, '"'));
      }
    }
    return "";
  }

  const EMBEDDED_KEYS = {
    title: [
      "marketplace_listing_title", "custom_title", "listing_title",
      "productTitle", "itemTitle", "lotTitle", "ldescription", "title",
    ],
    description: [
      "redacted_description", "listing_description", "marketplace_listing_description",
      "productDescription", "description_text", "text",
    ],
    priceFormatted: ["formatted_amount", "formatted_price", "display_price", "price_text"],
    priceNumeric: ["amount_with_offset", "current_bid", "currentBid", "highBid", "amount", "price"],
    mileage: ["odometer", "odometerReading", "vehicle_odometer_data", "mileage", "miles"],
    year: ["vehicle_year", "modelYear", "year"],
    make: ["vehicle_make", "make", "makeDescription"],
    model: ["vehicle_model", "modelDescription"],
    damage: ["primaryDamage", "primary_damage", "damageDescription", "lossType"],
    damage2: ["secondaryDamage", "secondary_damage"],
    titleType: ["titleType", "saleDocumentType", "title_type", "documentType"],
    runs: ["runAndDrive", "runsAndDrives", "engineStartCode", "highlights"],
  };

  function layerEmbedded() {
    const blob = scriptText();
    if (!blob) return {};

    // Facebook stores price as amount_with_offset (cents). Prefer a formatted
    // string when one is present, since offsets differ by currency.
    let price = parseMoney(jsonKey(blob, EMBEDDED_KEYS.priceFormatted));
    if (!price) {
      const raw = jsonKey(blob, EMBEDDED_KEYS.priceNumeric, { numeric: true });
      if (raw) {
        const n = parseFloat(raw);
        if (Number.isFinite(n) && n > 0) {
          // amount_with_offset is in minor units; anything else is dollars.
          price = String(Math.round(/offset/i.test(blob.slice(0, 0)) ? n : n));
          if (blob.includes('"amount_with_offset"') && n >= 1000) price = String(Math.round(n / 100));
        }
      }
    }

    return {
      title: jsonKey(blob, EMBEDDED_KEYS.title),
      description: jsonKey(blob, EMBEDDED_KEYS.description),
      price,
      mileage: digits(jsonKey(blob, EMBEDDED_KEYS.mileage, { numeric: true }) || jsonKey(blob, EMBEDDED_KEYS.mileage)),
      year: digits(jsonKey(blob, EMBEDDED_KEYS.year, { numeric: true })).slice(0, 4),
      make: jsonKey(blob, EMBEDDED_KEYS.make),
      model: jsonKey(blob, EMBEDDED_KEYS.model),
      damage: jsonKey(blob, EMBEDDED_KEYS.damage),
      damage2: jsonKey(blob, EMBEDDED_KEYS.damage2),
      titleType: jsonKey(blob, EMBEDDED_KEYS.titleType),
      runs: jsonKey(blob, EMBEDDED_KEYS.runs),
    };
  }

  // ── L4: semantic DOM ──────────────────────────────────────────────────────
  /* Only stable, meaning-carrying hooks: landmarks, headings, itemprop,
     data-testid. Deliberately no generated class names. */
  function layerDom() {
    const pick = (sels) => {
      for (const s of sels) {
        const v = txt(document.querySelector(s));
        if (v) return v;
      }
      return "";
    };
    return {
      title: pick(["h1", '[itemprop="name"]', '[data-testid*="title" i]', '[role="heading"][aria-level="1"]']),
      price: parseMoney(
        pick(['[itemprop="price"]', '[data-testid*="price" i]', '[class*="price" i]', '[id*="price" i]'])
      ),
      description: clip(
        pick(['[itemprop="description"]', '[data-testid*="description" i]', "#postingbody", "article"]),
        3000
      ),
    };
  }

  // ── L5: visible text ──────────────────────────────────────────────────────
  function visibleText(limit = 5000) {
    const root =
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|TEMPLATE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest("#lowballer-fab, nav, footer")) return NodeFilter.FILTER_REJECT;
        const t = node.textContent.trim();
        return t.length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const parts = [];
    let len = 0;
    let n;
    while ((n = walker.nextNode()) && len < limit) {
      const t = n.textContent.replace(/\s+/g, " ").trim();
      if (t && !parts.includes(t)) {
        parts.push(t);
        len += t.length;
      }
    }
    return parts.join(" · ").slice(0, limit);
  }

  function layerText() {
    const body = visibleText();
    // Largest-looking price on the page beats the first one (avoids "was $X" noise).
    const all = [...body.matchAll(/\$\s?([\d][\d,]{2,})/g)]
      .map((m) => parseInt(m[1].replace(/,/g, ""), 10))
      .filter((n) => Number.isFinite(n) && n >= 20 && n < 5_000_000);
    const bidMatch = body.match(/current bid[^$]{0,30}\$\s?([\d,]+)/i);
    return {
      description: body,
      price: bidMatch ? bidMatch[1].replace(/,/g, "") : all.length ? String(all[0]) : "",
      mileage: digits((body.match(/([\d,]{3,9})\s*(?:mi|miles|odometer)/i) || [])[1] || "").slice(0, 7),
    };
  }

  // ── merge ─────────────────────────────────────────────────────────────────
  const LAYER_ORDER = ["jsonld", "meta", "embedded", "dom", "text"];
  const LAYER_WEIGHT = { jsonld: 3, meta: 3, embedded: 2, dom: 1, text: 1 };

  function merge(layers) {
    const value = {};
    const source = {};
    for (const name of LAYER_ORDER) {
      const data = layers[name] || {};
      for (const [k, v] of Object.entries(data)) {
        if (v == null || v === "") continue;
        if (value[k] == null || value[k] === "") {
          value[k] = v;
          source[k] = name;
        } else if (k === "description" && String(v).length > String(value[k]).length * 2.5) {
          // A much richer description from a later layer is worth taking.
          value[k] = v;
          source[k] = name;
        }
      }
    }
    return { value, source };
  }

  /** high = title+price from stable layers; medium = one stable; low = text only. */
  function scoreConfidence(source, value) {
    if (!value.title && !value.description) return "none";
    const w = (k) => LAYER_WEIGHT[source[k]] || 0;
    const score = w("title") + w("price");
    if (score >= 4) return "high";
    if (score >= 2) return "medium";
    return "low";
  }

  // ── mode detection ────────────────────────────────────────────────────────
  function detectMode(value, host, path) {
    if (/copart\.com|iaai\.com/.test(host)) return "salvage";
    if (/craigslist\.org/.test(host) && /\/(cto|ctd|cta)\//.test(path)) return "car";
    if (value.damage || value.titleType) return "salvage";

    const blob = `${value.title || ""} ${value.description || ""}`.toLowerCase();
    const hasYear = /\b(19[89]\d|20[0-4]\d)\b/.test(value.title || "");
    const carWords =
      /(miles|mileage|odometer|sedan|coupe|suv|truck|awd|4x4|transmission|drivetrain|\bvin\b|clean title|salvage title|trim)/;
    const hits = (blob.match(carWords) || []).length;
    if ((hasYear && carWords.test(blob)) || hits >= 2) return "car";
    return "item";
  }

  function siteName(host) {
    if (host.includes("facebook.com")) return "Facebook Marketplace";
    if (host.includes("craigslist.org")) return "Craigslist";
    if (host.includes("ebay.com")) return "eBay";
    if (host.includes("offerup.com")) return "OfferUp";
    if (host.includes("copart.com")) return "Copart";
    if (host.includes("iaai.com")) return "IAAI";
    return host.replace(/^www\./, "");
  }

  // ── build payload ─────────────────────────────────────────────────────────
  function buildPayload() {
    const layers = {
      jsonld: attempt(layerJsonLd, {}),
      meta: attempt(layerMeta, {}),
      embedded: attempt(layerEmbedded, {}),
      dom: attempt(layerDom, {}),
      text: attempt(layerText, {}),
    };
    const { value, source } = merge(layers);
    const confidence = scoreConfidence(source, value);
    if (confidence === "none") return null;

    const host = location.hostname;
    const mode = detectMode(value, host, location.pathname);

    // Always ship the visible text too — it's the safety net that lets Claude
    // recover anything the structured layers missed.
    const rawText = layers.text?.description || "";

    return {
      v: PAYLOAD_VERSION,
      site: siteName(host),
      url: location.href.split("?")[0],
      mode,
      confidence,
      title: clip(value.title, 200),
      price: value.price || "",
      description: clip(value.description || rawText, 3000),
      rawText: clip(rawText, 2000),
      fields: {
        year: value.year || "",
        make: value.make || "",
        model: value.model || "",
        mileage: value.mileage || "",
        brand: value.brand || "",
        condition: value.condition || "",
        damage: [value.damage, value.damage2].filter(Boolean).join(", "),
        titleType: value.titleType || "",
        runs: value.runs || "",
      },
      // Which layer produced each field — surfaced in the popup so a site
      // redesign is visible immediately instead of failing silently.
      sources: source,
    };
  }

  // ── handoff ───────────────────────────────────────────────────────────────
  function encode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function openLowballer(payload) {
    const { baseUrl } = await chrome.storage.sync.get({ baseUrl: DEFAULT_BASE });
    // Fragment, not query string: fragments are never sent to the server, so the
    // listing text stays client-side until the user runs the appraisal.
    chrome.runtime.sendMessage({
      type: "OPEN_LOWBALLER",
      url: `${baseUrl}/#lb=${encode(payload)}`,
    });
  }

  async function lowball(btn) {
    const payload = buildPayload();
    if (!payload) {
      setState(btn, "error", "Couldn't read page");
      setTimeout(() => setState(btn, "idle"), 2400);
      return;
    }
    setState(btn, "busy", "Opening…");
    await openLowballer(payload);
    setTimeout(() => setState(btn, "idle"), 1200);
  }

  // ── floating button ───────────────────────────────────────────────────────
  function setState(btn, state, label) {
    btn.dataset.state = state;
    btn.querySelector(".lb-label").textContent =
      label || (state === "busy" ? "Opening…" : "Lowball this");
  }

  function mount() {
    if (document.getElementById("lowballer-fab")) return;
    const btn = document.createElement("button");
    btn.id = "lowballer-fab";
    btn.type = "button";
    btn.setAttribute("aria-label", "Appraise this listing with Lowballer");
    btn.innerHTML = '<span class="lb-dot"></span><span class="lb-label">Lowball this</span>';
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      lowball(btn);
    });
    document.body.appendChild(btn);
  }

  mount();

  // SPAs (Facebook, OfferUp) swap listings without a reload.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      mount();
    }
  }, 1200);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "GET_PAYLOAD") {
      sendResponse(attempt(buildPayload, null));
    } else if (msg?.type === "TRIGGER") {
      attempt(() => {
        const p = buildPayload();
        if (p) openLowballer(p);
      });
      sendResponse({ ok: true });
    }
    return true;
  });
})();
