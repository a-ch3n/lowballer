"use client";
import { useState, useEffect, useRef } from "react";

/*
  LOWBALLER.ORG — production build
  Modes: Car / Any item / Copart-Salvage
  Free tier: 3 anonymous appraisals (IP-metered, no email) → 3 more once signed in (account-metered) → Pro $30/mo via Stripe.
  Magic-link sign-in, no passwords — see /api/auth/* and lib/auth.js.
  All AI calls go through /api/appraise (Anthropic key stays server-side).
*/

const C = {
  bg: "#F7F6F2", surface: "#FFFFFF", ink: "#16181D", sub: "#6E7178",
  line: "#E4E2DB", accent: "#2245C7",
  green: "#1D6E3A", amber: "#B06E08", red: "#A8231C",
};
const mono = "'IBM Plex Mono','Courier New',monospace";
const fmt = (n) => (n == null || isNaN(n) ? "—" : "$" + Math.round(n).toLocaleString());

async function callAppraise({ content, useSearch = false, count = false, mode = "car" }) {
  const res = await fetch("/api/appraise", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, useSearch, count, mode }),
  });
  const data = await res.json();
  if (res.status === 401) throw Object.assign(new Error("auth"), { needsAuth: true });
  if (res.status === 402) throw Object.assign(new Error("limit"), { limit: true });
  if (res.status === 429) throw Object.assign(new Error(data.detail || "Too many requests — try again in a bit."), { rateLimited: true });
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data; // { json, remaining, pro }
}

const readFile = (file) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("Read failed"));
    r.readAsDataURL(file);
  });

const auctionFees = (bid) => {
  if (!bid) return 0;
  let pct;
  if (bid < 1000) pct = 0.19;
  else if (bid < 2500) pct = 0.14;
  else if (bid < 6000) pct = 0.11;
  else if (bid < 15000) pct = 0.09;
  else pct = 0.075;
  return bid * pct + 240;
};

