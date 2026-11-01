import { ImageResponse } from "next/og";
import { getShare, shareColor, shareHeadline } from "@/lib/shares";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Lowballer deal card";

const fmt = (n) => (n == null ? "" : "$" + Math.round(n).toLocaleString("en-US"));

/* The social-preview image for /d/<id> (and the "Save image" button). Only
   teaser-level facts from the share snapshot — see lib/shares.js. */
export default async function Image({ params }) {
  const s = await getShare(params.id);
  const color = s ? shareColor(s) : "#C8F542";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#0A0B0D", color: "#F2F4F7", padding: "64px 72px", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: "#C8F542", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 34, fontWeight: 800, color: "#0A0B0D" }}>L</div>
          <div style={{ fontSize: 34, fontWeight: 700 }}>lowballer</div>
        </div>

        {s ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 34, color: "#8E96A3" }}>{`${s.title}${s.asking ? ` · asking ${fmt(s.asking)}` : ""}`}</div>
            <div style={{ fontSize: 84, fontWeight: 800, letterSpacing: -2, marginTop: 14, color: s.pctUnder ? "#C8F542" : color, display: "flex" }}>
              {shareHeadline(s)}
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 28 }}>
              {s.verdict && s.pctUnder && <div style={{ display: "flex", fontSize: 30, padding: "10px 24px", borderRadius: 999, border: `3px solid ${color}`, color }}>{s.verdict}</div>}
              {s.score != null && <div style={{ display: "flex", fontSize: 30, padding: "10px 24px", borderRadius: 999, border: "3px solid #2F343E" }}>{`Deal score ${s.score}/100`}</div>}
              {s.flags ? <div style={{ display: "flex", fontSize: 30, padding: "10px 24px", borderRadius: 999, border: "3px solid #2F343E" }}>{`${s.flags} red flag${s.flags === 1 ? "" : "s"}`}</div> : null}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", fontSize: 72, fontWeight: 800 }}>Know your number before you make the offer.</div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 28, color: "#8E96A3" }}>
          <div style={{ display: "flex" }}>Get your own lowball number</div>
          <div style={{ display: "flex", color: "#C8F542" }}>lowballer.org</div>
        </div>
      </div>
    ),
    size
  );
}
