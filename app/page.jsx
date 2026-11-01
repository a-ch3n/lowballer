"use client";
import { useState, useEffect, useRef } from "react";

/*
  LOWBALLER.ORG — production build
  Modes: Car / Any item / Copart-Salvage
  Pay per result: every non-Pro appraisal shows a teaser, then unlocks for $5 (one-time, Stripe) — or Pro $30/mo for unlimited.
  Dark, app-style UI: scan-first home (link / photo scan), half-dial deal gauge,
  market price-range bar with asking + offer markers.
  Magic-link sign-in, no passwords — see /api/auth/* and lib/auth.js.
  All AI calls go through /api/appraise (Anthropic key stays server-side).
*/

// Dark, app-style theme. Lime marks "your number" (the offer / max bid);
// violet is for links and secondary accents.
const C = {
  bg: "#0A0B0D", surface: "#121418", surface2: "#181B21", ink: "#F2F4F7", sub: "#8E96A3",
  line: "#22262E", line2: "#2F343E",
  lime: "#C8F542", limeInk: "#0A0B0D", violet: "#9C8CFF",
  green: "#3DDC97", amber: "#FFB547", red: "#FF6161",
};
const mono = "'IBM Plex Mono','Courier New',monospace";
const display = "'Space Grotesk','Inter',system-ui,sans-serif";
const fmt = (n) => (n == null || isNaN(n) ? "—" : "$" + Math.round(n).toLocaleString());

async function callAppraise({ content, useSearch = false, mode = "car", extra }) {
  const res = await fetch("/api/appraise", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, useSearch, mode, ...extra }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error("auth"), { needsAuth: true });
  if (res.status === 402) throw Object.assign(new Error("limit"), { limit: true });
  if (res.status === 429) throw Object.assign(new Error(data.detail || "Too many requests — try again in a bit."), { rateLimited: true });
  // A `detail` is a message the server wrote for the user (bad input, AI credits,
  // an analysis that failed validation) — show it instead of a generic failure.
  if (!res.ok) throw Object.assign(new Error(data.detail || data.error || "Request failed"), { userFacing: !!data.detail });
  return data; // { json, pro } / { analysis, pro } — or { locked, resultId, teaser, price } for non-Pro research
}

// ---- Photos: up to 6, compressed in the browser before upload ----
const MAX_PHOTOS = 6;
async function loadBitmap(file) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(file); } catch {}
  }
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("decode")); };
    img.src = url;
  });
}
// Re-encodes as JPEG, shrinking until each photo is well under ~375 KB, so six
// of them fit comfortably inside the request size limit.
async function compressImage(file) {
  const src = await loadBitmap(file);
  try {
    for (const [maxSide, quality] of [[1280, 0.8], [1024, 0.7], [800, 0.6]]) {
      const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(src.width * scale));
      canvas.height = Math.max(1, Math.round(src.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // flatten transparent PNGs instead of turning them black
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", quality).split(",")[1];
      if (data && data.length <= 500_000) return { data, type: "image/jpeg", name: file.name };
    }
    throw new Error("too large");
  } finally {
    src.close?.();
  }
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
            <span style={{ fontFamily: mono, fontSize: 12, color: C.violet }}>{c.source}</span>
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

// ---- Small inline icons (no icon library) ----
const Icon = {
  link: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </svg>
  ),
  camera: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><circle cx="12" cy="13" r="3.5" />
    </svg>
  ),
  image: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 9" />
    </svg>
  ),
  arrow: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
};

// ---- Deal-score gauge: a half-dial with a needle ----
function Gauge({ value, color, label, size = 150 }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const len = Math.PI * 50; // half-circle of r=50
  const ang = Math.PI * (1 - v / 100);
  return (
    <div className="gauge" style={{ width: size }}>
      <svg viewBox="0 0 120 68" width={size} height={(size * 68) / 120} aria-hidden="true">
        <path d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke={C.line2} strokeWidth="10" strokeLinecap="round" />
        <path d="M10 60 A50 50 0 0 1 110 60" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${(v / 100) * len} ${len}`} className="gauge-arc" />
        <line x1="60" y1="60" x2={60 + 36 * Math.cos(ang)} y2={60 - 36 * Math.sin(ang)} stroke={C.ink} strokeWidth="2.5" strokeLinecap="round" className="gauge-needle" />
        <circle cx="60" cy="60" r="4.5" fill={C.ink} />
      </svg>
      <div className="gauge-val" style={{ color }}>{Math.round(v)}<small>/100</small></div>
      {label && <div className="lbl" style={{ textAlign: "center", marginTop: 2 }}>{label}</div>}
    </div>
  );
}

// ---- Where the asking price and your offer land against the market ----
function PriceRange({ low, mid, high, asking, offer }) {
  if (!(low > 0 && high > 0)) return null;
  const vals = [low, high, asking, offer].filter((n) => Number.isFinite(n) && n > 0);
  const min = Math.min(...vals) * 0.95;
  const max = Math.max(...vals) * 1.05;
  const pct = (n) => ((n - min) / (max - min)) * 100;
  const tag = (n) => `${Math.min(86, Math.max(14, pct(n)))}%`; // keep labels on screen
  return (
    <div className="pr">
      <div className="pr-track">
        <div className="pr-band" style={{ left: `${pct(low)}%`, width: `${pct(high) - pct(low)}%` }} />
        {mid > 0 && <div className="pr-tick" style={{ left: `${pct(mid)}%` }} />}
        {asking > 0 && <div className="pr-dot ask" style={{ left: `${pct(asking)}%` }} />}
        {offer > 0 && <div className="pr-dot off" style={{ left: `${pct(offer)}%` }} />}
      </div>
      {asking > 0 && <div className="pr-tag ask" style={{ left: tag(asking) }}>Asking {fmt(asking)}</div>}
      {offer > 0 && <div className="pr-tag off" style={{ left: tag(offer) }}>Your offer {fmt(offer)}</div>}
      <div className="pr-scale">
        <span><i className="pr-key" />Market {fmt(low)} – {fmt(high)}{mid > 0 ? ` · mid ${fmt(mid)}` : ""}</span>
      </div>
    </div>
  );
}

// ---- Vehicle deal analysis results ----
const VERDICT_UI = {
  steal: { label: "Steal", color: C.green },
  fair: { label: "Fair price", color: C.violet },
  overpriced: { label: "Overpriced", color: C.amber },
  money_pit: { label: "Money pit", color: C.red },
};
const SEV_UI = {
  high: { label: "High", color: C.red },
  medium: { label: "Medium", color: C.amber },
  low: { label: "Low", color: C.sub },
};
const FLAG_SOURCE_LABEL = {
  listing_text: "In the listing",
  listing_omission: "Missing from listing",
  photo: "In the photos",
  market_comparison: "Vs. market",
  known_model_issue: "Known model issue",
};
const LIKELY_LABEL = { reported: "in listing", visible: "seen in photos", typical: "typical" };
const signed = (n) => (n < 0 ? "−" : "+") + fmt(Math.abs(n));
const range = (lo, hi) => (Math.round(lo) === Math.round(hi) ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`);

function Collapsible({ title, badge, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="coll">
      <button type="button" className="coll-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
          <span>{title}</span>
          {badge}
        </span>
        <span className={`coll-chev ${open ? "open" : ""}`} aria-hidden="true">›</span>
      </button>
      {open && <div className="coll-body">{children}</div>}
    </div>
  );
}

function FlagRow({ f }) {
  const sev = SEV_UI[f.severity];
  const [open, setOpen] = useState(f.severity === "high"); // high severity starts expanded
  return (
    <div className="fr" style={{ borderLeftColor: sev.color }}>
      <button type="button" className="fr-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="vr-pill" style={{ color: sev.color, borderColor: sev.color, flex: "none" }}>{sev.label}</span>
        <span style={{ flex: 1, minWidth: 0 }}>{f.flag}</span>
        <span className={`coll-chev ${open ? "open" : ""}`} aria-hidden="true" style={{ fontSize: 18 }}>›</span>
      </button>
      {open && (
        <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: C.ink }}>
          <div style={{ fontFamily: mono, fontSize: 11, color: C.sub, marginBottom: 4 }}>{FLAG_SOURCE_LABEL[f.source]}</div>
          {f.quote && <div style={{ borderLeft: `2px solid ${C.line2}`, paddingLeft: 10, color: C.sub, fontStyle: "italic", marginBottom: 6 }}>“{f.quote}”</div>}
          <div>{f.evidence}</div>
        </div>
      )}
    </div>
  );
}

function carChips(car) {
  return [
    [car.year, car.make, car.model, car.trim].filter(Boolean).join(" "),
    car.mileage ? `${Number(car.mileage).toLocaleString()} mi` : "",
    car.seller === "dealer" ? "Dealer" : "Private seller",
    car.location || "",
  ].filter(Boolean);
}