const Label = ({ children }) => <div className="lbl">{children}</div>;
function Row({ l, v, bold, color }) {
  return (
    <div className="row" style={{ fontWeight: bold ? 600 : 400, color: color || C.ink }}>
      <div>{l}</div><div>{v}</div>
    </div>
  );
}
function ValueGrid({ cells }) {
  return (
    <div className="vgrid">
      {cells.map(([l, v]) => (
        <div key={l} className="vcell">
          <Label>{l}</Label>
          <div className="vnum">{fmt(v)}</div>
        </div>
      ))}
    </div>
  );
}
function CompList({ comps }) {
  if (!Array.isArray(comps) || !comps.length) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <Label>Comparable listings</Label>
      {comps.map((c, i) => (
        <div key={i} className="comp">
          <div style={{ minWidth: 0 }}>
            <span style={{ fontFamily: mono, fontSize: 12, color: C.accent }}>{c.source}</span>
            <span style={{ color: C.sub }}> — {c.desc}</span>
          </div>
          <div style={{ fontFamily: mono, fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(c.price)}</div>
        </div>
      ))}
    </div>
  );
}
function RepairList({ repairs }) {
  if (!repairs) return null;
  return (
    <>
      {Array.isArray(repairs.items) && repairs.items.map((r, i) => (
        <div key={i} className="comp">
          <div>
            {r.item}
            {r.likely && <span className={`pill ${r.likely === "reported" ? "pill-red" : ""}`}>{r.likely === "reported" ? "listed" : "typical"}</span>}
            <span style={{ color: C.sub, fontSize: 12 }}> · parts {fmt(r.parts)} · labor {fmt(r.labor)}</span>
          </div>
          <div style={{ fontFamily: mono, fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(r.total)}</div>
        </div>
      ))}
      <div className="row" style={{ marginTop: 12, fontFamily: mono, fontWeight: 600 }}>
        <div>Total range</div>
        <div>{fmt(repairs.total_low)} – {fmt(repairs.total_high)}</div>
      </div>
      {repairs.notes && <div className="note">{repairs.notes}</div>}
    </>
  );
}

export default function Lowballer() {
  const [remaining, setRemaining] = useState(null);
  const [freeLimit, setFreeLimit] = useState(3);
  const [pro, setPro] = useState(false);
  const [email, setEmail] = useState(null);
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInSent, setSignInSent] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const toolRef = useRef(null);
  const priceRef = useRef(null);

  async function refreshMe() {
    try {
      const r = await fetch("/api/me");
      const d = await r.json();
      setRemaining(d.remaining);
      setPro(d.pro);
      setEmail(d.email || null);
      if (d.freeLimit) setFreeLimit(d.freeLimit);
    } catch {}
    setAccountLoaded(true);
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    const authParam = params.get("auth");
    if (authParam) {
      setAuthNotice(authParam === "ok" ? "Signed in." : "That sign-in link is invalid or expired — try again.");
      window.history.replaceState({}, "", "/");
    }
    if (sessionId) {
      fetch(`/api/checkout/verify?session_id=${encodeURIComponent(sessionId)}`)
        .then(() => {
          window.history.replaceState({}, "", "/");
          refreshMe();
        })
        .catch(refreshMe);
    } else {
      refreshMe();
    }
  }, []);

  const locked = accountLoaded && !pro && remaining === 0;

  async function startCheckout() {
    setCheckoutBusy(true);
    try {
      const r = await fetch("/api/checkout", { method: "POST" });
      if (r.status === 401) { setCheckoutBusy(false); setShowSignIn(true); return; }
      const d = await r.json();
      if (d.url) window.location.href = d.url;
      else alert(d.error || "Checkout unavailable — check Stripe configuration.");
    } catch {
      alert("Checkout failed to start.");
    }
    setCheckoutBusy(false);
  }

  async function sendSignInLink() {
    setSignInBusy(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: signInEmail.trim() }),
      });
      const d = await r.json();
      if (r.ok) setSignInSent(true);
      else alert(d.detail || d.error || "Couldn't send the link — try again.");
    } catch {
      alert("Couldn't send the link — try again.");
    }
    setSignInBusy(false);
  }

  async function signOut() {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
    setEmail(null); setPro(false); setRemaining(null); setAuthNotice("");
    refreshMe();
  }

  function closeSignIn() {
    setShowSignIn(false);
    setSignInSent(false);
    setSignInEmail("");
  }

  const [mode, setMode] = useState("car");
  const [pasted, setPasted] = useState("");
  const [images, setImages] = useState([]);
  const [extracting, setExtracting] = useState(false);
  const [extractNote, setExtractNote] = useState("");

  const [car, setCar] = useState({ year: "", make: "", model: "", trim: "", mileage: "", asking: "", location: "", seller: "private", issues: "", desc: "" });
  const [item, setItem] = useState({ name: "", brand: "", condition: "used - good", asking: "", issues: "", desc: "" });
  const [sal, setSal] = useState({ year: "", make: "", model: "", trim: "", mileage: "", damage: "", runs: "run and drive", title: "salvage certificate", bid: "", towing: "300", desc: "" });

  const [phase, setPhase] = useState("idle");
  const [market, setMarket] = useState(null);
  const [repairs, setRepairs] = useState(null);
  const [flip, setFlip] = useState(null);
  const [salMarket, setSalMarket] = useState(null);
  const [salRepairs, setSalRepairs] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [fromExt, setFromExt] = useState(null);

  // ---- Extension handoff ----
  // The browser extension opens us at /#lb=<base64url json>. Fragments never
  // reach the server, so listing text stays client-side until the user runs
  // the appraisal from their own session.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#lb=")) return;
    try {
      const b64 = hash.slice(4).replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const p = JSON.parse(new TextDecoder().decode(bytes));
      window.history.replaceState({}, "", "/");
      if (!p || !(p.v === 1 || p.v === 2)) return;

      const m = ["car", "item", "salvage"].includes(p.mode) ? p.mode : "car";
      const f = p.fields || {};
      setMode(m);

      // Always hand Claude the text too — it fills whatever the extension's
      // structured layers missed.
      const blob = [p.title, p.description, p.rawText !== p.description ? p.rawText : ""]
        .filter(Boolean).join("\n");
      setPasted(blob.slice(0, 3000));

      if (m === "car") {
        setCar((c) => ({
          ...c,
          year: f.year || c.year,
          make: f.make || c.make,
          model: f.model || c.model,
          mileage: f.mileage || c.mileage,
          asking: p.price || c.asking,
        }));
      } else if (m === "item") {
        setItem((c) => ({
          ...c,
          name: p.title || c.name,
          brand: f.brand || c.brand,
          asking: p.price || c.asking,
        }));
      } else {
        setSal((c) => ({
          ...c,
          year: f.year || c.year,
          make: f.make || c.make,
          model: f.model || c.model,
          mileage: f.mileage || c.mileage,
          bid: p.price || c.bid,
          damage: f.damage || c.damage,
          title: /rebuilt/i.test(f.titleType) ? "rebuilt title"
            : /clean/i.test(f.titleType) ? "clean title"
            : /destruct/i.test(f.titleType) ? "certificate of destruction"
            : c.title,
          runs: /run and drive|runs and drives/i.test(f.runs) ? "run and drive"
            : /start/i.test(f.runs) ? "starts"
            : c.runs,
        }));
      }

      setFromExt({ site: p.site, title: p.title, confidence: p.confidence || "low" });
      setTimeout(() => toolRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
    } catch (e) {
      console.error("Bad extension payload", e);
    }
  }, []);

  const setC = (k) => (e) => setCar((c) => ({ ...c, [k]: e.target.value }));
  const setI = (k) => (e) => setItem((c) => ({ ...c, [k]: e.target.value }));
  const setSa = (k) => (e) => setSal((c) => ({ ...c, [k]: e.target.value }));
  const busy = phase === "market" || phase === "repairs";
  const ready =
    mode === "car" ? car.year && car.make && car.model && car.asking
    : mode === "item" ? item.name && item.asking
    : sal.year && sal.make && sal.model && sal.bid;

  const carStr = () =>
    `${car.year} ${car.make} ${car.model} ${car.trim}`.trim() +
    (car.mileage ? `, ${Number(car.mileage).toLocaleString()} miles` : "") +
    (car.location ? `, near ${car.location}` : "");
  const itemStr = () => `${item.brand} ${item.name}`.trim() + `, condition: ${item.condition}` + (item.issues ? `, issues: ${item.issues.slice(0, 200)}` : "");
  const salStr = () =>
    `${sal.year} ${sal.make} ${sal.model} ${sal.trim}`.trim() +
    (sal.mileage ? `, ${Number(sal.mileage).toLocaleString()} miles` : "") +
    `, ${sal.runs}, ${sal.title}` + (sal.damage ? `, damage: ${sal.damage.slice(0, 300)}` : "");

  function resetResults() {
    setMarket(null); setRepairs(null); setFlip(null);
    setSalMarket(null); setSalRepairs(null);
    setError(""); setPhase("idle");
  }

  async function onFiles(e) {
    const files = Array.from(e.target.files || []).slice(0, 3);
    const out = [];
    for (const f of files) { try { out.push({ data: await readFile(f), type: f.type, name: f.name }); } catch {} }
    setImages(out);
  }

  function handleLimit() {
    setShowPaywall(true);
    setRemaining(0);
    setPhase("idle");
  }

  function handleAuthRequired() {
    setShowSignIn(true);
    setPhase("idle");
  }

  async function extract() {
    setExtracting(true); setExtractNote("");
    try {
      const schema =
        mode === "car"
          ? `Respond ONLY with compact JSON, no markdown: {"year":string,"make":string,"model":string,"trim":string,"mileage":string,"asking":string,"location":string,"seller":"private"|"dealer","issues":string,"desc":string,"error":string}. "" for unknown. Only set "error" if listing details truly could not be obtained.`
          : mode === "item"
          ? `Respond ONLY with compact JSON, no markdown: {"name":string,"brand":string,"condition":string,"asking":string,"issues":string,"desc":string,"error":string}. "name"=specific product incl model number if visible. "" for unknown. Only set "error" if listing details truly could not be obtained.`
          : `Respond ONLY with compact JSON, no markdown: {"year":string,"make":string,"model":string,"trim":string,"mileage":string,"damage":string,"runs":string,"title":string,"bid":string,"desc":string,"error":string}. "" for unknown. Only set "error" if lot details truly could not be obtained.`;

      let content;
      const kind = mode === "salvage" ? "Copart/IAAI salvage auction lot" : mode === "car" ? "used-car listing" : "marketplace listing";

      if (images.length > 0) {
        content = [
          ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } })),
          { type: "text", text: `These are screenshots of a ${kind}.` + (pasted ? ` Pasted text: "${pasted.slice(0, 800)}"` : "") + ` Extract the details. ${schema}` },
        ];
      } else if (pasted.trim()) {
        content = `Text of a ${kind}: "${pasted.slice(0, 1200)}". Extract the details. ${schema}`;
      } else {
        setExtractNote("Paste the listing text or upload a screenshot first.");
        setExtracting(false); return;
      }

      const { json: j } = await callAppraise({ content, useSearch: false, count: false });
      if (j.error) {
        setExtractNote("Couldn't read that — try a clearer screenshot or paste more of the listing text.");
      } else if (mode === "car") {
        setCar((c) => ({
          ...c, year: j.year || c.year, make: j.make || c.make, model: j.model || c.model, trim: j.trim || c.trim,
          mileage: String(j.mileage || c.mileage).replace(/[^0-9]/g, ""),
          asking: String(j.asking || c.asking).replace(/[^0-9]/g, ""),
          location: j.location || c.location,
          seller: j.seller === "dealer" ? "dealer" : "private",
          issues: [c.issues, j.issues].filter(Boolean).join("; "),
          desc: j.desc || "",
        }));
        setExtractNote("Details extracted — review, then run the appraisal.");
      } else if (mode === "item") {
        setItem((c) => ({
          ...c, name: j.name || c.name, brand: j.brand || c.brand, condition: j.condition || c.condition,
          asking: String(j.asking || c.asking).replace(/[^0-9]/g, ""),
          issues: [c.issues, j.issues].filter(Boolean).join("; "),
          desc: j.desc || "",
        }));
        setExtractNote("Details extracted — review, then run the appraisal.");
      } else {
        setSal((c) => ({
          ...c, year: j.year || c.year, make: j.make || c.make, model: j.model || c.model, trim: j.trim || c.trim,
          mileage: String(j.mileage || c.mileage).replace(/[^0-9]/g, ""),
          damage: j.damage || c.damage, runs: j.runs || c.runs, title: j.title || c.title,
          bid: String(j.bid || c.bid).replace(/[^0-9]/g, ""),
          desc: j.desc || "",
        }));
        setExtractNote("Lot details extracted — review, then run the flip check.");
      }
    } catch (e) {
      if (e.limit) { handleLimit(); setExtracting(false); return; }
      if (e.rateLimited) { setExtractNote(e.message); setExtracting(false); return; }
      console.error(e);
      setExtractNote("Extraction failed — try a clearer screenshot or paste the text.");
    }
    setExtracting(false);
  }

  async function analyzeCar() {
    resetResults();
    try {
      setPhase("market");
      const m = await callAppraise({
        content:
          `You are a used-car pricing analyst. Use web search to research current market pricing for: ${carStr()}. Seller type: ${car.seller}.` +
          (car.desc ? ` Listing summary: "${car.desc}"` : "") +
          ` Search (1) comparable current listings on AutoTrader, Cars.com, CarGurus, Craigslist and similar, and (2) typical KBB/Edmunds market value. Respond ONLY with compact JSON, no markdown: {"fair_low":number,"fair_mid":number,"fair_high":number,"dealer_retail":number,"comps":[{"source":string,"desc":string,"price":number}],"notes":string}. USD, up to 5 comps, notes under 40 words.`,
        useSearch: true, count: false,
      });
      setMarket(m.json);
      setPhase("repairs");
      const r = await callAppraise({
        content:
          `You are an auto repair estimator. Vehicle: ${carStr()}.` +
          (car.issues ? ` Reported issues: "${car.issues.slice(0, 400)}".` : "") +
          ` List repairs/maintenance this car likely needs — reported issues AND common problem areas for this model/mileage. Use web search to price parts and labor. Respond ONLY with compact JSON, no markdown: {"items":[{"item":string,"parts":number,"labor":number,"total":number,"likely":"reported"|"typical"}],"total_low":number,"total_high":number,"notes":string}. USD, max 6 items, notes under 40 words.`,
        useSearch: true, count: true, mode: "car",
      });
      setRepairs(r.json);
      if (r.remaining != null) setRemaining(r.remaining);
      setPro(r.pro);
      setPhase("done");
    } catch (e) {
      if (e.needsAuth) return handleAuthRequired();
      if (e.limit) return handleLimit();
      if (e.rateLimited) { setError(e.message); setPhase("error"); return; }
      console.error(e);
      setError("Analysis failed mid-search. Run it again — it didn't count against your uses.");
      setPhase("error");
    }
  }

  async function analyzeItem() {
    resetResults();
    try {
      setPhase("market");
      const f = await callAppraise({
        content:
          `You are a resale pricing analyst. Item: ${itemStr()}.` +
          (item.desc ? ` Listing summary: "${item.desc.slice(0, 300)}"` : "") +
          ` Use web search to find: (1) eBay SOLD/completed prices for this exact item in this condition, (2) current eBay active prices, (3) typical Facebook Marketplace/OfferUp prices, (4) retail new price. Estimate typical shipping. Respond ONLY with compact JSON, no markdown: {"ebay_sold_low":number,"ebay_sold_mid":number,"ebay_sold_high":number,"ebay_active_avg":number,"fb_typical":number,"retail_new":number,"ship_est":number,"comps":[{"source":string,"desc":string,"price":number}],"notes":string}. USD, up to 5 comps, notes under 40 words.`,
        useSearch: true, count: true, mode: "item",
      });
      setFlip(f.json);
      if (f.remaining != null) setRemaining(f.remaining);
      setPro(f.pro);
      setPhase("done");
    } catch (e) {
      if (e.needsAuth) return handleAuthRequired();
      if (e.limit) return handleLimit();
      if (e.rateLimited) { setError(e.message); setPhase("error"); return; }
      console.error(e);
      setError("Analysis failed mid-search. Run it again — it didn't count against your uses.");
      setPhase("error");
    }
  }

  async function analyzeSalvage() {
    resetResults();
    try {
      setPhase("market");
      const m = await callAppraise({
        content:
          `You are a salvage-vehicle flip analyst. Lot: ${salStr()}.` +
          (sal.desc ? ` Lot summary: "${sal.desc.slice(0, 300)}"` : "") +
          ` Use web search to find: (1) clean-title private-party value for this year/model/mileage, (2) realistic REBUILT-title resale value (typically 20-40% below clean — find actual rebuilt-title listings of this model if possible), (3) recent Copart/IAAI sold prices for similar damaged lots if findable. Respond ONLY with compact JSON, no markdown: {"clean_value":number,"rebuilt_resale":number,"salvage_comps_avg":number,"comps":[{"source":string,"desc":string,"price":number}],"notes":string}. USD, up to 5 comps, notes under 40 words.`,
        useSearch: true, count: false,
      });
      setSalMarket(m.json);
      setPhase("repairs");
      const r = await callAppraise({
        content:
          `You are a collision/salvage repair estimator for a budget-minded flipper. Vehicle: ${salStr()}.` +
          ` List parts and repairs needed to make it road-worthy and sellable with a rebuilt title. Price parts as USED/aftermarket (LKQ, car-part.com, eBay) where sensible, with modest independent-shop or DIY labor. Include likely hidden-damage items for this damage type. Use web search to price parts for this model. Respond ONLY with compact JSON, no markdown: {"items":[{"item":string,"parts":number,"labor":number,"total":number,"likely":"reported"|"typical"}],"total_low":number,"total_high":number,"notes":string}. USD, max 6 items, notes under 40 words.`,
        useSearch: true, count: true, mode: "salvage",
      });
      setSalRepairs(r.json);
      if (r.remaining != null) setRemaining(r.remaining);
      setPro(r.pro);
      setPhase("done");
    } catch (e) {
      if (e.needsAuth) return handleAuthRequired();
      if (e.limit) return handleLimit();
      if (e.rateLimited) { setError(e.message); setPhase("error"); return; }
      console.error(e);
      setError("Analysis failed mid-search. Run it again — it didn't count against your uses.");
      setPhase("error");
    }
  }

  // math
  const askingCar = Number(car.asking) || 0;
  const repairMid = repairs ? ((Number(repairs.total_low) || 0) + (Number(repairs.total_high) || 0)) / 2 : 0;
  const baseValue = market
    ? car.seller === "dealer" ? Number(market.dealer_retail) || Number(market.fair_high) : Number(market.fair_mid)
    : null;
  const adjusted = baseValue != null ? baseValue - repairMid : null;
  const marginCar = adjusted != null ? adjusted - askingCar : null;
  const pctCar = adjusted ? marginCar / adjusted : null;

  const askingItem = Number(item.asking) || 0;
  let flipCalc = null;
  if (flip) {
    const sold = Number(flip.ebay_sold_mid) || 0;
    const ship = Number(flip.ship_est) || 0;
    const ebayNet = sold * 0.865 - ship;
    const fbNet = Number(flip.fb_typical) || sold * 0.85;
    const bestNet = Math.max(ebayNet, fbNet);
    flipCalc = {
      ebayNet, fbNet, bestNet,
      bestChannel: ebayNet >= fbNet ? "eBay (shipped)" : "Facebook Marketplace (local)",
      profitAtAsking: bestNet - askingItem,
      roiAtAsking: askingItem ? (bestNet - askingItem) / askingItem : null,
    };
  }

  const bid = Number(sal.bid) || 0;
  const towing = Number(sal.towing) || 0;
  let salCalc = null;
  if (salMarket && salRepairs) {
    const resale = Number(salMarket.rebuilt_resale) || (Number(salMarket.clean_value) || 0) * 0.7;
    const repMid = ((Number(salRepairs.total_low) || 0) + (Number(salRepairs.total_high) || 0)) / 2;
    const buffer = repMid * 0.15;
    const fees = auctionFees(bid);
    const titleCosts = 350;
    const totalIn = bid + fees + towing + repMid + buffer + titleCosts;
    const profit = resale - totalIn;
    const targetProfit = Math.max(1500, resale * 0.15);
    const roomBeforeFees = resale - targetProfit - 240 - towing - repMid - buffer - titleCosts;
    const maxBid = Math.max(0, roomBeforeFees / 1.11);
    salCalc = { resale, repMid, buffer, fees, titleCosts, totalIn, profit, roi: totalIn ? profit / totalIn : null, targetProfit, maxBid };
  }

  // verdicts
  let verdict = null;
  if (mode === "car" && pctCar != null) {
    if (pctCar >= 0.08) verdict = { label: "Good deal", color: C.green, note: "Priced meaningfully below adjusted market value." };
    else if (pctCar >= -0.05) verdict = { label: "Fair price", color: C.amber, note: "Within normal range — negotiate on the flaws." };
    else verdict = { label: "Overpriced", color: C.red, note: "Asking exceeds adjusted value. Counter hard or walk." };
  }
  if (mode === "item" && flipCalc) {
    const roi = flipCalc.roiAtAsking;
    if (roi != null && roi >= 0.5) verdict = { label: "Flip it", color: C.green, note: `Strong margin at asking via ${flipCalc.bestChannel}.` };
    else if (roi != null && roi >= 0.15) verdict = { label: "Thin flip", color: C.amber, note: "Profitable only if you negotiate down or sell at the high end." };
    else verdict = { label: "Pass / lowball", color: C.red, note: "No real margin at asking. Only worth it well below ask." };
  }
  if (mode === "salvage" && salCalc) {
    if (bid <= salCalc.maxBid && salCalc.profit >= salCalc.targetProfit)
      verdict = { label: "Worth flipping", color: C.green, note: `Current bid is under your max bid of ${fmt(salCalc.maxBid)}.` };
    else if (salCalc.profit > 0)
      verdict = { label: "Thin flip", color: C.amber, note: `Profit exists but below target. Don't bid past ${fmt(salCalc.maxBid)}.` };
    else
      verdict = { label: "Walk away", color: C.red, note: "All-in cost exceeds realistic rebuilt-title resale at this bid." };
  }

  const offer =
    mode === "car" && adjusted != null
      ? { open: Math.min(adjusted * 0.85, askingCar * 0.9), target: Math.min(adjusted * 0.93, askingCar), walk: Math.min(adjusted * 0.99, askingCar) }
      : mode === "item" && flipCalc
      ? { open: flipCalc.bestNet * 0.55, target: flipCalc.bestNet * 0.65, walk: flipCalc.bestNet * 0.75 }
      : null;

  const reportedItems = (repairs?.items || []).filter((i) => i.likely === "reported");
  const leverage = reportedItems.length ? reportedItems : repairs?.items || [];

  const offerMessage =
    offer &&
    (mode === "car"
      ? `Hi! Is the ${car.year} ${car.make} ${car.model} still available? I'm a serious buyer with cash. Based on what similar ones are going for${leverage.length ? ` and the work it needs (${leverage.slice(0, 3).map((i) => i.item.toLowerCase()).join(", ")} — roughly ${fmt(repairMid)})` : ""}, I can offer ${fmt(offer.open)}. I can pick it up this week.`
      : `Hi! Is the ${[item.brand, item.name].filter(Boolean).join(" ")} still available? I can pick it up today with cash. Similar ones in ${item.condition} condition are selling for about ${fmt(flip?.ebay_sold_mid)} — would you take ${fmt(offer.open)}?`);

  async function copyOffer() {
    try {
      await navigator.clipboard.writeText(offerMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  const runLabel =
    phase === "market"
      ? mode === "item" ? "Searching eBay sold prices…" : mode === "salvage" ? "Valuing clean + rebuilt…" : "Searching market listings…"
      : phase === "repairs" ? "Pricing repair parts…"
      : mode === "salvage" ? "Run flip check" : "Run appraisal";

  const scrollTo = (ref) => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "'Inter',system-ui,sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: `
        * { box-sizing: border-box; }
        .lbl { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: ${C.sub}; margin-bottom: 5px; font-weight: 600; }
        .row { display: flex; justify-content: space-between; font-family: ${mono}; font-size: 14px; padding: 3px 0; }
        .note { margin-top: 10px; font-size: 13px; color: ${C.sub}; }
        .hair { border-top: 1px solid ${C.line}; }
        .lift, .vcell, .comp, .tab, .card, .plan, .feat { transition: transform .22s cubic-bezier(.2,.7,.3,1), box-shadow .22s, background .22s, border-color .22s, color .22s; }
        .lift:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(22,24,29,.14); }
        .lift:active:not(:disabled) { transform: translateY(0); box-shadow: 0 2px 6px rgba(22,24,29,.12); }
        .card:hover { box-shadow: 0 16px 44px rgba(22,24,29,.10); }
        .vcell:hover { transform: translateY(-3px); border-color: ${C.accent}; box-shadow: 0 10px 24px rgba(34,69,199,.10); }
        .vcell:hover .vnum { color: ${C.accent}; }
        .comp:hover { background: #FAFAF7; transform: translateX(4px); }
        .feat:hover { transform: translateY(-4px); box-shadow: 0 12px 28px rgba(22,24,29,.10); border-color: ${C.accent}; }
        .plan:hover { transform: translateY(-4px); box-shadow: 0 16px 36px rgba(22,24,29,.12); }
        .btn { border: none; cursor: pointer; font-weight: 600; font-family: 'Inter',sans-serif; }
        .btn:disabled { cursor: not-allowed; opacity: .5; }
        .btn-primary { background: ${C.ink}; color: #fff; padding: 13px 26px; border-radius: 999px; font-size: 15px; }
        .btn-accent { background: ${C.accent}; color: #fff; padding: 13px 26px; border-radius: 999px; font-size: 15px; }
        .btn-ghost { background: transparent; color: ${C.ink}; border: 1px solid ${C.line}; padding: 11px 22px; border-radius: 999px; font-size: 14px; }
        .btn-ghost:hover { border-color: ${C.ink}; }
        .btn-block { width: 100%; }
        .cta-arrow { display: inline-block; transition: transform .22s; margin-left: 8px; }
        .btn:hover .cta-arrow { transform: translateX(5px); }
        .in { width: 100%; background: transparent; border: none; border-bottom: 1.5px solid ${C.line}; padding: 9px 2px; font-family: ${mono}; font-size: 14px; color: ${C.ink}; outline: none; transition: border-color .2s; border-radius: 0; }
        .in:hover { border-color: #C9C6BD; }
        .in:focus { border-color: ${C.accent}; }
        textarea.in { resize: vertical; min-height: 52px; border: 1.5px solid ${C.line}; padding: 9px 10px; border-radius: 8px; }
        textarea.in:focus { border-color: ${C.accent}; }
        select.in { border: 1.5px solid ${C.line}; padding: 9px 8px; border-radius: 8px; height: 41px; background: #fff; }
        .tab { flex: 1; background: transparent; border: none; padding: 14px 4px; font-size: 13px; font-weight: 600; letter-spacing: .04em; color: ${C.sub}; cursor: pointer; position: relative; }
        .tab::after { content: ""; position: absolute; left: 20%; right: 20%; bottom: 0; height: 2px; background: ${C.accent}; transform: scaleX(0); transition: transform .25s cubic-bezier(.2,.7,.3,1); }
        .tab:hover { color: ${C.ink}; }
        .tab:hover::after { transform: scaleX(.5); }
        .tab.on { color: ${C.ink}; }
        .tab.on::after { transform: scaleX(1); }
        .vgrid { display: grid; grid-template-columns: repeat(2,1fr); gap: 10px; }
        .vcell { background: #fff; border: 1px solid ${C.line}; border-radius: 10px; padding: 12px 14px; }
        .vnum { font-family: ${mono}; font-weight: 600; font-size: 19px; transition: color .2s; }
        .comp { display: flex; justify-content: space-between; gap: 10px; padding: 9px 6px; border-bottom: 1px solid ${C.line}; font-size: 13px; border-radius: 6px; }
        .pill { font-family: ${mono}; font-size: 10px; margin-left: 6px; padding: 1px 6px; border: 1px solid ${C.line}; border-radius: 999px; color: ${C.sub}; text-transform: uppercase; }
        .pill-red { border-color: ${C.red}; color: ${C.red}; }
        .card { background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 16px; box-shadow: 0 8px 30px rgba(22,24,29,.06); }
        .feat { background: #fff; border: 1px solid ${C.line}; border-radius: 12px; padding: 16px 14px; text-align: left; }
        .plan { background: #fff; border: 1px solid ${C.line}; border-radius: 16px; padding: 24px; }
        .plan.pro { background: ${C.ink}; color: #fff; border-color: ${C.ink}; }
        input:focus-visible, button:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; scroll-behavior: auto !important; } .lift:hover, .vcell:hover, .comp:hover, .feat:hover, .plan:hover { transform: none; } }
      ` }} />

      {/* NAV */}
      <nav style={{ position: "sticky", top: 0, zIndex: 20, background: "rgba(247,246,242,.85)", backdropFilter: "blur(10px)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${C.line}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 17, letterSpacing: "-0.01em" }}>
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill={C.ink} />
            <path d="M9 5H23V15L16 27L9 15Z" fill={C.accent} />
            <circle cx="16" cy="10" r="1.8" fill={C.ink} />
          </svg>
          <span>lowballer<span style={{ color: C.accent }}>.org</span></span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {!accountLoaded ? (
            <div style={{ fontFamily: mono, fontSize: 11, color: C.sub }}>…</div>
          ) : email ? (
            <>
              <div style={{ fontFamily: mono, fontSize: 11, color: pro ? C.green : C.sub, border: `1px solid ${C.line}`, borderRadius: 999, padding: "4px 10px", background: "#fff" }}>
                {pro ? "pro · unlimited" : `${remaining} free left`}
              </div>
              <span style={{ fontSize: 12, color: C.sub, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>
              <button className="btn btn-ghost lift" style={{ padding: "6px 12px", fontSize: 12 }} onClick={signOut}>Sign out</button>
              {!pro && (
                <button className="btn btn-accent lift" style={{ padding: "8px 16px", fontSize: 13 }} onClick={() => scrollTo(priceRef)}>
                  Go Pro
                </button>
              )}
            </>
          ) : (
            <button className="btn btn-accent lift" style={{ padding: "8px 16px", fontSize: 13 }} onClick={() => setShowSignIn(true)}>
              Sign in
            </button>
          )}
        </div>
      </nav>

      {authNotice && (
        <div style={{ textAlign: "center", fontSize: 13, padding: "10px 20px", background: authNotice.startsWith("Signed in") ? "#ECF7F0" : "#FDF4E3", color: authNotice.startsWith("Signed in") ? C.green : C.amber, borderBottom: `1px solid ${C.line}` }}>
          {authNotice}
          <button onClick={() => setAuthNotice("")} style={{ marginLeft: 10, background: "none", border: "none", color: "inherit", textDecoration: "underline", cursor: "pointer", font: "inherit" }}>dismiss</button>
        </div>
      )}

      {/* HERO */}
      <header style={{ maxWidth: 680, margin: "0 auto", padding: "64px 20px 40px", textAlign: "center" }}>
        <div style={{ fontFamily: mono, fontSize: 12, color: C.accent, letterSpacing: ".06em" }}>powered by Claude AI + live web search</div>
        <h1 style={{ fontWeight: 700, fontSize: 40, lineHeight: 1.12, letterSpacing: "-0.02em", margin: "14px 0 14px" }}>
          Know your number before you make the offer.
        </h1>
        <p style={{ fontSize: 16, lineHeight: 1.6, color: C.sub, maxWidth: 520, margin: "0 auto" }}>
          Screenshot any Facebook Marketplace listing or Copart lot. Lowballer pulls live comps, prices the repairs, and hands you the exact lowball offer — or max bid — to make.
        </p>
        <button className="btn btn-primary lift" style={{ marginTop: 22 }} onClick={() => scrollTo(toolRef)}>
          Appraise a listing — free<span className="cta-arrow">→</span>
        </button>
        <div style={{ marginTop: 34, display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, maxWidth: 560, marginLeft: "auto", marginRight: "auto" }}>
          {[["Cars", "Market value − repairs = your offer"], ["Any item", "eBay sold comps → flip profit"], ["Copart lots", "Rebuild cost → your max bid"]].map(([t, d]) => (
            <div key={t} className="feat">
              <div style={{ fontWeight: 600, fontSize: 14 }}>{t}</div>
              <div style={{ fontSize: 12, color: C.sub, marginTop: 5, lineHeight: 1.45 }}>{d}</div>
            </div>
          ))}
        </div>
      </header>

      {/* TOOL */}
      <main ref={toolRef} style={{ maxWidth: 680, margin: "0 auto", padding: "0 16px 48px" }}>
        <div className="card" style={{ position: "relative", overflow: "hidden" }}>
          {locked && (
            <div style={{ position: "absolute", inset: 0, zIndex: 10, background: "rgba(255,255,255,.93)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
              <div style={{ textAlign: "center", maxWidth: 360 }}>
                {email ? (
                  <>
                    <div style={{ fontWeight: 700, fontSize: 24 }}>Free appraisals used</div>
                    <p style={{ fontSize: 14, color: C.sub, margin: "10px 0 16px" }}>You've run your {freeLimit} free appraisals. Go Pro for unlimited across all three modes.</p>
                    <button className="btn btn-accent btn-block lift" onClick={() => setShowPaywall(true)}>Unlock unlimited</button>
                  </>
                ) : (
                  <>
                    <div style={{ fontWeight: 700, fontSize: 24 }}>Free tries used</div>
                    <p style={{ fontSize: 14, color: C.sub, margin: "10px 0 16px" }}>You've used your {freeLimit} free tries. Sign in with your email for {freeLimit} more, free.</p>
                    <button className="btn btn-accent btn-block lift" onClick={() => setShowSignIn(true)}>Sign in to continue</button>
                  </>
                )}
              </div>
            </div>
          )}

          <div style={{ display: "flex", borderBottom: `1px solid ${C.line}` }}>
            {[["car", "Car"], ["item", "Any item"], ["salvage", "Copart / Salvage"]].map(([m, label]) => (
              <button key={m} className={`tab ${mode === m ? "on" : ""}`} onClick={() => { setMode(m); resetResults(); setExtractNote(""); }}>
                {label}
              </button>
            ))}
          </div>

          <div style={{ padding: "22px 22px 24px" }}>
            {fromExt && (
              <div style={{
                marginBottom: 16, padding: "10px 14px", borderRadius: 10, fontSize: 13,
                background: fromExt.confidence === "high" ? "#ECF7F0" : fromExt.confidence === "medium" ? "#FDF4E3" : "#EEF2FF",
                border: `1px solid ${fromExt.confidence === "high" ? "#1D6E3A33" : fromExt.confidence === "medium" ? "#B06E0833" : C.accent + "33"}`,
              }}>
                <strong>Imported from {fromExt.site}</strong>
                {fromExt.title ? ` — ${fromExt.title.slice(0, 70)}` : ""}
                <div style={{ marginTop: 4, color: C.sub }}>
                  {fromExt.confidence === "high"
                    ? "Fields filled from the listing's structured data. Run the appraisal when ready."
                    : fromExt.confidence === "medium"
                    ? "Some fields came from page text — give them a quick check before running."
                    : "Structured data wasn't available, so the listing text came through instead. Hit “Pull details from listing” to have Claude fill the fields."}
                </div>
              </div>
            )}
            <Label>1 · The listing</Label>
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
              <label className="btn btn-ghost lift" style={{ display: "inline-block" }}>
                {images.length ? `${images.length} screenshot${images.length > 1 ? "s" : ""} ✓` : "Upload screenshot(s)"}
                <input type="file" accept="image/*" multiple onChange={onFiles} style={{ display: "none" }} />
              </label>
              <span style={{ fontSize: 12, color: C.sub }}>Works for any listing, including Facebook Marketplace.</span>
            </div>
            <div style={{ marginTop: 14 }}>
              <textarea className="in" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="…or paste the listing text here" />
            </div>
            <button className="btn btn-primary btn-block lift" style={{ marginTop: 14, borderRadius: 10 }} onClick={extract} disabled={extracting}>
              {extracting ? "Reading listing…" : "Pull details from listing"}
            </button>
            {extractNote && <div className="note">{extractNote}</div>}
          </div>
          <div className="hair" />

          <div style={{ padding: "22px 22px 26px" }}>
            <Label>{mode === "car" ? "2 · The car" : mode === "item" ? "2 · The item" : "2 · The lot"}</Label>

            {mode === "car" && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px", marginTop: 10 }}>
                  <input className="in" value={car.year} onChange={setC("year")} placeholder="Year *" inputMode="numeric" />
                  <input className="in" value={car.make} onChange={setC("make")} placeholder="Make *" />
                  <input className="in" value={car.model} onChange={setC("model")} placeholder="Model *" />
                  <input className="in" value={car.trim} onChange={setC("trim")} placeholder="Trim" />
                  <input className="in" value={car.mileage} onChange={setC("mileage")} placeholder="Mileage" inputMode="numeric" />
                  <input className="in" value={car.asking} onChange={setC("asking")} placeholder="Asking price *" inputMode="numeric" />
                  <input className="in" value={car.location} onChange={setC("location")} placeholder="Location" />
                  <select className="in" value={car.seller} onChange={setC("seller")}>
                    <option value="private">Private party</option>
                    <option value="dealer">Dealership</option>
                  </select>
                </div>
                <div style={{ marginTop: 14 }}>
                  <textarea className="in" value={car.issues} onChange={setC("issues")} placeholder="Known issues / needed repairs (auto-filled from listing)" />
                </div>
              </>
            )}

            {mode === "item" && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px", marginTop: 10 }}>
                  <input className="in" value={item.name} onChange={setI("name")} placeholder="Item *" />
                  <input className="in" value={item.brand} onChange={setI("brand")} placeholder="Brand" />
                  <input className="in" value={item.asking} onChange={setI("asking")} placeholder="Asking price *" inputMode="numeric" />
                  <select className="in" value={item.condition} onChange={setI("condition")}>
                    <option>new / sealed</option><option>like new</option><option>used - good</option><option>used - fair</option><option>for parts / not working</option>
                  </select>
                </div>
                <div style={{ marginTop: 14 }}>
                  <textarea className="in" value={item.issues} onChange={setI("issues")} placeholder="Issues / missing accessories" />
                </div>
              </>
            )}

            {mode === "salvage" && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px", marginTop: 10 }}>
                  <input className="in" value={sal.year} onChange={setSa("year")} placeholder="Year *" inputMode="numeric" />
                  <input className="in" value={sal.make} onChange={setSa("make")} placeholder="Make *" />
                  <input className="in" value={sal.model} onChange={setSa("model")} placeholder="Model *" />
                  <input className="in" value={sal.trim} onChange={setSa("trim")} placeholder="Trim" />
                  <input className="in" value={sal.mileage} onChange={setSa("mileage")} placeholder="Mileage" inputMode="numeric" />
                  <input className="in" value={sal.bid} onChange={setSa("bid")} placeholder="Current / expected bid *" inputMode="numeric" />
                  <select className="in" value={sal.runs} onChange={setSa("runs")}>
                    <option>run and drive</option><option>starts</option><option>non-running</option>
                  </select>
                  <select className="in" value={sal.title} onChange={setSa("title")}>
                    <option>salvage certificate</option><option>clean title</option><option>rebuilt title</option><option>certificate of destruction</option>
                  </select>
                  <input className="in" value={sal.towing} onChange={setSa("towing")} placeholder="Towing / transport est." inputMode="numeric" />
                </div>
                <div style={{ marginTop: 14 }}>
                  <textarea className="in" value={sal.damage} onChange={setSa("damage")} placeholder="Damage description * — e.g. front end collision, airbags deployed" />
                </div>
                {sal.title === "certificate of destruction" && <div className="note" style={{ color: C.red }}>Certificate of destruction = can never be road-titled in the US. Parts value only.</div>}
              </>
            )}

            <button className="btn btn-accent btn-block lift" style={{ marginTop: 18, borderRadius: 10 }} onClick={mode === "car" ? analyzeCar : mode === "item" ? analyzeItem : analyzeSalvage} disabled={!ready || busy}>
              {runLabel}
            </button>
            {busy && <div className="note" style={{ animation: "pulse 1.4s infinite" }}>Live web search in progress — 30–90 seconds.</div>}
            {error && <div className="note" style={{ color: C.red }}>{error}</div>}
          </div>

          {mode === "car" && market && (
            <>
              <div className="hair" />
              <div style={{ padding: "22px 22px 24px" }}>
                <Label>Market value</Label>
                <div style={{ marginTop: 10 }}>
                  <ValueGrid cells={[["Private low", market.fair_low], ["Private mid", market.fair_mid], ["Private high", market.fair_high], ["Dealer retail", market.dealer_retail]]} />
                </div>
                <CompList comps={market.comps} />
                {market.notes && <div className="note">{market.notes}</div>}
              </div>
            </>
          )}
          {mode === "car" && repairs && (
            <>
              <div className="hair" />
              <div style={{ padding: "22px 22px 24px" }}>
                <Label>Repairs to get it running right</Label>
                <div style={{ marginTop: 8 }}><RepairList repairs={repairs} /></div>
              </div>
            </>
          )}

          {mode === "item" && flip && (
            <>
              <div className="hair" />
              <div style={{ padding: "22px 22px 24px" }}>
                <Label>Resale values</Label>
                <div style={{ marginTop: 10 }}>
                  <ValueGrid cells={[["eBay sold (mid)", flip.ebay_sold_mid], ["eBay active avg", flip.ebay_active_avg], ["FB Marketplace typical", flip.fb_typical], ["Retail new", flip.retail_new]]} />
                </div>
                <div className="note" style={{ fontFamily: mono, fontSize: 12 }}>
                  eBay sold range {fmt(flip.ebay_sold_low)} – {fmt(flip.ebay_sold_high)} · est. shipping {fmt(flip.ship_est)}
                </div>
                <CompList comps={flip.comps} />
                {flip.notes && <div className="note">{flip.notes}</div>}
              </div>
              <div className="hair" />
              <div style={{ padding: "22px 22px 24px" }}>
                <Label>Flip economics</Label>
                <div style={{ marginTop: 8 }}>
                  <Row l="Sell on eBay (after ~13.5% fees + ship)" v={fmt(flipCalc.ebayNet)} />
                  <Row l="Sell local on FB (no fees)" v={fmt(flipCalc.fbNet)} />
                  <Row l={`Best channel · ${flipCalc.bestChannel}`} v={fmt(flipCalc.bestNet)} bold />
                  <Row l="Buy at asking" v={"−" + fmt(askingItem).slice(1)} />
                  <Row l="Profit at asking" v={(flipCalc.profitAtAsking >= 0 ? "+" : "−") + fmt(Math.abs(flipCalc.profitAtAsking)).slice(1) + (flipCalc.roiAtAsking != null ? ` (${Math.round(flipCalc.roiAtAsking * 100)}% ROI)` : "")} bold color={flipCalc.profitAtAsking >= 0 ? C.green : C.red} />
                </div>
              </div>
            </>
          )}

          {mode === "salvage" && salMarket && (
            <>
              <div className="hair" />
              <div style={{ padding: "22px 22px 24px" }}>
                <Label>Value · clean vs rebuilt</Label>
                <div style={{ marginTop: 10 }}>
                  <ValueGrid cells={[["Clean-title value", salMarket.clean_value], ["Rebuilt-title resale", salMarket.rebuilt_resale], ["Similar salvage lots avg", salMarket.salvage_comps_avg], ["Current bid", bid]]} />
                </div>
                <CompList comps={salMarket.comps} />
                {salMarket.notes && <div className="note">{salMarket.notes}</div>}
              </div>
            </>
          )}
          {mode === "salvage" && salRepairs && (
            <>
              <div className="hair" />
              <div style={{ padding: "22px 22px 24px" }}>
                <Label>Parts + repairs to rebuild</Label>
                <div style={{ marginTop: 8 }}><RepairList repairs={salRepairs} /></div>
              </div>
            </>
          )}
          {mode === "salvage" && salCalc && (
            <>
              <div className="hair" />
              <div style={{ padding: "22px 22px 24px" }}>
                <Label>All-in flip math</Label>
                <div style={{ marginTop: 8 }}>
                  <Row l="Winning bid" v={fmt(bid)} />
                  <Row l="Auction fees (est.)" v={fmt(salCalc.fees)} />
                  <Row l="Towing / transport" v={fmt(towing)} />
                  <Row l="Repairs (est. mid)" v={fmt(salCalc.repMid)} />
                  <Row l="Hidden-damage buffer (15%)" v={fmt(salCalc.buffer)} />
                  <Row l="Inspection + rebuilt title" v={fmt(salCalc.titleCosts)} />
                  <Row l="All-in cost" v={fmt(salCalc.totalIn)} bold />
                  <Row l="Rebuilt-title resale" v={fmt(salCalc.resale)} />
                  <Row l="Projected profit" v={(salCalc.profit >= 0 ? "+" : "−") + fmt(Math.abs(salCalc.profit)).slice(1) + (salCalc.roi != null ? ` (${Math.round(salCalc.roi * 100)}% ROI)` : "")} bold color={salCalc.profit >= 0 ? C.green : C.red} />
                </div>
              </div>
            </>
          )}

          {verdict && (
            <>
              <div className="hair" />
              <div style={{ padding: "22px 22px 28px" }}>
                <div className="vcell" style={{ borderLeft: `4px solid ${verdict.color}`, borderRadius: 12, padding: "16px 18px" }}>
                  <div style={{ fontWeight: 700, fontSize: 26, color: verdict.color, letterSpacing: "-0.01em" }}>{verdict.label}</div>
                  <div style={{ marginTop: 6, fontSize: 14, color: C.sub }}>{verdict.note}</div>
                  {mode === "car" && (
                    <div style={{ marginTop: 14 }}>
                      <Row l={car.seller === "dealer" ? "Dealer retail value" : "Market value (mid)"} v={fmt(baseValue)} />
                      <Row l="Less repairs (est. mid)" v={"−" + fmt(repairMid).slice(1)} />
                      <Row l="Adjusted value" v={fmt(adjusted)} bold />
                      <Row l="Asking price" v={fmt(askingCar)} />
                      <Row l="Margin at asking" v={(marginCar >= 0 ? "+" : "−") + fmt(Math.abs(marginCar)).slice(1) + ` (${Math.round(pctCar * 100)}%)`} bold color={verdict.color} />
                    </div>
                  )}
                  {mode === "salvage" && salCalc && (
                    <div style={{ marginTop: 14, textAlign: "center", padding: "12px 8px", background: C.bg, borderRadius: 10 }}>
                      <Label>Your max bid · hits {fmt(salCalc.targetProfit)} target profit</Label>
                      <div style={{ fontFamily: mono, fontWeight: 600, fontSize: 32, color: verdict.color }}>{fmt(salCalc.maxBid)}</div>
                    </div>
                  )}
                </div>

                {offer && (
                  <div style={{ marginTop: 20 }}>
                    <Label>Your offer</Label>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginTop: 8 }}>
                      {[["Open at", offer.open], ["Target", offer.target], ["Walk-away", offer.walk]].map(([l, v]) => (
                        <div key={l} className="vcell" style={{ textAlign: "center" }}>
                          <Label>{l}</Label>
                          <div className="vnum">{fmt(v)}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: 12, border: `1px dashed ${C.line}`, borderRadius: 10, padding: 14, fontSize: 14, lineHeight: 1.55, background: "#fff" }}>{offerMessage}</div>
                    <button className="btn btn-primary btn-block lift" style={{ marginTop: 10, borderRadius: 10 }} onClick={copyOffer}>
                      {copied ? "Copied ✓" : "Copy message to seller"}
                    </button>
                  </div>
                )}

                <div className="note" style={{ fontSize: 11 }}>
                  Estimates from live web search{mode === "salvage" ? " — auction fees approximated; check state rebuilt-title inspection rules before bidding" : " — verify condition in person before paying"}.
                </div>
              </div>
            </>
          )}
        </div>
      </main>

      {/* PRICING */}
      <section ref={priceRef} style={{ maxWidth: 680, margin: "0 auto", padding: "8px 16px 56px" }}>
        <h2 style={{ fontWeight: 700, fontSize: 26, textAlign: "center", marginBottom: 20, letterSpacing: "-0.01em" }}>Pricing</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div className="plan">
            <div style={{ fontWeight: 600, fontSize: 14, color: C.sub }}>Free</div>
            <div style={{ fontFamily: mono, fontWeight: 600, fontSize: 30, margin: "6px 0 10px" }}>$0</div>
            <div style={{ fontSize: 13, lineHeight: 2, color: C.ink }}>
              {freeLimit} full appraisals<br />All three modes<br />Screenshot listing reader<br />Offer + max bid calculator
            </div>
            <div className="note" style={{ fontFamily: mono, fontSize: 12 }}>{pro ? "Included in Pro" : !accountLoaded ? "…" : `${remaining} of ${freeLimit} remaining`}</div>
          </div>
          <div className="plan pro">
            <div style={{ fontWeight: 600, fontSize: 14, opacity: 0.7 }}>Pro</div>
            <div style={{ fontFamily: mono, fontWeight: 600, fontSize: 30, margin: "6px 0 10px" }}>$30<span style={{ fontSize: 14 }}>/mo</span></div>
            <div style={{ fontSize: 13, lineHeight: 2 }}>
              Unlimited appraisals<br />Car + item + salvage modes<br />One good lowball pays for months
            </div>
            <button className="btn btn-accent btn-block lift" style={{ marginTop: 14, borderRadius: 10 }} disabled={pro || checkoutBusy} onClick={startCheckout}>
              {pro ? "You're Pro ✓" : checkoutBusy ? "Opening checkout…" : "Start membership"}
            </button>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer style={{ borderTop: `1px solid ${C.line}`, padding: "22px 20px", textAlign: "center" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>lowballer<span style={{ color: C.accent }}>.org</span></div>
        <div style={{ fontFamily: mono, fontSize: 11, marginTop: 6, color: C.sub }}>
          Appraisals by Claude (Anthropic) with live web search. Estimates only — inspect before you buy.
        </div>
      </footer>

      {/* PAYWALL */}
      {showPaywall && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(22,24,29,.5)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div className="card" style={{ maxWidth: 400, width: "100%", padding: 24 }}>
            <div style={{ fontWeight: 700, fontSize: 22 }}>Go Pro — $30/mo</div>
            <p style={{ fontSize: 14, color: C.sub, margin: "10px 0 14px", lineHeight: 1.5 }}>
              Unlimited appraisals across all three modes. Cancel anytime from your Stripe receipt email.
            </p>
            <button className="btn btn-accent btn-block lift" style={{ borderRadius: 10 }} disabled={checkoutBusy} onClick={startCheckout}>
              {checkoutBusy ? "Opening checkout…" : "Continue to secure checkout"}
            </button>
            <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={() => setShowPaywall(false)}>Not now</button>
          </div>
        </div>
      )}

      {/* SIGN IN */}
      {showSignIn && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(22,24,29,.5)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div className="card" style={{ maxWidth: 400, width: "100%", padding: 24 }}>
            {signInSent ? (
              <>
                <div style={{ fontWeight: 700, fontSize: 22 }}>Check your email</div>
                <p style={{ fontSize: 14, color: C.sub, margin: "10px 0 14px", lineHeight: 1.5 }}>
                  We sent a sign-in link to <strong>{signInEmail.trim()}</strong>. It expires in 15 minutes.
                </p>
                <button className="btn btn-ghost btn-block" onClick={closeSignIn}>Close</button>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 700, fontSize: 22 }}>Sign in</div>
                <p style={{ fontSize: 14, color: C.sub, margin: "10px 0 14px", lineHeight: 1.5 }}>
                  No password — we'll email you a link. Your free appraisals and Pro status follow your account everywhere, incognito included.
                </p>
                <input
                  className="in" type="email" placeholder="you@example.com" value={signInEmail}
                  onChange={(e) => setSignInEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && signInEmail.trim() && !signInBusy) sendSignInLink(); }}
                  style={{ marginBottom: 14 }}
                />
                <button className="btn btn-accent btn-block lift" style={{ borderRadius: 10 }} disabled={signInBusy || !signInEmail.trim()} onClick={sendSignInLink}>
                  {signInBusy ? "Sending…" : "Send magic link"}
                </button>
                <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={closeSignIn}>Cancel</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
