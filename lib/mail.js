/** Sends the sign-in link. Logs to the console instead when RESEND_API_KEY
 *  isn't set, so local dev works without an email provider. */
export async function sendMagicLink(email, url) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[dev] Magic link for ${email}: ${url}`);
    return;
  }

  const from = process.env.EMAIL_FROM || "Lowballer <hello@lowballer.org>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Sign in to Lowballer",
      html: `<p>Click below to sign in — this link expires in 15 minutes.</p><p><a href="${url}">${url}</a></p>`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend error (${res.status}): ${detail || "unknown"}`);
  }
}