function VehicleResults({ a, car, offer, asking, dealMath, offerPanel, share }) {
  const ui = VERDICT_UI[a.verdict] || VERDICT_UI.fair;
  const [checked, setChecked] = useState({});
  const highCount = a.red_flags.filter((f) => f.severity === "high").length;
  const worst = a.red_flags[0]?.severity;
  const flagColor = worst ? SEV_UI[worst].color : C.green;
  const done = Object.values(checked).filter(Boolean).length;
  const mv = a.market_value;
  const fp = a.flip_potential;
  const ra = a.repair_estimate;
  const vsMarket = a.asking_vs_market_pct;

  return (
    <div className="res">
      {/* Verdict: gauge + your number */}
      <div className="res-hero">
        <div className="res-top">
          <Gauge value={a.deal_score} color={ui.color} label="Deal score" />
          <div className="res-num">
            <span className="vr-badge" style={{ color: ui.color, borderColor: ui.color }}>{ui.label}</span>
            {offer ? (
              <>
                <div className="lbl" style={{ marginTop: 12 }}>Your lowball</div>
                <div className="big-num">{fmt(offer.target)}</div>
                <div style={{ fontFamily: mono, fontSize: 12, color: C.sub }}>open {fmt(offer.open)} · walk away at {fmt(offer.walk)}</div>
              </>
            ) : null}
          </div>
        </div>
        <div style={{ marginTop: 14, fontSize: 14.5, lineHeight: 1.55, color: C.sub }}>{a.reason}</div>
        <div className="vr-chips">
          {carChips(car).map((c) => <span key={c} className="chip">{c}</span>)}
        </div>
        <PriceRange low={mv.low} mid={mv.mid} high={mv.high} asking={asking} offer={offer?.target} />
        <div className="vr-chips">
          <span className="vr-pill" style={{ color: flagColor, borderColor: flagColor }}>
            {a.red_flags.length ? `${a.red_flags.length} red flag${a.red_flags.length > 1 ? "s" : ""}${highCount ? ` · ${highCount} high` : ""}` : "no red flags"}
          </span>
          <span className="vr-pill">repairs {ra.items.length ? range(ra.total_low, ra.total_high) : "none expected"}</span>
          <span className="vr-pill" style={{ color: fp.decision === "go" ? C.green : C.red, borderColor: fp.decision === "go" ? C.green : C.red }}>flip: {fp.decision === "go" ? "go" : "no-go"}</span>
          {vsMarket != null && <span className="vr-pill">asking {vsMarket > 0 ? "+" : ""}{vsMarket}% vs market</span>}
        </div>
        {share}
        {highCount > 0 && offer && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: C.red, lineHeight: 1.45 }}>
            The offer math only covers price and repairs. Resolve the high-severity red flags before offering anything.
          </div>
        )}
      </div>

      {offerPanel}

      {/* Sections */}
      <div style={{ marginTop: 16 }}>
        <Collapsible
          title="Red flags"
          defaultOpen={a.red_flags.length > 0}
          badge={<span className="vr-pill" style={{ color: flagColor, borderColor: flagColor }}>{a.red_flags.length}</span>}
        >
          {a.red_flags.length === 0 ? (
            <div style={{ fontSize: 14, color: C.sub, lineHeight: 1.5 }}>
              Nothing concerning stands out in the listing{a.meta.photos_analyzed ? " or photos" : ""}. That's not a clean bill of health — still run the inspection checklist.
            </div>
          ) : (
            a.red_flags.map((f, i) => <FlagRow key={i} f={f} />)
          )}
          {a.condition_summary && (
            <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.5, color: C.sub }}>
              <strong style={{ color: C.ink }}>Condition: </strong>{a.condition_summary}
            </div>
          )}
        </Collapsible>

        <Collapsible title="Market value">
          <ValueGrid cells={[["Private low", mv.low], ["Private mid", mv.mid], ["Private high", mv.high], ["Dealer retail", mv.dealer_retail]]} />
          <div className="note" style={{ fontFamily: mono, fontSize: 12 }}>
            {mv.basis === "live_comps"
              ? `Based on ${mv.comps.length} live listing${mv.comps.length > 1 ? "s" : ""} found by web search.`
              : "No live listings found — this is an estimate from value guides. Treat it as a ballpark."}
          </div>
          {mv.comps.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {mv.comps.map((c, i) => (
                <div key={i} className="comp">
                  <div style={{ minWidth: 0 }}>
                    <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ fontFamily: mono, fontSize: 12, color: C.violet }}>{c.source}</a>
                    <span style={{ color: C.sub }}> — {c.desc}</span>
                  </div>
                  <div style={{ fontFamily: mono, fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(c.price)}</div>
                </div>
              ))}
            </div>
          )}
          {mv.notes && <div className="note">{mv.notes}</div>}
          {a.meta.sources_found.length > 0 && (
            <div className="note" style={{ fontSize: 12 }}>
              Searched:{" "}
              {a.meta.sources_found.slice(0, 5).map((s, i) => (
                <span key={s.url}>{i > 0 && " · "}<a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: C.sub }}>{s.title.length > 38 ? s.title.slice(0, 38) + "…" : s.title}</a></span>
              ))}
            </div>
          )}
          <div style={{ marginTop: 14 }}>
            <Label>How the offer is built</Label>
            <Row l={dealMath.dealer ? "Dealer retail value" : "Market value (mid)"} v={fmt(dealMath.baseValue)} />
            <Row l="Less repairs (est. mid)" v={"−" + fmt(dealMath.repairMid).slice(1)} />
            <Row l="Adjusted value" v={fmt(dealMath.adjusted)} bold />
            <Row l="Asking price" v={fmt(asking)} />
            <Row l="Margin at asking" v={(dealMath.margin >= 0 ? "+" : "−") + fmt(Math.abs(dealMath.margin)).slice(1) + (dealMath.pct != null ? ` (${Math.round(dealMath.pct * 100)}%)` : "")} bold color={dealMath.margin >= 0 ? C.green : C.red} />
          </div>
        </Collapsible>

        <Collapsible title="Repair estimate" badge={<span className="vr-pill">{ra.items.length ? range(ra.total_low, ra.total_high) : "none expected"}</span>}>
          {ra.items.length === 0 ? (
            <div style={{ fontSize: 14, color: C.sub }}>No repairs expected from what the listing and photos show.</div>
          ) : (
            <>
              {ra.items.map((it, i) => (
                <div key={i} className="comp">
                  <div style={{ minWidth: 0 }}>
                    {it.item}
                    <span className="pill">{LIKELY_LABEL[it.likely]}</span>
                    <div style={{ color: C.sub, fontSize: 12, marginTop: 2 }}>parts {range(it.parts_low, it.parts_high)} · labor {range(it.labor_low, it.labor_high)}</div>
                  </div>
                  <div style={{ fontFamily: mono, fontWeight: 600, whiteSpace: "nowrap" }}>{range(it.parts_low + it.labor_low, it.parts_high + it.labor_high)}</div>
                </div>
              ))}
              <div className="row" style={{ marginTop: 12, fontWeight: 600 }}>
                <div>Total</div>
                <div>{range(ra.total_low, ra.total_high)}</div>
              </div>
            </>
          )}
          {ra.notes && <div className="note">{ra.notes}</div>}
        </Collapsible>

        <Collapsible
          title="Flip potential"
          badge={<span className="vr-pill" style={{ color: fp.decision === "go" ? C.green : C.red, borderColor: fp.decision === "go" ? C.green : C.red }}>{fp.decision === "go" ? "Go" : "No-go"}</span>}
        >
          <Row l="Resale after repairs" v={range(fp.resale_low, fp.resale_high)} />
          <Row l="Est. net profit" v={`${signed(fp.net_profit_low)} to ${signed(fp.net_profit_high)}`} bold color={fp.decision === "go" ? C.green : C.red} />
          <Row l="Days to sell (guess)" v={`~${fp.days_to_sell}`} />
          <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.5 }}>{fp.decision_reason}</div>
          {fp.resale_reason && <div className="note">{fp.resale_reason}</div>}
        </Collapsible>

        <Collapsible
          title="Inspection checklist"
          badge={<span className="vr-pill">{done} / {a.inspection_checklist.length}</span>}
        >
          <div className="chk-bar"><i style={{ width: `${a.inspection_checklist.length ? (done / a.inspection_checklist.length) * 100 : 0}%` }} /></div>
          {a.inspection_checklist.map((c, i) => (
            <label key={i} className={`chk ${checked[i] ? "done" : ""}`}>
              <input type="checkbox" checked={!!checked[i]} onChange={(e) => setChecked((cur) => ({ ...cur, [i]: e.target.checked }))} />
              <span>
                <span className="t">{c.item}</span>
                {c.category === "model_specific" && <span className="pill pill-lime">this model</span>}
                <span style={{ display: "block", fontSize: 12, color: C.sub, marginTop: 2 }}>{c.why}</span>
              </span>
            </label>
          ))}
        </Collapsible>
      </div>

      <div className="note" style={{ fontSize: 11, lineHeight: 1.5 }}>
        AI-generated estimates from web search{a.meta.photos_analyzed ? " and your photos" : ""} — they can be wrong. Verify the title, vehicle history and condition in person before you pay.
      </div>
    </div>
  );
}

