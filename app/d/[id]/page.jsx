import { getShare, shareColor, shareHeadline } from "@/lib/shares";

export const dynamic = "force-dynamic";

const fmt = (n) => (n == null ? "" : "$" + Math.round(n).toLocaleString("en-US"));

export async function generateMetadata({ params }) {
  const s = await getShare(params.id);
  if (!s) return { title: "Lowballer — deal card not found" };
  const title = `${s.title} — ${shareHeadline(s)} | Lowballer`;
  const description = `${s.verdict ? `${s.verdict}. ` : ""}${s.score != null ? `Deal score ${s.score}/100. ` : ""}Paste any listing on Lowballer to get your own lowball number.`;
  return { title, description, openGraph: { title, description }, twitter: { card: "summary_large_image", title, description } };
}

/* Public deal card — what a shared /d/<id> link opens. Teaser-level facts
   only (lib/shares.js); the call to action sends people to run their own. */
export default async function DealCard({ params }) {
  const s = await getShare(params.id);
  const color = s ? shareColor(s) : "#6E92FF";
  return (
    <main style={{ minHeight: "100vh", background: "#0A0B0D", color: "#F2F4F7", fontFamily: "'Inter',system-ui,sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 16px" }}>
      <style dangerouslySetInnerHTML={{ __html: `
        .dc { width: 100%; max-width: 520px; background: #121418; border: 1px solid #22262E; border-radius: 24px; padding: 28px; box-shadow: 0 30px 80px rgba(0,0,0,.5); }
        .dc h1 { font-family: 'Space Grotesk','Inter',sans-serif; font-weight: 700; font-size: 38px; line-height: 1.05; letter-spacing: -0.03em; margin: 12px 0 18px; }
        .dc .pill { display: inline-block; font-size: 14px; font-weight: 600; padding: 6px 14px; border-radius: 999px; border: 1.5px solid #2F343E; margin: 0 8px 8px 0; }
        .dc .cta { display: block; text-align: center; margin-top: 22px; background: #2E5BFF; color: #FFFFFF; font-weight: 700; font-size: 16px; padding: 15px; border-radius: 14px; text-decoration: none; }
        .dc .cta:hover { box-shadow: 0 10px 30px rgba(46,91,255,.25); }
        @media (max-width: 420px) { .dc h1 { font-size: 30px; } }
      ` }} />
      <div className="dc">
        <a href="/" style={{ display: "inline-flex", alignItems: "center", gap: 9, color: "#F2F4F7", textDecoration: "none", fontFamily: "'Space Grotesk','Inter',sans-serif", fontWeight: 700, fontSize: 18 }}>
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="#16181D" stroke="#2F343E" />
            <path d="M9 5H23V15L16 27L9 15Z" fill="#2245C7" />
            <circle cx="16" cy="10" r="1.8" fill="#16181D" />
          </svg>
          lowballer
        </a>
        {s ? (
          <>
            <div style={{ marginTop: 22, color: "#8E96A3", fontSize: 15 }}>{s.title}{s.asking ? ` · asking ${fmt(s.asking)}` : ""}</div>
            <h1 style={{ color: s.pctUnder ? "#6E92FF" : color }}>{shareHeadline(s)}</h1>
            <div>
              {s.verdict && s.pctUnder && <span className="pill" style={{ borderColor: color, color }}>{s.verdict}</span>}
              {s.score != null && <span className="pill">Deal score {s.score}/100</span>}
              {s.flags ? <span className="pill">{s.flags} red flag{s.flags === 1 ? "" : "s"}{s.highFlags ? ` · ${s.highFlags} high` : ""}</span> : null}
            </div>
            <p style={{ color: "#8E96A3", fontSize: 14.5, lineHeight: 1.55, marginTop: 14 }}>
              Someone ran this listing through Lowballer — live comps, repair costs and red flags, turned into an exact offer to send the seller.
            </p>
          </>
        ) : (
          <>
            <h1 style={{ marginTop: 24 }}>This deal card has expired.</h1>
            <p style={{ color: "#8E96A3", fontSize: 14.5 }}>Run your own listing to get your number.</p>
          </>
        )}
        <a className="cta" href="/">Get your own lowball number →</a>
        <div style={{ marginTop: 12, textAlign: "center", fontSize: 12, color: "#8E96A3" }}>Paste a Marketplace link or upload screenshots. Free preview.</div>
      </div>
    </main>
  );
}