// ---- Pay-per-result: locked preview ----
// The server only sends a teaser for a locked result (verdict / score /
// counts), so everything below the teaser is placeholder — the real details
// aren't in the page until the result is unlocked.
const PREVIEW_MS = 3000;
const money = (cents) => "$" + (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function LockedPreview({ run, busy, onUnlock, onPro, share }) {
  const [revealed, setRevealed] = useState(!!run.instant);
  useEffect(() => {
    if (run.instant) { setRevealed(true); return; }
    setRevealed(false);
    const t = setTimeout(() => setRevealed(true), PREVIEW_MS);
    return () => clearTimeout(t);
  }, [run.id, run.instant]);

  const t = run.teaser || {};
  const car = run.mode === "car";
  const ui = car ? VERDICT_UI[t.verdict] || VERDICT_UI.fair : null;
  const chips = car
    ? [
        plural(t.flags || 0, "red flag") + (t.highFlags ? ` · ${t.highFlags} high` : ""),
        plural(t.comps || 0, "market comp"),
        plural(t.repairs || 0, "repair item"),
        `${t.checklist || 0}-point checklist`,
      ]
    : run.mode === "salvage"
    ? [plural(t.comps || 0, "comp"), plural(t.repairs || 0, "repair item")]
    : [plural(t.comps || 0, "sold comp")];
  const rows = car
    ? ["Your lowball offer", "Market value", "Red flags — the evidence", "Repair estimate", "Flip potential", "Inspection checklist"]
    : run.mode === "salvage"
    ? ["Your max bid", "Clean vs rebuilt value", "Comps", "Repair estimate"]
    : ["Your offer", "eBay sold prices", "Comps", "Flip profit"];
  const perks = car
    ? ["Your exact lowball offer — open, target, walk-away", "Every red flag with the evidence", "Market value with live comp links", "Itemized repair estimate + flip math", "Inspection checklist for this model"]
    : run.mode === "salvage"
    ? ["Your max bid at your target profit", "Clean vs rebuilt-title value", "Itemized repair estimate"]
    : ["Your exact lowball offer", "eBay sold comps + flip profit"];

  return (
    <div className="res">
      <div className="res-hero lk-in">
        {car ? (
          <div className="res-top">
            <Gauge value={t.deal_score} color={ui.color} label="Deal score" />
            <div className="res-num">
              <span className="vr-badge" style={{ color: ui.color, borderColor: ui.color }}>{ui.label}</span>
              <div className="lbl" style={{ marginTop: 12 }}>Your lowball</div>
              <div className="big-num locked-num" aria-label="Locked">$•••••</div>
              <div style={{ fontSize: 13, color: C.sub }}>Your appraisal is ready.</div>
            </div>
          </div>
        ) : (
          <div style={{ fontFamily: display, fontWeight: 700, fontSize: 22 }}>Your {run.mode === "salvage" ? "flip check" : "appraisal"} is ready.</div>
        )}
        <div className="vr-chips">{chips.map((c) => <span key={c} className="vr-pill">{c}</span>)}</div>
        {share}
      </div>

      <div className="lk-wrap">
        <div className={`lk-ghost ${revealed ? "on" : ""}`} aria-hidden="true">
          {rows.map((r, i) => (
            <div key={r} className="lk-row">
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{r}</span>
              <span className="lk-bar" style={{ width: `${[34, 28, 40, 24, 30, 22][i % 6]}%` }} />
            </div>
          ))}
        </div>
        {!revealed && <div className="note" style={{ animation: "pulse 1.4s infinite" }}>Loading your full report…</div>}
        {revealed && (
          <div className="lk-panel">
            <div className="lk-card">
              <div style={{ fontFamily: display, fontWeight: 700, fontSize: 21, letterSpacing: "-0.01em" }}>See the full {run.mode === "salvage" ? "flip check" : "appraisal"}</div>
              <ul className="perks">
                {perks.map((p) => <li key={p}>{p}</li>)}
              </ul>
              <button className="btn btn-accent btn-block lift" onClick={onUnlock} disabled={busy}>
                {busy ? "Opening checkout…" : `Unlock this result — ${money(run.price || 500)}`}
              </button>
              <button className="btn btn-ghost btn-block lift" style={{ marginTop: 8 }} onClick={onPro}>
                Or go Pro — unlimited for $30/mo
              </button>
              <div className="note" style={{ textAlign: "center", fontSize: 11.5 }}>One-time payment, secured by Stripe. No account needed.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Per-device storage (saved deals, coach threads). Never required. ----
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

// ---- Seller message styles (plain templates on top of your numbers) ----
const TONES = {
  car: [["friendly", "Friendly"], ["firm", "Firm"], ["cash", "Cash today"], ["mechanic", "I know cars"]],
  item: [["friendly", "Friendly"], ["firm", "Firm"], ["cash", "Cash today"]],
};

function sellerMessages({ mode, tone, short, car, item, offer, leverage, repairMid, soldMid }) {
  const price = fmt(offer.open);
  const name = mode === "car" ? `${car.year} ${car.make} ${car.model}`.trim() : [item.brand, item.name].filter(Boolean).join(" ") || "item";
  const lev = mode === "car" && leverage.length ? leverage.slice(0, 3).map((i) => i.item.toLowerCase()).join(", ") : "";
  const when = tone === "cash" ? "today" : "this week";
  const followUp = `Hi again — still interested in the ${name} if it's available. My ${price} cash offer stands, and I can move quickly.`;
  if (short) return { main: `Hi! Is the ${name} still available? Would you take ${price} cash? I can pick it up ${when}.`, followUp };

  let main;
  if (mode === "car") {
    main = {
      friendly: `Hi! Is the ${name} still available? I'm a serious buyer with cash. Based on what similar ones are going for${lev ? ` and the work it needs (${lev} — roughly ${fmt(repairMid)})` : ""}, I can offer ${price}. I can pick it up this week.`,
      firm: `Hi — I'm interested in the ${name}. I've compared it against similar listings${lev ? ` and priced the work it needs (${lev})` : ""}. My offer is ${price} cash. I can close this week if that works for you.`,
      cash: `Hi! Is the ${name} still available? I have ${price} in cash and can come today — no financing, no back-and-forth. Would that work?`,
      mechanic: `Hi — I'm looking at the ${name}. I do my own work, so I know what it needs${lev ? `: ${lev} — roughly ${fmt(repairMid)} in parts and labor` : ""}. Factoring that in, I can do ${price} cash.`,
    }[tone];
  } else {
    main = {
      friendly: `Hi! Is the ${name} still available? I can pick it up today with cash. Similar ones in ${item.condition} condition are selling for about ${fmt(soldMid)} — would you take ${price}?`,
      firm: `Hi — interested in the ${name}. Based on recent sold prices for this condition, my offer is ${price} cash. I can pick up whenever works for you.`,
      cash: `Hi! Is the ${name} still available? I can come today with ${price} cash.`,
    }[tone];
  }
  return { main: main || "", followUp };
}

function CopyButton({ text, label, className = "btn btn-ghost lift", style }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={className}
      style={style}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch {}
      }}
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

// ---- Shareable deal card ----
function ShareButton({ resultId, offerTarget, verdictLabel, compact }) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState(null);
  const [err, setErr] = useState("");
  async function share() {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resultId, offerTarget, verdictLabel }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.url) { setErr(d.detail || "Couldn't make a share link — try again."); return; }
      setLink(d.url);
      const text = d.headline ? `Lowballing this one ${d.headline} 👀` : "Ran this listing through Lowballer 👀";
      if (navigator.share) {
        try { await navigator.share({ title: "My Lowballer deal", text, url: d.url }); } catch {}
      } else {
        try { await navigator.clipboard.writeText(d.url); } catch {}
      }
    } catch {
      setErr("Couldn't make a share link — try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={compact ? "" : "share"}>
      <button className="btn btn-ghost lift share-btn" onClick={share} disabled={busy || !resultId}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v14" /></svg>
        {busy ? "Making card…" : "Share deal card"}
      </button>
      {link && (
        <div className="note" style={{ fontSize: 12.5 }}>
          Link copied — <a href={link} target="_blank" rel="noopener noreferrer">view card</a> · <a href={`${link}/opengraph-image`} target="_blank" rel="noopener noreferrer" download>save image</a>
        </div>
      )}
      {err && <div className="note" style={{ color: C.amber }}>{err}</div>}
    </div>
  );
}

// ---- Negotiation coach ----
const COACH_UI = {
  accept: { label: (p) => `Take it at ${fmt(p)}`, color: C.green },
  counter: { label: (p) => `Counter at ${fmt(p)}`, color: C.lime },
  hold: { label: (p) => `Hold at ${fmt(p)}`, color: C.violet },
  walk: { label: () => "Walk away", color: C.red },
};

function Coach({ resultId, numbers }) {
  const key = `lb_coach:${resultId}`;
  const [turns, setTurns] = useState([]); // { from: "seller" | "me", text, decision?, price?, summary? }
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { setTurns(store.get(key, [])); setInput(""); setErr(""); }, [key]);
  useEffect(() => { if (turns.length) store.set(key, turns.slice(-20)); }, [key, turns]);

  const lastOffer = [...turns].reverse().find((t) => t.from === "me" && t.price && t.decision !== "walk")?.price || numbers.open;

  async function ask() {
    const msg = input.trim();
    if (!msg) { setErr("Paste what the seller said first."); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/negotiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resultId, sellerMessage: msg, lastOffer, numbers, history: turns.map(({ from, text }) => ({ from, text })) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.detail || "The coach couldn't answer — try again."); return; }
      setTurns((t) => [...t, { from: "seller", text: msg }, { from: "me", text: d.message, decision: d.decision, price: d.price, summary: d.summary }]);
      setInput("");
    } catch {
      setErr("Couldn't reach Lowballer — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="coach">
      <div className="coach-h">
        <div>
          <div className="display" style={{ fontWeight: 700, fontSize: 17 }}>Negotiation coach</div>
          <div className="note" style={{ marginTop: 3 }}>Paste the seller's reply. We'll say take it, counter or walk — never past your {fmt(numbers.walk)} walk-away.</div>
        </div>
        {turns.length > 0 && (
          <button className="nav-link" style={{ flex: "none" }} onClick={() => { setTurns([]); store.set(key, []); }}>Start over</button>
        )}
      </div>

      {turns.map((t, i) =>
        t.from === "seller" ? (
          <div key={i} className="bubble seller">
            <div className="lbl" style={{ marginBottom: 3 }}>Seller</div>{t.text}
          </div>
        ) : (
          <div key={i} className="bubble me" style={{ borderColor: COACH_UI[t.decision]?.color }}>
            <div className="coach-dec" style={{ color: COACH_UI[t.decision]?.color }}>{COACH_UI[t.decision]?.label(t.price)}</div>
            {t.summary && <div className="note" style={{ marginTop: 2 }}>They said: {t.summary}</div>}
            <div className="msg" style={{ marginTop: 8 }}>{t.text}</div>
            <CopyButton text={t.text} label="Copy reply" style={{ marginTop: 8, padding: "8px 14px", fontSize: 13, borderRadius: 10 }} />
          </div>
        )
      )}

      <textarea className="in" style={{ marginTop: 12 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder={turns.length ? "What did they say back?" : "e.g. “Lowest I'll go is $15,000, already have people interested.”"} />
      <button className="btn btn-primary btn-block lift" style={{ marginTop: 8 }} onClick={ask} disabled={busy || !input.trim()}>
        {busy ? "Reading their reply…" : "What do I say?"}
      </button>
      {err && <div className="note" style={{ color: C.amber }}>{err}</div>}
    </div>
  );
}

// ---- My deals: saved on this device, reopen + compare ----
const MAX_DEALS = 20;

function DealsPanel({ deals, onOpen, onRemove }) {
  const [picked, setPicked] = useState([]);
  useEffect(() => { setPicked((p) => p.filter((id) => deals.some((d) => d.id === id))); }, [deals]);
  if (!deals.length) return null;
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 3 ? [...p.slice(1), id] : [...p, id]));
  const sel = picked.map((id) => deals.find((d) => d.id === id)).filter(Boolean);

  // Best buy: highest deal score; without scores, the deepest discount you'd offer.
  const rank = (d) => (d.score != null ? d.score : d.offer && d.asking ? ((d.asking - d.offer) / d.asking) * 100 : -1);
  const best = sel.length > 1 ? sel.reduce((a, b) => (rank(b) > rank(a) ? b : a)) : null;
  const rows = [
    ["Verdict", (d) => <span style={{ color: d.color, fontWeight: 700 }}>{d.verdict || "—"}</span>],
    ["Deal score", (d) => (d.score != null ? `${d.score}/100` : "—")],
    [sel.some((d) => d.mode === "salvage") ? "Asking / bid" : "Asking", (d) => fmt(d.asking)],
    ["Your offer", (d) => (d.locked ? <span style={{ color: C.sub }}>locked</span> : d.mode === "salvage" ? `max bid ${fmt(d.maxBid)}` : <span style={{ color: C.lime, fontWeight: 700 }}>{fmt(d.offer)}</span>)],
    ["Red flags", (d) => (d.flags != null ? `${d.flags}${d.highFlags ? ` · ${d.highFlags} high` : ""}` : "—")],
    ["Repairs", (d) => d.repairs || "—"],
    ["Flip", (d) => d.flip || "—"],
  ];

  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-h" style={{ justifyContent: "space-between" }}>
        <span>My deals</span>
        <span style={{ fontFamily: mono, fontSize: 11, color: C.sub, fontWeight: 500 }}>{sel.length ? `${sel.length} selected` : "tick 2–3 to compare"}</span>
      </div>
      <div className="panel-b">
        {deals.map((d) => (
          <div key={d.id} className={`deal ${picked.includes(d.id) ? "on" : ""}`}>
            <label className="deal-pick">
              <input type="checkbox" checked={picked.includes(d.id)} onChange={() => toggle(d.id)} aria-label={`Compare ${d.title}`} />
            </label>
            <button className="deal-main" onClick={() => onOpen(d.id)}>
              <span className="deal-t">{d.title}</span>
              <span className="deal-s">
                <span style={{ color: d.color }}>{d.verdict || "Appraised"}</span>
                {d.score != null ? ` · ${d.score}/100` : ""} · asking {fmt(d.asking)}
                {d.locked ? " · locked" : d.offer ? ` · offer ${fmt(d.offer)}` : ""}
              </span>
            </button>
            <button className="deal-x" onClick={() => onRemove(d.id)} aria-label={`Remove ${d.title}`}>×</button>
          </div>
        ))}

        {sel.length >= 2 && (
          <div className="cmp" style={{ gridTemplateColumns: `110px repeat(${sel.length}, minmax(140px, 1fr))` }}>
            <div className="cmp-h" />
            {sel.map((d) => (
              <div key={d.id} className={`cmp-h ${best?.id === d.id ? "best" : ""}`}>
                {best?.id === d.id && <span className="tag" style={{ position: "static", display: "inline-block", marginBottom: 6 }}>BEST BUY</span>}
                <div>{d.title}</div>
              </div>
            ))}
            {rows.map(([label, cell]) => (
              <div key={label} style={{ display: "contents" }}>
                <div className="cmp-l">{label}</div>
                {sel.map((d) => <div key={d.id} className={`cmp-c ${best?.id === d.id ? "best" : ""}`}>{cell(d)}</div>)}
              </div>
            ))}
          </div>
        )}
        <div className="note" style={{ fontSize: 11.5 }}>Saved in this browser only. Tap a deal to reopen it.</div>
      </div>
    </section>
  );
}

export default function Lowballer() {
  const [unlockPrice, setUnlockPrice] = useState(500); // cents, from /api/me
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
  const howRef = useRef(null);
  const resultsRef = useRef(null);

  async function refreshMe() {
    try {
      const r = await fetch("/api/me");
      const d = await r.json();
      setPro(d.pro);
      setEmail(d.email || null);
      if (d.unlockPrice) setUnlockPrice(d.unlockPrice);
      setLinkScan(d.linkScan || "off");
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
    const unlockId = params.get("unlock");
    if (unlockId) {
      const unlockSession = params.get("unlock_session");
      window.history.replaceState({}, "", "/");
      refreshMe();
      openResult(unlockId, unlockSession);
    } else if (sessionId) {
      fetch(`/api/checkout/verify?session_id=${encodeURIComponent(sessionId)}`)
        .then(() => {
          window.history.replaceState({}, "", "/");
          refreshMe();
          // Went Pro from a locked result — show it in full now.
          let pending = null;
          try { pending = sessionStorage.getItem("lb_pending_result"); sessionStorage.removeItem("lb_pending_result"); } catch {}
          if (pending) openResult(pending);
        })
        .catch(refreshMe);
    } else {
      refreshMe();
    }
  }, []);

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
    setEmail(null); setPro(false); setAuthNotice("");
    refreshMe();
  }

  function closeSignIn() {
    setShowSignIn(false);
    setSignInSent(false);
    setSignInEmail("");
  }

  const [mode, setMode] = useState("car");
  const [pasted, setPasted] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [linkScan, setLinkScan] = useState("off"); // "on" | "pro_only" | "off", from /api/me
  const [listingUrl, setListingUrl] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkNote, setLinkNote] = useState(null); // { text, warn }
  const [images, setImages] = useState([]);
  const [extracting, setExtracting] = useState(false);
  const [extractNote, setExtractNote] = useState("");

  const [car, setCar] = useState({ year: "", make: "", model: "", trim: "", mileage: "", asking: "", location: "", seller: "private", issues: "", desc: "" });
  const [item, setItem] = useState({ name: "", brand: "", condition: "used - good", asking: "", issues: "", desc: "" });
  const [sal, setSal] = useState({ year: "", make: "", model: "", trim: "", mileage: "", damage: "", runs: "run and drive", title: "salvage certificate", bid: "", towing: "300", desc: "" });

  const [phase, setPhase] = useState("idle");
  const [market, setMarket] = useState(null);
  const [vehicle, setVehicle] = useState(null);
  const [photoNote, setPhotoNote] = useState("");
  const [repairs, setRepairs] = useState(null);
  const [flip, setFlip] = useState(null);
  const [salMarket, setSalMarket] = useState(null);
  const [salRepairs, setSalRepairs] = useState(null);
  const [error, setError] = useState("");
  const [fromExt, setFromExt] = useState(null);
  const [lockedRun, setLockedRun] = useState(null); // { id, mode, teaser, price, instant }
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockNotice, setUnlockNotice] = useState(null); // { text, warn }
  const [resultId, setResultId] = useState(null); // id of the result on screen (locked, unlocked or Pro)
  const [tone, setTone] = useState("friendly");
  const [shortMsg, setShortMsg] = useState(false);
  const [deals, setDeals] = useState([]);
  useEffect(() => { setDeals(store.get("lb_deals", [])); }, []);

  // Text that arrives from a link scan or the extension opens the paste box.
  useEffect(() => { if (pasted) setPasteOpen(true); }, [!!pasted]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a result (or a locked preview) lands, bring it into view.
  useEffect(() => {
    if (phase === "done") setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }, [phase]);

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
    setMarket(null); setRepairs(null); setFlip(null); setVehicle(null); setLockedRun(null); setUnlockNotice(null); setResultId(null);
    setSalMarket(null); setSalRepairs(null);
    setError(""); setPhase("idle");
  }

  async function onFiles(e) {
    const picked = Array.from(e.target.files || []);
    e.target.value = ""; // so picking the same file again still fires onChange
    const room = Math.max(0, MAX_PHOTOS - images.length);
    const files = picked.slice(0, room);
    let skipped = picked.length - files.length;
    const out = [];
    for (const f of files) {
      try { out.push(await compressImage(f)); } catch { skipped++; }
    }
    setImages((cur) => [...cur, ...out].slice(0, MAX_PHOTOS));
    setPhotoNote(skipped ? `${skipped} photo${skipped > 1 ? "s" : ""} skipped — max ${MAX_PHOTOS}, or couldn't be read.` : "");
  }

  const removeImage = (i) => { setImages((cur) => cur.filter((_, j) => j !== i)); setPhotoNote(""); };

  function handleAuthRequired() {
    setShowSignIn(true);
    setPhase("idle");
  }

  async function loadFromLink(urlArg) {
    const url = (urlArg ?? listingUrl).trim();
    if (linkScan === "pro_only") { setShowPaywall(true); return; }
    if (!url) { setLinkNote({ text: "Paste a Facebook Marketplace listing link first.", warn: true }); return; }
    setLinkBusy(true); setLinkNote(null);
    try {
      const res = await fetch("/api/listing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.status === 401) { setShowSignIn(true); return; }
      if (res.status === 402) { setShowPaywall(true); return; }
      if (!res.ok) {
        // Any failure falls back to the screenshot path, which always works.
        const tail = d.fallback ? " Upload screenshots of it instead." : "";
        setLinkNote({ text: `${d.detail || "Couldn't load that listing."}${tail}`, warn: true });
        return;
      }
      resetResults();
      setImages(d.images);
      setPasted(d.text);
      setPhotoNote("");
      const bits = [
        `Loaded “${(d.listing.title || "listing").slice(0, 60)}”`,
        d.images.length ? `${d.images.length} photo${d.images.length > 1 ? "s" : ""}` : "no photos — add screenshots if you have them",
        d.listing.photoCount > 6 ? "first 6 photos only" : "",
      ].filter(Boolean);
      setLinkNote({
        text: bits.join(" · ") + (d.listing.sold ? " — Facebook shows this listing as SOLD." : d.listing.pending ? " — Facebook shows this listing as pending." : ""),
        warn: d.listing.sold || d.listing.pending || !d.images.length,
      });
      await extract({ images: d.images, pasted: d.text });
    } catch {
      // fetch itself failed — the server never answered, so it isn't the listing's fault
      setLinkNote({ text: "Couldn't reach Lowballer — check your connection and try again, or upload screenshots instead.", warn: true });
    } finally {
      setLinkBusy(false);
    }
  }

  // `src` lets a link scan hand over its photos/text directly instead of
  // waiting for the state updates to land.
  async function extract(src = {}) {
    const imgs = src.images ?? images;
    const text = src.pasted ?? pasted;
    // A bare link (or the short "check out this listing… <link>" text the FB
    // app's Share button copies) has nothing for Claude to read. Route
    // Facebook links to the link loader when this account has it — the
    // server finds the link in the text and resolves share links — and
    // otherwise say what to do.
    const fbLink = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.com|fb\.me)\/\S+/i.test(text);
    const bareLink = /^\s*(https?:\/\/)?\S+\.\S+\s*$/.test(text);
    if (!imgs.length && (bareLink || (fbLink && text.trim().split(/\s+/).length <= 25))) {
      const link = text.trim();
      if (fbLink && linkScan === "on") {
        setListingUrl(link); setPasted("");
        return loadFromLink(link);
      }
      setExtractNote(
        linkScan === "pro_only" && fbLink
          ? "Reading Marketplace links is a Pro feature. Or screenshot the listing and upload it — that works on every plan."
          : "That's a link, not the listing itself — Lowballer can't open it. Screenshot the listing and upload it, or paste the listing's text."
      );
      return;
    }
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

      if (imgs.length > 0) {
        content = [
          ...imgs.map((im) => ({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } })),
          { type: "text", text: `These are screenshots and/or photos of a ${kind}.` + (text ? ` Listing text: "${text.slice(0, 1500)}"` : "") + ` Extract the details. ${schema}` },
        ];
      } else if (text.trim()) {
        content = `Text of a ${kind}: "${text.slice(0, 1500)}". Extract the details. ${schema}`;
      } else {
        setExtractNote("Paste the listing text or upload a screenshot first.");
        setExtracting(false); return;
      }

      const { json: j } = await callAppraise({ content, useSearch: false });
      // Claude can set "error" for a warning (e.g. photos that don't match the
      // text) while still extracting the details — only bail if it got nothing.
      const gotDetails = mode === "item" ? j.name || j.asking : j.make || j.model || j.year;
      const warning = j.error ? ` Heads up: ${String(j.error).slice(0, 200)}` : "";
      if (!gotDetails) {
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
        setExtractNote("Details extracted — review, then run the appraisal." + warning);
      } else if (mode === "item") {
        setItem((c) => ({
          ...c, name: j.name || c.name, brand: j.brand || c.brand, condition: j.condition || c.condition,
          asking: String(j.asking || c.asking).replace(/[^0-9]/g, ""),
          issues: [c.issues, j.issues].filter(Boolean).join("; "),
          desc: j.desc || "",
        }));
        setExtractNote("Details extracted — review, then run the appraisal." + warning);
      } else {
        setSal((c) => ({
          ...c, year: j.year || c.year, make: j.make || c.make, model: j.model || c.model, trim: j.trim || c.trim,
          mileage: String(j.mileage || c.mileage).replace(/[^0-9]/g, ""),
          damage: j.damage || c.damage, runs: j.runs || c.runs, title: j.title || c.title,
          bid: String(j.bid || c.bid).replace(/[^0-9]/g, ""),
          desc: j.desc || "",
        }));
        setExtractNote("Lot details extracted — review, then run the flip check." + warning);
      }
    } catch (e) {
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
      // One server-built analysis (verdict, red flags, comps, repairs, flip,
      // checklist). Photos ride along. Non-Pro gets it back locked.
      const r = await callAppraise({
        useSearch: true, mode: "car",
        extra: {
          inputs: { car },
          analysis: "vehicle",
          listing: {
            year: car.year, make: car.make, model: car.model, trim: car.trim, mileage: car.mileage,
            asking: car.asking, location: car.location, seller: car.seller,
            issues: car.issues, desc: car.desc, text: pasted,
          },
          images: images.map(({ data, type }) => ({ data, type })),
        },
      });
      handleRun(r, "car");
    } catch (e) {
      if (e.needsAuth) return handleAuthRequired();
      if (e.rateLimited || e.userFacing) { setError(e.message); setPhase("error"); return; }
      console.error(e);
      setError("Analysis failed mid-search. Run it again.");
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
        useSearch: true, mode: "item", extra: { inputs: { item } },
      });
      handleRun(f, "item");
    } catch (e) {
      if (e.needsAuth) return handleAuthRequired();
      if (e.rateLimited) { setError(e.message); setPhase("error"); return; }
      console.error(e);
      setError("Analysis failed mid-search. Run it again.");
      setPhase("error");
    }
  }

  async function analyzeSalvage() {
    resetResults();
    try {
      setPhase("market");
      // One call for value + repairs, so the whole flip check is a single
      // (lockable) result rather than an open market call plus a metered one.
      const r = await callAppraise({
        content:
          `You are a salvage-vehicle flip analyst and collision/salvage repair estimator for a budget-minded flipper. Lot: ${salStr()}.` +
          (sal.desc ? ` Lot summary: "${sal.desc.slice(0, 300)}"` : "") +
          ` Use web search to find: (1) clean-title private-party value for this year/model/mileage, (2) realistic REBUILT-title resale value (typically 20-40% below clean — find actual rebuilt-title listings of this model if possible), (3) recent Copart/IAAI sold prices for similar damaged lots if findable, and (4) prices for the parts needed to make it road-worthy and sellable with a rebuilt title — USED/aftermarket (LKQ, car-part.com, eBay) where sensible, modest independent-shop or DIY labor, including likely hidden-damage items for this damage type. Respond ONLY with compact JSON, no markdown: {"clean_value":number,"rebuilt_resale":number,"salvage_comps_avg":number,"comps":[{"source":string,"desc":string,"price":number}],"notes":string,"repairs":{"items":[{"item":string,"parts":number,"labor":number,"total":number,"likely":"reported"|"typical"}],"total_low":number,"total_high":number,"notes":string}}. USD, up to 5 comps, max 6 repair items, each notes under 40 words.`,
        useSearch: true, mode: "salvage", extra: { inputs: { sal } },
      });
      handleRun(r, "salvage");
    } catch (e) {
      if (e.needsAuth) return handleAuthRequired();
      if (e.rateLimited) { setError(e.message); setPhase("error"); return; }
      console.error(e);
      setError("Analysis failed mid-search. Run it again.");
      setPhase("error");
    }
  }

  // Puts a full result into the state the result views read. Shared by a
  // Pro run, an unlocked result and a result reopened after Stripe.
  function applyResult(m, res) {
    if (m === "car") {
      setVehicle(res);
      // The deterministic offer math below reads `market` / `repairs`, so
      // feed it the same numbers the analysis shows.
      setMarket({
        fair_low: res.market_value.low, fair_mid: res.market_value.mid, fair_high: res.market_value.high,
        dealer_retail: res.market_value.dealer_retail ?? res.market_value.high,
        comps: res.market_value.comps, notes: res.market_value.notes,
      });
      setRepairs({
        items: res.repair_estimate.items.map((i) => {
          const parts = (i.parts_low + i.parts_high) / 2;
          const labor = (i.labor_low + i.labor_high) / 2;
          return { item: i.item, parts, labor, total: parts + labor, likely: i.likely === "typical" ? "typical" : "reported" };
        }),
        total_low: res.repair_estimate.total_low, total_high: res.repair_estimate.total_high, notes: res.repair_estimate.notes,
      });
    } else if (m === "item") {
      setFlip(res);
    } else {
      const { repairs: rep, ...mkt } = res || {};
      setSalMarket(mkt);
      setSalRepairs(rep || null);
    }
  }

  function handleRun(r, m) {
    setPro(r.pro);
    setResultId(r.resultId || null);
    if (r.locked) setLockedRun({ id: r.resultId, mode: m, teaser: r.teaser, price: r.price, instant: false });
    else applyResult(m, m === "car" ? r.analysis : r.json);
    setPhase("done");
  }

  // Reopens a stored result by id — after the Stripe redirect, after going
  // Pro, or when checkout says it's already paid.
  async function openResult(id, unlockSession) {
    try {
      const q = unlockSession ? `?unlock_session=${encodeURIComponent(unlockSession)}` : "";
      const r = await fetch(`/api/result/${encodeURIComponent(id)}${q}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setUnlockNotice({ text: d.detail || "That appraisal couldn't be found — run it again.", warn: true }); return; }
      const m = d.mode;
      setMode(m);
      setResultId(id);
      const inp = d.inputs || {};
      if (m === "car" && inp.car) setCar((c) => ({ ...c, ...inp.car }));
      if (m === "item" && inp.item) setItem((c) => ({ ...c, ...inp.item }));
      if (m === "salvage" && inp.sal) setSal((c) => ({ ...c, ...inp.sal }));
      setMarket(null); setRepairs(null); setFlip(null); setVehicle(null); setSalMarket(null); setSalRepairs(null);
      if (d.paid) {
        applyResult(m, d.result);
        setLockedRun(null);
        setUnlockNotice(unlockSession ? { text: "Unlocked ✓ — here's your full appraisal." } : null);
      } else {
        setLockedRun({ id, mode: m, teaser: d.teaser, price: d.price, instant: true });
        if (unlockSession) setUnlockNotice({ text: "Your payment is still processing. Refresh in a moment and it'll unlock.", warn: true });
      }
      setPhase("done");
    } catch {
      setUnlockNotice({ text: "Couldn't load that appraisal — refresh to try again.", warn: true });
    }
  }

  async function unlockResult() {
    if (!lockedRun) return;
    setUnlockBusy(true);
    try {
      const r = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resultId: lockedRun.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.url) { window.location.href = d.url; return; } // stays "busy" through the redirect
      if (d.paid) await openResult(lockedRun.id);
      else setUnlockNotice({ text: d.detail || "Checkout couldn't start — try again.", warn: true });
    } catch {
      setUnlockNotice({ text: "Checkout couldn't start — try again.", warn: true });
    }
    setUnlockBusy(false);
  }

  function goProFromLocked() {
    try { if (lockedRun) sessionStorage.setItem("lb_pending_result", lockedRun.id); } catch {}
    setShowPaywall(true);
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

  const msgTone = mode === "item" && tone === "mechanic" ? "friendly" : tone;
  const msgs = offer ? sellerMessages({ mode, tone: msgTone, short: shortMsg, car, item, offer, leverage, repairMid, soldMid: flip?.ebay_sold_mid }) : null;
  const offerNumbers = offer ? { asking: mode === "car" ? askingCar : askingItem, open: offer.open, target: offer.target, walk: offer.walk } : null;

  const offerPanel = offer ? (
    <>
      <div className="offer">
        <Label>Your offer</Label>
        <div className="offer-grid">
          {[["Open at", offer.open, ""], ["Target", offer.target, "on"], ["Walk away", offer.walk, ""]].map(([l, v, on]) => (
            <div key={l} className={`offer-cell ${on}`}>
              <Label>{l}</Label>
              <div className="vnum">{fmt(v)}</div>
            </div>
          ))}
        </div>
        <div className="tones">
          {(TONES[mode] || TONES.item).map(([k, label]) => (
            <button key={k} className={`tone ${msgTone === k ? "on" : ""}`} onClick={() => setTone(k)}>{label}</button>
          ))}
          <button className={`tone ${shortMsg ? "on" : ""}`} onClick={() => setShortMsg((v) => !v)} aria-pressed={shortMsg}>Text-length</button>
        </div>
        <div className="msg">{msgs.main}</div>
        <CopyButton text={msgs.main} label="Copy message to seller" className="btn btn-accent btn-block lift" style={{ marginTop: 10 }} />
        <details className="fu">
          <summary>If they go quiet</summary>
          <div className="msg">{msgs.followUp}</div>
          <CopyButton text={msgs.followUp} label="Copy follow-up" style={{ marginTop: 8, padding: "8px 14px", fontSize: 13, borderRadius: 10 }} />
        </details>
      </div>
      {resultId && <Coach resultId={resultId} numbers={offerNumbers} />}
    </>
  ) : null;

  // Save every result that lands (locked or full) to "My deals" on this device.
  useEffect(() => {
    if (phase !== "done" || !resultId) return;
    const title =
      mode === "car" ? [car.year, car.make, car.model, car.trim].filter(Boolean).join(" ")
      : mode === "item" ? [item.brand, item.name].filter(Boolean).join(" ")
      : [sal.year, sal.make, sal.model].filter(Boolean).join(" ") + " (salvage)";
    const base = { id: resultId, mode, title: title || "Untitled listing", at: Date.now(), flags: null, highFlags: null, repairs: null, flip: null, score: null };
    let e = null;
    if (lockedRun?.id === resultId) {
      const t = lockedRun.teaser || {};
      const ui = mode === "car" ? VERDICT_UI[t.verdict] : null;
      e = { ...base, locked: true, verdict: ui?.label || null, color: ui?.color || C.sub, score: mode === "car" ? t.deal_score : null,
        asking: mode === "car" ? askingCar : mode === "item" ? askingItem : bid,
        flags: mode === "car" ? t.flags : null, highFlags: mode === "car" ? t.highFlags : null };
    } else if (mode === "car" && vehicle) {
      const ui = VERDICT_UI[vehicle.verdict] || VERDICT_UI.fair;
      const ra = vehicle.repair_estimate;
      e = { ...base, locked: false, verdict: ui.label, color: ui.color, score: vehicle.deal_score, asking: askingCar, offer: offer ? Math.round(offer.target) : null,
        flags: vehicle.red_flags.length, highFlags: vehicle.red_flags.filter((f) => f.severity === "high").length,
        repairs: ra.items.length ? range(ra.total_low, ra.total_high) : "none expected", flip: vehicle.flip_potential.decision === "go" ? "go" : "no-go" };
    } else if (mode === "item" && flip && verdict) {
      e = { ...base, locked: false, verdict: verdict.label, color: verdict.color, asking: askingItem, offer: offer ? Math.round(offer.target) : null,
        flip: flipCalc ? `${signed(flipCalc.profitAtAsking)} at asking` : null };
    } else if (mode === "salvage" && salCalc && verdict) {
      e = { ...base, locked: false, verdict: verdict.label, color: verdict.color, asking: bid, maxBid: Math.round(salCalc.maxBid),
        repairs: range(salRepairs.total_low, salRepairs.total_high), flip: `${signed(salCalc.profit)} projected` };
    }
    if (!e) return;
    setDeals((cur) => {
      const next = [e, ...cur.filter((d) => d.id !== e.id)].slice(0, MAX_DEALS);
      store.set("lb_deals", next);
      return next;
    });
  }, [phase, resultId, lockedRun, vehicle, flip, salMarket, salRepairs, offer?.target, verdict?.label]); // eslint-disable-line react-hooks/exhaustive-deps

  function removeDeal(id) {
    setDeals((cur) => {
      const next = cur.filter((d) => d.id !== id);
      store.set("lb_deals", next);
      return next;
    });
  }

  const runLabel =
    phase === "market"
      ? mode === "item" ? "Searching eBay sold prices…" : mode === "salvage" ? "Valuing clean + rebuilt…" : "Searching market listings…"
      : phase === "repairs" ? "Pricing repair parts…"
      : mode === "salvage" ? "Run flip check" : "Run appraisal";

  const scrollTo = (ref) => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  const showLink = mode !== "salvage" && linkScan !== "off";

  return (
    <div className="app">
      <style dangerouslySetInnerHTML={{ __html: `
        * { box-sizing: border-box; }
        html, body { background: ${C.bg}; }
        .app { min-height: 100vh; background: ${C.bg}; color: ${C.ink}; font-family: 'Inter', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
        .app::before { content: ""; position: fixed; inset: -20% -10% auto; height: 70vh; pointer-events: none; z-index: 0;
          background: radial-gradient(40% 50% at 15% 10%, rgba(200,245,66,.10), transparent 70%), radial-gradient(35% 45% at 90% 0%, rgba(143,123,255,.14), transparent 70%); }
        .app > * { position: relative; z-index: 1; }
        a { color: ${C.violet}; }
        .wrap { max-width: 760px; margin: 0 auto; padding: 0 16px; }
        .lbl { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: ${C.sub}; margin-bottom: 6px; font-weight: 600; }
        .row { display: flex; justify-content: space-between; gap: 12px; font-family: ${mono}; font-size: 14px; padding: 5px 0; }
        .note { margin-top: 10px; font-size: 13px; line-height: 1.5; color: ${C.sub}; }
        .hair { border-top: 1px solid ${C.line}; }
        h1, h2, h3, .display { font-family: ${display}; }

        /* buttons */
        .btn { border: none; cursor: pointer; font-weight: 600; font-family: 'Inter', sans-serif; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
        .btn:disabled { cursor: not-allowed; opacity: .45; }
        .btn-accent { background: ${C.lime}; color: ${C.limeInk}; padding: 14px 24px; border-radius: 14px; font-size: 15px; }
        .btn-primary { background: ${C.ink}; color: ${C.bg}; padding: 13px 22px; border-radius: 14px; font-size: 15px; }
        .btn-ghost { background: transparent; color: ${C.ink}; border: 1px solid ${C.line2}; padding: 12px 20px; border-radius: 14px; font-size: 14px; }
        .btn-ghost:hover:not(:disabled) { border-color: ${C.sub}; }
        .btn-block { width: 100%; }
        .lift { transition: transform .2s cubic-bezier(.2,.7,.3,1), box-shadow .2s, background .2s, border-color .2s, opacity .2s; }
        .lift:hover:not(:disabled) { transform: translateY(-2px); }
        .btn-accent.lift:hover:not(:disabled) { box-shadow: 0 10px 30px rgba(200,245,66,.25); }
        .lift:active:not(:disabled) { transform: translateY(0); }
        input:focus-visible, button:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible, label:focus-within { outline: 2px solid ${C.lime}; outline-offset: 2px; }

        /* inputs */
        .in { width: 100%; background: ${C.surface2}; border: 1px solid ${C.line}; border-radius: 12px; padding: 12px 13px; font-family: 'Inter', sans-serif; font-size: 14.5px; color: ${C.ink}; outline: none; transition: border-color .2s, background .2s; }
        .in::placeholder { color: #5E6672; }
        .in:hover { border-color: ${C.line2}; }
        .in:focus { border-color: ${C.lime}; background: #1C2027; }
        textarea.in { resize: vertical; min-height: 76px; line-height: 1.5; }
        select.in { appearance: none; background-image: linear-gradient(45deg, transparent 50%, ${C.sub} 50%), linear-gradient(135deg, ${C.sub} 50%, transparent 50%); background-position: calc(100% - 18px) 52%, calc(100% - 13px) 52%; background-size: 5px 5px; background-repeat: no-repeat; padding-right: 32px; }
        .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
        @media (max-width: 480px) { .fields { grid-template-columns: 1fr; } }

        /* nav */
        .nav { position: sticky; top: 0; z-index: 20; background: rgba(10,11,13,.72); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border-bottom: 1px solid ${C.line}; }
        .nav-in { max-width: 1040px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; }
        .brand { display: flex; align-items: center; gap: 9px; font-family: ${display}; font-weight: 700; font-size: 18px; letter-spacing: -0.02em; color: ${C.ink}; background: none; border: none; cursor: pointer; padding: 0; }
        .nav-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .nav-link { background: none; border: none; color: ${C.sub}; font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; padding: 8px 10px; border-radius: 10px; }
        .nav-link:hover { color: ${C.ink}; background: ${C.surface2}; }
        .badge { font-family: ${mono}; font-size: 11px; border: 1px solid ${C.line2}; border-radius: 999px; padding: 4px 10px; color: ${C.sub}; white-space: nowrap; }
        .badge.pro { color: ${C.limeInk}; background: ${C.lime}; border-color: ${C.lime}; font-weight: 700; }
        @media (max-width: 560px) { .hide-sm { display: none !important; } }

        /* hero + scan */
        .hero { padding: 56px 0 18px; text-align: center; }
        .eyebrow { display: inline-flex; align-items: center; gap: 8px; font-family: ${mono}; font-size: 11.5px; letter-spacing: .06em; color: ${C.lime}; border: 1px solid rgba(200,245,66,.3); background: rgba(200,245,66,.06); padding: 6px 12px; border-radius: 999px; }
        .eyebrow i { width: 6px; height: 6px; border-radius: 99px; background: ${C.lime}; box-shadow: 0 0 10px ${C.lime}; animation: pulse 1.8s infinite; }
        .hero h1 { font-weight: 700; font-size: 50px; line-height: 1.02; letter-spacing: -0.035em; margin: 18px auto 14px; max-width: 640px; }
        .hero h1 em { font-style: normal; color: ${C.lime}; }
        .hero p { font-size: 16.5px; line-height: 1.6; color: ${C.sub}; max-width: 540px; margin: 0 auto; }
        @media (max-width: 560px) { .hero { padding-top: 36px; } .hero h1 { font-size: 36px; } .hero p { font-size: 15px; } }
        .seg { display: inline-flex; gap: 4px; padding: 4px; background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 14px; margin-top: 26px; }
        .seg button { background: none; border: none; color: ${C.sub}; font: inherit; font-size: 14px; font-weight: 600; padding: 9px 16px; border-radius: 10px; cursor: pointer; transition: background .2s, color .2s; white-space: nowrap; }
        .seg button:hover { color: ${C.ink}; }
        .seg button.on { background: ${C.ink}; color: ${C.bg}; }
        @media (max-width: 400px) { .seg button { padding: 9px 11px; font-size: 13px; } }
        .scan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 12px; margin-top: 22px; text-align: left; }
        .scan { background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 20px; padding: 18px; transition: border-color .2s, transform .2s; }
        .scan:hover { border-color: ${C.line2}; }
        .scan-h { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
        .scan-ic { width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex: none; }
        .scan-ic.lime { background: rgba(200,245,66,.12); color: ${C.lime}; }
        .scan-ic.violet { background: rgba(143,123,255,.14); color: ${C.violet}; }
        .scan-t { font-family: ${display}; font-weight: 700; font-size: 17px; }
        .scan-s { font-size: 12.5px; color: ${C.sub}; margin-top: 2px; }
        .link-row { display: flex; gap: 8px; }
        .go { width: 48px; flex: none; padding: 0; border-radius: 12px; }
        .photo-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .pbtn { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; border-radius: 12px; border: 1px solid ${C.line2}; background: ${C.surface2}; color: ${C.ink}; font-weight: 600; font-size: 14px; cursor: pointer; transition: border-color .2s, background .2s; }
        .pbtn:hover { border-color: ${C.violet}; }
        .pbtn.fill { background: ${C.violet}; border-color: ${C.violet}; color: #0B0A14; }
        .pbtn.off { opacity: .45; pointer-events: none; }
        .paste { margin-top: 12px; background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 16px; padding: 4px 14px; text-align: left; }
        .paste summary { cursor: pointer; list-style: none; padding: 11px 0; font-size: 14px; font-weight: 600; color: ${C.sub}; display: flex; justify-content: space-between; }
        .paste summary::-webkit-details-marker { display: none; }
        .paste summary::after { content: "+"; font-size: 18px; line-height: 1; }
        .paste[open] summary::after { content: "–"; }
        .paste[open] { padding-bottom: 14px; }
        .read-row { display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; text-align: left; }

        /* panel (details + results) */
        .panel { background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 22px; margin-top: 16px; overflow: hidden; }
        .panel-h { display: flex; align-items: center; gap: 10px; padding: 18px 20px 0; font-family: ${display}; font-weight: 700; font-size: 17px; }
        .step { width: 24px; height: 24px; border-radius: 8px; background: ${C.surface2}; border: 1px solid ${C.line2}; color: ${C.sub}; font-family: ${mono}; font-size: 12px; display: flex; align-items: center; justify-content: center; }
        .panel-b { padding: 6px 20px 22px; }
        .run { margin-top: 16px; font-size: 16px; padding: 16px 24px; }
        .ext { margin-bottom: 4px; padding: 11px 14px; border-radius: 14px; font-size: 13px; text-align: left; }

        /* results */
        .res { padding: 20px; border-top: 1px solid ${C.line}; }
        .res-hero { background: ${C.surface2}; border: 1px solid ${C.line}; border-radius: 18px; padding: 18px; }
        .res-top { display: flex; align-items: center; gap: 18px 26px; flex-wrap: wrap; }
        .res-num { flex: 1 1 200px; min-width: 0; }
        .big-num { font-family: ${display}; font-weight: 700; font-size: 44px; line-height: 1.05; letter-spacing: -0.03em; color: ${C.lime}; margin: 2px 0 4px; }
        .locked-num { filter: blur(7px); user-select: none; }
        .gauge { display: flex; flex-direction: column; align-items: center; flex: none; }
        .gauge-arc { transition: stroke-dasharray 1s cubic-bezier(.2,.7,.3,1); }
        .gauge-val { font-family: ${display}; font-weight: 700; font-size: 30px; line-height: 1; margin-top: -4px; letter-spacing: -0.02em; }
        .gauge-val small { font-size: 13px; color: ${C.sub}; font-weight: 500; margin-left: 2px; }
        .vr-badge { display: inline-block; font-family: ${display}; font-weight: 700; font-size: 18px; letter-spacing: -.01em; padding: 5px 14px; border-radius: 999px; border: 1.5px solid; background: rgba(255,255,255,.02); }
        .vr-chips { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; }
        .vr-pill { display: inline-block; font-family: ${mono}; font-size: 11px; font-weight: 600; padding: 4px 10px; border: 1px solid ${C.line2}; border-radius: 999px; color: ${C.ink}; white-space: nowrap; }
        .chip { display: inline-flex; align-items: center; font-size: 12.5px; padding: 5px 11px; border-radius: 10px; background: ${C.bg}; border: 1px solid ${C.line}; color: ${C.ink}; }
        .pr { position: relative; margin-top: 18px; padding: 26px 0 0; }
        .pr-track { position: relative; height: 10px; border-radius: 99px; background: ${C.bg}; border: 1px solid ${C.line}; }
        .pr-band { position: absolute; top: -1px; bottom: -1px; border-radius: 99px; background: linear-gradient(90deg, rgba(61,220,151,.55), rgba(143,123,255,.55)); }
        .pr-tick { position: absolute; top: -4px; width: 2px; height: 16px; margin-left: -1px; background: ${C.ink}; opacity: .55; border-radius: 2px; }
        .pr-dot { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 99px; border: 2px solid ${C.bg}; }
        .pr-dot.ask { background: ${C.ink}; }
        .pr-dot.off { background: ${C.lime}; box-shadow: 0 0 0 4px rgba(200,245,66,.18); }
        .pr-tag { position: absolute; transform: translateX(-50%); font-family: ${mono}; font-size: 11px; white-space: nowrap; }
        .pr-tag.ask { top: 4px; color: ${C.ink}; }
        .pr-tag.off { top: 44px; color: ${C.lime}; font-weight: 600; }
        .pr-scale { display: flex; margin-top: 30px; font-family: ${mono}; font-size: 11px; color: ${C.sub}; }
        .pr-key { display: inline-block; width: 18px; height: 6px; border-radius: 99px; margin-right: 7px; vertical-align: middle; background: linear-gradient(90deg, rgba(61,220,151,.7), rgba(143,123,255,.7)); }
        .offer { margin-top: 14px; background: ${C.surface2}; border: 1px solid ${C.line}; border-radius: 18px; padding: 16px; }
        .offer-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 4px; }
        .offer-cell { background: ${C.bg}; border: 1px solid ${C.line}; border-radius: 14px; padding: 12px 8px; text-align: center; }
        .offer-cell.on { border-color: ${C.lime}; background: rgba(200,245,66,.07); }
        .offer-cell.on .vnum { color: ${C.lime}; }
        .msg { margin-top: 12px; border: 1px dashed ${C.line2}; border-radius: 14px; padding: 14px; font-size: 14px; line-height: 1.55; background: ${C.bg}; }
        .vgrid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
        .vcell { background: ${C.bg}; border: 1px solid ${C.line}; border-radius: 14px; padding: 12px 14px; transition: border-color .2s; }
        .vcell:hover { border-color: ${C.line2}; }
        .vnum { font-family: ${mono}; font-weight: 600; font-size: 18px; }
        .comp { display: flex; justify-content: space-between; gap: 12px; padding: 10px 4px; border-bottom: 1px solid ${C.line}; font-size: 13px; }
        .comp:last-child { border-bottom: none; }
        .pill { font-family: ${mono}; font-size: 10px; margin-left: 6px; padding: 1px 7px; border: 1px solid ${C.line2}; border-radius: 999px; color: ${C.sub}; text-transform: uppercase; white-space: nowrap; }
        .pill-red { border-color: ${C.red}; color: ${C.red}; }
        .pill-lime { border-color: rgba(200,245,66,.5); color: ${C.lime}; }
        .coll { border: 1px solid ${C.line}; border-radius: 16px; background: ${C.surface2}; margin-top: 10px; overflow: hidden; transition: border-color .2s; }
        .coll:hover { border-color: ${C.line2}; }
        .coll-head { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; background: none; border: none; padding: 15px 16px; font-family: ${display}; font-weight: 700; font-size: 16px; color: ${C.ink}; cursor: pointer; text-align: left; }
        .coll-chev { font-size: 22px; line-height: 1; color: ${C.sub}; transition: transform .2s; flex: none; }
        .coll-chev.open { transform: rotate(90deg); }
        .coll-body { padding: 0 16px 16px; animation: collIn .25s cubic-bezier(.2,.7,.3,1); }
        @keyframes collIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
        .fr { border-left: 3px solid ${C.line2}; border-radius: 10px; background: ${C.bg}; padding: 11px 12px; margin-top: 8px; }
        .fr-head { display: flex; gap: 8px; align-items: flex-start; width: 100%; background: none; border: none; padding: 0; font: inherit; font-weight: 600; font-size: 14px; line-height: 1.4; text-align: left; color: ${C.ink}; cursor: pointer; }
        .chk-bar { height: 6px; border-radius: 99px; background: ${C.bg}; overflow: hidden; margin-bottom: 4px; }
        .chk-bar i { display: block; height: 100%; background: ${C.lime}; border-radius: 99px; transition: width .4s cubic-bezier(.2,.7,.3,1); }
        .chk { display: flex; gap: 11px; align-items: flex-start; padding: 11px 2px; border-bottom: 1px solid ${C.line}; cursor: pointer; font-size: 14px; line-height: 1.4; }
        .chk:last-child { border-bottom: none; }
        .chk input { margin-top: 1px; width: 18px; height: 18px; accent-color: ${C.lime}; flex: none; cursor: pointer; }
        .chk.done .t { text-decoration: line-through; color: ${C.sub}; }
        .verdict-card { background: ${C.surface2}; border: 1px solid ${C.line}; border-radius: 18px; padding: 18px; }
        .maxbid { margin-top: 14px; text-align: center; padding: 14px 8px; background: ${C.bg}; border: 1px solid ${C.line}; border-radius: 14px; }

        /* photos */
        .thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
        .thumb { position: relative; width: 60px; height: 60px; border-radius: 12px; overflow: hidden; border: 1px solid ${C.line2}; }
        .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .thumb button { position: absolute; top: 3px; right: 3px; width: 20px; height: 20px; border-radius: 99px; border: none; background: rgba(10,11,13,.8); color: #fff; font-size: 14px; line-height: 1; cursor: pointer; padding: 0; }
        .thumb button:hover { background: ${C.red}; }

        /* locked preview */
        .lk-in { animation: lkIn .5s cubic-bezier(.2,.7,.3,1); }
        @keyframes lkIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        .lk-wrap { position: relative; margin-top: 12px; min-height: 410px; }
        .lk-ghost { transition: filter .6s, opacity .6s; }
        .lk-ghost.on { filter: blur(6px); opacity: .45; pointer-events: none; user-select: none; }
        .lk-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 15px 14px; border: 1px solid ${C.line}; border-radius: 14px; background: ${C.surface2}; margin-top: 10px; }
        .lk-bar { height: 12px; border-radius: 6px; background: linear-gradient(90deg, #22262E 0%, #2F343E 50%, #22262E 100%); background-size: 200% 100%; animation: lkShimmer 1.3s linear infinite; }
        @keyframes lkShimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
        .lk-panel { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 6px; animation: lkIn .45s cubic-bezier(.2,.7,.3,1); }
        .lk-card { background: ${C.surface}; border: 1px solid ${C.line2}; border-radius: 20px; box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(200,245,66,.08); padding: 20px; width: 100%; max-width: 390px; }
        .perks { margin: 12px 0 16px; padding: 0; list-style: none; font-size: 13.5px; line-height: 1.5; }
        .perks li { padding-left: 24px; position: relative; margin-top: 7px; }
        .perks li::before { content: "✓"; position: absolute; left: 0; top: 0; color: ${C.lime}; font-weight: 700; }

        /* how it works / pricing / footer */
        .sec { padding: 64px 0 8px; }
        .sec h2 { font-weight: 700; font-size: 32px; letter-spacing: -0.025em; text-align: center; margin: 0 0 8px; }
        .sec .sub { text-align: center; color: ${C.sub}; font-size: 15px; margin: 0 auto 26px; max-width: 480px; line-height: 1.55; }
        .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        @media (max-width: 720px) { .steps { grid-template-columns: 1fr; } }
        .stepc { background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 20px; padding: 20px; transition: border-color .2s, transform .2s; }
        .stepc:hover { border-color: ${C.line2}; transform: translateY(-3px); }
        .stepc .n { font-family: ${mono}; font-size: 12px; color: ${C.lime}; }
        .stepc .t { font-family: ${display}; font-weight: 700; font-size: 18px; margin: 10px 0 6px; }
        .stepc .d { font-size: 13.5px; color: ${C.sub}; line-height: 1.55; }
        .plans { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        @media (max-width: 600px) { .plans { grid-template-columns: 1fr; } }
        .plan { background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 22px; padding: 24px; position: relative; transition: transform .2s; }
        .plan:hover { transform: translateY(-3px); }
        .plan.pro { border-color: rgba(200,245,66,.55); box-shadow: 0 0 0 1px rgba(200,245,66,.12), 0 20px 60px rgba(200,245,66,.06); }
        .plan .price { font-family: ${display}; font-weight: 700; font-size: 40px; letter-spacing: -0.03em; margin: 8px 0 12px; }
        .plan ul { margin: 0; padding: 0; list-style: none; font-size: 14px; line-height: 1.5; }
        .plan li { padding-left: 24px; position: relative; margin-top: 8px; }
        .plan li::before { content: "✓"; position: absolute; left: 0; color: ${C.lime}; font-weight: 700; }
        .tag { position: absolute; top: 18px; right: 18px; font-family: ${mono}; font-size: 10.5px; padding: 3px 9px; border-radius: 999px; background: ${C.lime}; color: ${C.limeInk}; font-weight: 700; }
        .footer { border-top: 1px solid ${C.line}; margin-top: 64px; padding: 26px 16px 34px; text-align: center; }

        /* modals */
        .modal-bg { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.6); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); display: flex; align-items: center; justify-content: center; padding: 16px; }
        .modal { background: ${C.surface}; border: 1px solid ${C.line2}; border-radius: 22px; max-width: 400px; width: 100%; padding: 24px; box-shadow: 0 30px 80px rgba(0,0,0,.6); }
        .modal h3 { margin: 0; font-size: 23px; letter-spacing: -0.02em; }

        /* message styles, coach, share, my deals */
        .tones { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
        .tone { background: ${C.bg}; border: 1px solid ${C.line2}; color: ${C.sub}; font: inherit; font-size: 12.5px; font-weight: 600; padding: 7px 12px; border-radius: 999px; cursor: pointer; transition: color .2s, border-color .2s, background .2s; }
        .tone:hover { color: ${C.ink}; }
        .tone.on { color: ${C.limeInk}; background: ${C.lime}; border-color: ${C.lime}; }
        .fu { margin-top: 12px; }
        .fu summary { cursor: pointer; font-size: 13px; font-weight: 600; color: ${C.sub}; list-style: none; }
        .fu summary::-webkit-details-marker { display: none; }
        .fu summary::before { content: "+ "; }
        .fu[open] summary::before { content: "– "; }
        .coach { margin-top: 14px; background: ${C.surface2}; border: 1px solid ${C.line}; border-radius: 18px; padding: 16px; }
        .coach-h { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
        .bubble { margin-top: 12px; padding: 12px 14px; border-radius: 16px; font-size: 14px; line-height: 1.5; }
        .bubble.seller { background: ${C.bg}; border: 1px solid ${C.line}; margin-right: 18%; }
        .bubble.me { background: ${C.bg}; border: 1.5px solid ${C.lime}; margin-left: 6%; }
        .coach-dec { font-family: ${display}; font-weight: 700; font-size: 18px; }
        .share { margin-top: 14px; }
        .share-btn { padding: 9px 14px; font-size: 13px; border-radius: 12px; }
        .deal { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-bottom: 1px solid ${C.line}; border-radius: 10px; transition: background .2s; }
        .deal:last-of-type { border-bottom: none; }
        .deal.on { background: rgba(200,245,66,.05); }
        .deal-pick input { width: 18px; height: 18px; accent-color: ${C.lime}; cursor: pointer; }
        .deal-main { flex: 1; min-width: 0; background: none; border: none; text-align: left; color: ${C.ink}; cursor: pointer; padding: 6px 0; font: inherit; }
        .deal-t { display: block; font-weight: 600; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .deal-s { display: block; font-family: ${mono}; font-size: 11.5px; color: ${C.sub}; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .deal-x { background: none; border: none; color: ${C.sub}; font-size: 20px; cursor: pointer; padding: 4px 8px; border-radius: 8px; }
        .deal-x:hover { color: ${C.red}; background: ${C.surface2}; }
        .cmp { display: grid; gap: 0; margin-top: 14px; border: 1px solid ${C.line}; border-radius: 16px; overflow-x: auto; font-size: 13.5px; }
        .cmp-h, .cmp-l, .cmp-c { padding: 11px 12px; border-bottom: 1px solid ${C.line}; }
        .cmp-h { font-weight: 700; font-family: ${display}; font-size: 14.5px; background: ${C.surface2}; }
        .cmp-l { font-family: ${mono}; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: ${C.sub}; background: ${C.surface2}; }
        .cmp-c.best, .cmp-h.best { background: rgba(200,245,66,.06); }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; scroll-behavior: auto !important; } .lift:hover, .stepc:hover, .plan:hover { transform: none; } }
      ` }} />

      {/* NAV */}
      <nav className="nav">
        <div className="nav-in">
          <button className="brand" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="Lowballer home">
            <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="9" fill={C.lime} />
              <path d="M9 6H23V15L16 26L9 15Z" fill={C.limeInk} />
              <circle cx="16" cy="11" r="1.9" fill={C.lime} />
            </svg>
            <span>lowballer</span>
          </button>
          <div className="nav-right">
            <button className="nav-link hide-sm" onClick={() => scrollTo(howRef)}>How it works</button>
            <button className="nav-link hide-sm" onClick={() => scrollTo(priceRef)}>Pricing</button>
            {!accountLoaded ? (
              <div style={{ fontFamily: mono, fontSize: 11, color: C.sub }}>…</div>
            ) : email ? (
              <>
                <span className={`badge ${pro ? "pro" : ""}`}>{pro ? "PRO" : `${money(unlockPrice)} / result`}</span>
                <span className="hide-sm" style={{ fontSize: 12, color: C.sub, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>
                <button className="btn btn-ghost lift" style={{ padding: "7px 12px", fontSize: 12.5, borderRadius: 10 }} onClick={signOut}>Sign out</button>
              </>
            ) : (
              <button className="btn btn-ghost lift" style={{ padding: "8px 14px", fontSize: 13, borderRadius: 10 }} onClick={() => setShowSignIn(true)}>Sign in</button>
            )}
          </div>
        </div>
      </nav>

      {authNotice && (
        <div style={{ textAlign: "center", fontSize: 13, padding: "10px 20px", background: authNotice.startsWith("Signed in") ? "rgba(61,220,151,.1)" : "rgba(255,181,71,.1)", color: authNotice.startsWith("Signed in") ? C.green : C.amber, borderBottom: `1px solid ${C.line}` }}>
          {authNotice}
          <button onClick={() => setAuthNotice("")} style={{ marginLeft: 10, background: "none", border: "none", color: "inherit", textDecoration: "underline", cursor: "pointer", font: "inherit" }}>dismiss</button>
        </div>
      )}

      <main ref={toolRef} className="wrap">
        {/* HERO + SCAN */}
        <section className="hero">
          <div className="eyebrow"><i />AI deal appraiser · live market comps</div>
          <h1>Know your number <em>before</em> you make the offer.</h1>
          <p>Drop in a Marketplace link or snap the listing. Lowballer pulls live comps, prices the repairs, and hands you the exact lowball — or max bid — to send.</p>
          <div className="seg" role="tablist" aria-label="What are you buying?">
            {[["car", "Car"], ["item", "Any item"], ["salvage", "Copart lot"]].map(([m, label]) => (
              <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => { setMode(m); resetResults(); setExtractNote(""); }}>
                {label}
              </button>
            ))}
          </div>

          {fromExt && (
            <div className="ext" style={{
              marginTop: 18,
              background: fromExt.confidence === "high" ? "rgba(61,220,151,.08)" : fromExt.confidence === "medium" ? "rgba(255,181,71,.08)" : "rgba(143,123,255,.1)",
              border: `1px solid ${fromExt.confidence === "high" ? "rgba(61,220,151,.3)" : fromExt.confidence === "medium" ? "rgba(255,181,71,.3)" : "rgba(143,123,255,.35)"}`,
            }}>
              <strong>Imported from {fromExt.site}</strong>
              {fromExt.title ? ` — ${fromExt.title.slice(0, 70)}` : ""}
              <div style={{ marginTop: 4, color: C.sub }}>
                {fromExt.confidence === "high"
                  ? "Fields filled from the listing's structured data. Run the appraisal when ready."
                  : fromExt.confidence === "medium"
                  ? "Some fields came from page text — give them a quick check before running."
                  : "Structured data wasn't available, so the listing text came through instead. Hit “Read listing” to have Claude fill the fields."}
              </div>
            </div>
          )}

          <div className="scan-grid">
            {showLink && (
              <div className="scan">
                <div className="scan-h">
                  <div className="scan-ic lime">{Icon.link}</div>
                  <div>
                    <div className="scan-t">Link scan</div>
                    <div className="scan-s">Facebook Marketplace or share link</div>
                  </div>
                </div>
                <div className="link-row">
                  <input
                    className="in"
                    style={{ flex: 1, minWidth: 0 }}
                    value={listingUrl}
                    onChange={(e) => setListingUrl(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") loadFromLink(); }}
                    placeholder="Paste listing link"
                    inputMode="url"
                    disabled={linkScan === "pro_only"}
                  />
                  <button className="btn btn-accent go lift" onClick={() => loadFromLink()} disabled={linkBusy || extracting} aria-label={linkScan === "pro_only" ? "Go Pro" : "Load listing"}>
                    {linkBusy ? "…" : Icon.arrow}
                  </button>
                </div>
                {linkScan === "pro_only" && <div className="note">Pasting a Marketplace link is a Pro feature. Screenshots work on every plan.</div>}
                {linkNote && <div className="note" style={linkNote.warn ? { color: C.amber } : { color: C.green }}>{linkNote.text}</div>}
              </div>
            )}

            <div className="scan">
              <div className="scan-h">
                <div className="scan-ic violet">{Icon.camera}</div>
                <div>
                  <div className="scan-t">Photo scan</div>
                  <div className="scan-s">Listing screenshots or photos · up to {MAX_PHOTOS}</div>
                </div>
              </div>
              <div className="photo-btns">
                <label className={`pbtn ${images.length >= MAX_PHOTOS ? "off" : ""}`}>
                  {Icon.camera} Camera
                  <input type="file" accept="image/*" capture="environment" onChange={onFiles} disabled={images.length >= MAX_PHOTOS} style={{ display: "none" }} />
                </label>
                <label className={`pbtn fill ${images.length >= MAX_PHOTOS ? "off" : ""}`}>
                  {Icon.image} {images.length ? `${images.length}/${MAX_PHOTOS}` : "Gallery"}
                  <input type="file" accept="image/*" multiple onChange={onFiles} disabled={images.length >= MAX_PHOTOS} style={{ display: "none" }} />
                </label>
              </div>
              {images.length > 0 && (
                <div className="thumbs">
                  {images.map((im, i) => (
                    <div key={i} className="thumb">
                      <img src={`data:${im.type};base64,${im.data}`} alt={`Photo ${i + 1}`} />
                      <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => removeImage(i)}>×</button>
                    </div>
                  ))}
                </div>
              )}
              {photoNote && <div className="note" style={{ color: C.amber }}>{photoNote}</div>}
            </div>
          </div>

          <details className="paste" open={pasteOpen} onToggle={(e) => setPasteOpen(e.currentTarget.open)}>
            <summary>Or paste the listing text</summary>
            <textarea className="in" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste the title, price, mileage and description…" />
          </details>

          <div className="read-row">
            <button className="btn btn-primary lift" onClick={() => extract()} disabled={extracting || (!images.length && !pasted.trim())}>
              {extracting ? "Reading listing…" : <>Read listing {Icon.arrow}</>}
            </button>
            <span style={{ fontSize: 12.5, color: C.sub }}>Fills in the details below from your photos or text — free.</span>
          </div>
          {extractNote && <div className="note" style={{ textAlign: "left" }}>{extractNote}</div>}
        </section>

        {/* DETAILS + RESULTS */}
        <section className="panel">
          <div className="panel-h"><span className="step">2</span>{mode === "car" ? "The car" : mode === "item" ? "The item" : "The lot"}</div>
          <div className="panel-b">
            {mode === "car" && (
              <>
                <div className="fields">
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
                <div style={{ marginTop: 10 }}>
                  <textarea className="in" value={car.issues} onChange={setC("issues")} placeholder="Known issues / needed repairs (auto-filled from listing)" />
                </div>
              </>
            )}

            {mode === "item" && (
              <>
                <div className="fields">
                  <input className="in" value={item.name} onChange={setI("name")} placeholder="Item *" />
                  <input className="in" value={item.brand} onChange={setI("brand")} placeholder="Brand" />
                  <input className="in" value={item.asking} onChange={setI("asking")} placeholder="Asking price *" inputMode="numeric" />
                  <select className="in" value={item.condition} onChange={setI("condition")}>
                    <option>new / sealed</option><option>like new</option><option>used - good</option><option>used - fair</option><option>for parts / not working</option>
                  </select>
                </div>
                <div style={{ marginTop: 10 }}>
                  <textarea className="in" value={item.issues} onChange={setI("issues")} placeholder="Issues / missing accessories" />
                </div>
              </>
            )}

            {mode === "salvage" && (
              <>
                <div className="fields">
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
                <div style={{ marginTop: 10 }}>
                  <textarea className="in" value={sal.damage} onChange={setSa("damage")} placeholder="Damage description * — e.g. front end collision, airbags deployed" />
                </div>
                {sal.title === "certificate of destruction" && <div className="note" style={{ color: C.red }}>Certificate of destruction = can never be road-titled in the US. Parts value only.</div>}
              </>
            )}

            <button className="btn btn-accent btn-block lift run" onClick={mode === "car" ? analyzeCar : mode === "item" ? analyzeItem : analyzeSalvage} disabled={!ready || busy}>
              {runLabel}{!busy && Icon.arrow}
            </button>
            {busy && <div className="note" style={{ animation: "pulse 1.4s infinite" }}>Live web search in progress — 30–90 seconds.</div>}
            {error && <div className="note" style={{ color: C.red }}>{error}</div>}
            {unlockNotice && <div className="note" style={{ color: unlockNotice.warn ? C.amber : C.green, fontWeight: 600 }}>{unlockNotice.text}</div>}
          </div>

          <div ref={resultsRef} style={{ scrollMarginTop: 72 }} />

          {lockedRun && lockedRun.mode === mode && (
            <LockedPreview run={lockedRun} busy={unlockBusy} onUnlock={unlockResult} onPro={goProFromLocked} share={<ShareButton resultId={lockedRun.id} />} />
          )}

          {mode === "car" && vehicle && (
            <VehicleResults
              a={vehicle}
              car={car}
              offer={offer}
              asking={askingCar}
              dealMath={{ baseValue, repairMid, adjusted, margin: marginCar, pct: pctCar, dealer: car.seller === "dealer" }}
              offerPanel={offerPanel}
              share={<ShareButton resultId={resultId} offerTarget={offer?.target} />}
            />
          )}

          {mode === "item" && flip && (
            <div className="res">
              <Label>Resale values</Label>
              <div style={{ marginTop: 8 }}>
                <ValueGrid cells={[["eBay sold (mid)", flip.ebay_sold_mid], ["eBay active avg", flip.ebay_active_avg], ["FB Marketplace typical", flip.fb_typical], ["Retail new", flip.retail_new]]} />
              </div>
              <div className="note" style={{ fontFamily: mono, fontSize: 12 }}>
                eBay sold range {fmt(flip.ebay_sold_low)} – {fmt(flip.ebay_sold_high)} · est. shipping {fmt(flip.ship_est)}
              </div>
              <CompList comps={flip.comps} />
              {flip.notes && <div className="note">{flip.notes}</div>}
              <div style={{ marginTop: 20 }}>
                <Label>Flip economics</Label>
                <Row l="Sell on eBay (after ~13.5% fees + ship)" v={fmt(flipCalc.ebayNet)} />
                <Row l="Sell local on FB (no fees)" v={fmt(flipCalc.fbNet)} />
                <Row l={`Best channel · ${flipCalc.bestChannel}`} v={fmt(flipCalc.bestNet)} bold />
                <Row l="Buy at asking" v={"−" + fmt(askingItem).slice(1)} />
                <Row l="Profit at asking" v={(flipCalc.profitAtAsking >= 0 ? "+" : "−") + fmt(Math.abs(flipCalc.profitAtAsking)).slice(1) + (flipCalc.roiAtAsking != null ? ` (${Math.round(flipCalc.roiAtAsking * 100)}% ROI)` : "")} bold color={flipCalc.profitAtAsking >= 0 ? C.green : C.red} />
              </div>
            </div>
          )}

          {mode === "salvage" && salMarket && (
            <div className="res">
              <Label>Value · clean vs rebuilt</Label>
              <div style={{ marginTop: 8 }}>
                <ValueGrid cells={[["Clean-title value", salMarket.clean_value], ["Rebuilt-title resale", salMarket.rebuilt_resale], ["Similar salvage lots avg", salMarket.salvage_comps_avg], ["Current bid", bid]]} />
              </div>
              <CompList comps={salMarket.comps} />
              {salMarket.notes && <div className="note">{salMarket.notes}</div>}
            </div>
          )}
          {mode === "salvage" && salRepairs && (
            <div className="res">
              <Label>Parts + repairs to rebuild</Label>
              <div style={{ marginTop: 6 }}><RepairList repairs={salRepairs} /></div>
            </div>
          )}
          {mode === "salvage" && salCalc && (
            <div className="res">
              <Label>All-in flip math</Label>
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
          )}

          {verdict && mode !== "car" && (
            <div className="res">
              <div className="verdict-card" style={{ borderLeft: `4px solid ${verdict.color}` }}>
                <div className="display" style={{ fontWeight: 700, fontSize: 28, color: verdict.color, letterSpacing: "-0.02em" }}>{verdict.label}</div>
                <div style={{ marginTop: 6, fontSize: 14, color: C.sub }}>{verdict.note}</div>
                {mode === "salvage" && salCalc && (
                  <div className="maxbid">
                    <Label>Your max bid · hits {fmt(salCalc.targetProfit)} target profit</Label>
                    <div className="big-num" style={{ fontSize: 38 }}>{fmt(salCalc.maxBid)}</div>
                  </div>
                )}
                <ShareButton resultId={resultId} offerTarget={offer?.target} verdictLabel={verdict.label} />
              </div>

              {offerPanel}

              <div className="note" style={{ fontSize: 11 }}>
                Estimates from live web search{mode === "salvage" ? " — auction fees approximated; check state rebuilt-title inspection rules before bidding" : " — verify condition in person before paying"}.
              </div>
            </div>
          )}
        </section>

        <DealsPanel deals={deals} onOpen={(id) => openResult(id)} onRemove={removeDeal} />
      </main>

      {/* HOW IT WORKS */}
      <section ref={howRef} className="sec wrap">
        <h2>Three taps to a lowball.</h2>
        <p className="sub">No VIN, no mechanic, no guessing what to offer.</p>
        <div className="steps">
          {[
            ["01", "Scan it", "Paste a Marketplace link or snap the listing. We read the year, price, mileage and the fine print."],
            ["02", "We dig", "Live comps from real listings, known problems for that exact model, and repair prices from parts sites."],
            ["03", "Lowball with proof", "Your open, target and walk-away numbers — plus a message to send the seller that backs them up."],
          ].map(([n, t, d]) => (
            <div key={n} className="stepc">
              <div className="n">{n}</div>
              <div className="t">{t}</div>
              <div className="d">{d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* PRICING */}
      <section ref={priceRef} className="sec wrap">
        <h2>Pay for the answer, not the app.</h2>
        <p className="sub">Every appraisal gives you a free preview. Unlock the one you need, or go unlimited.</p>
        <div className="plans">
          <div className="plan">
            <div className="lbl">Per result</div>
            <div className="price">{money(unlockPrice)}</div>
            <ul>
              <li>One full appraisal</li>
              <li>Free preview before you pay</li>
              <li>Car, any item, or Copart lot</li>
              <li>Your exact offer + seller message</li>
            </ul>
            <div className="note" style={{ fontFamily: mono, fontSize: 12 }}>{pro ? "Included in Pro" : "No account needed"}</div>
          </div>
          <div className="plan pro">
            <span className="tag">FOR FLIPPERS</span>
            <div className="lbl">Pro</div>
            <div className="price">$30<span style={{ fontSize: 16, color: C.sub, fontWeight: 500 }}>/mo</span></div>
            <ul>
              <li>Unlimited appraisals, never locked</li>
              <li>All three modes</li>
              <li>One good lowball pays for months</li>
            </ul>
            <button className="btn btn-accent btn-block lift" style={{ marginTop: 18 }} disabled={pro || checkoutBusy} onClick={startCheckout}>
              {pro ? "You're Pro ✓" : checkoutBusy ? "Opening checkout…" : "Start membership"}
            </button>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="footer">
        <div className="display" style={{ fontWeight: 700, fontSize: 15 }}>lowballer<span style={{ color: C.sub }}>.org</span></div>
        <div style={{ fontFamily: mono, fontSize: 11, marginTop: 8, color: C.sub }}>
          Appraisals by Claude (Anthropic) with live web search. Estimates only — inspect before you buy.
        </div>
      </footer>

      {/* PAYWALL */}
      {showPaywall && (
        <div className="modal-bg">
          <div className="modal">
            <h3>Go Pro — $30/mo</h3>
            <p style={{ fontSize: 14, color: C.sub, margin: "10px 0 16px", lineHeight: 1.5 }}>
              Unlimited appraisals across all three modes. Cancel anytime from your Stripe receipt email.
            </p>
            <button className="btn btn-accent btn-block lift" disabled={checkoutBusy} onClick={startCheckout}>
              {checkoutBusy ? "Opening checkout…" : "Continue to secure checkout"}
            </button>
            <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={() => setShowPaywall(false)}>Not now</button>
          </div>
        </div>
      )}

      {/* SIGN IN */}
      {showSignIn && (
        <div className="modal-bg">
          <div className="modal">
            {signInSent ? (
              <>
                <h3>Check your email</h3>
                <p style={{ fontSize: 14, color: C.sub, margin: "10px 0 16px", lineHeight: 1.5 }}>
                  We sent a sign-in link to <strong style={{ color: C.ink }}>{signInEmail.trim()}</strong>. It expires in 15 minutes.
                </p>
                <button className="btn btn-ghost btn-block" onClick={closeSignIn}>Close</button>
              </>
            ) : (
              <>
                <h3>Sign in</h3>
                <p style={{ fontSize: 14, color: C.sub, margin: "10px 0 16px", lineHeight: 1.5 }}>
                  No password — we'll email you a link. Your Pro status follows your account everywhere, incognito included.
                </p>
                <input
                  className="in" type="email" placeholder="you@example.com" value={signInEmail}
                  onChange={(e) => setSignInEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && signInEmail.trim() && !signInBusy) sendSignInLink(); }}
                  style={{ marginBottom: 12 }}
                />
                <button className="btn btn-accent btn-block lift" disabled={signInBusy || !signInEmail.trim()} onClick={sendSignInLink}>
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
