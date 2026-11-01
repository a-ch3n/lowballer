import { Analytics } from "@vercel/analytics/next";

export const metadata = {
  // Absolute URLs for share-card preview images (app/d/[id]/opengraph-image.jsx).
  metadataBase: new URL(process.env.NEXT_PUBLIC_BASE_URL || "https://lowballer.org"),
  title: "Lowballer.org — Know your number before you make the offer",
  description:
    "Screenshot any Facebook Marketplace listing or Copart lot. Lowballer pulls live comps, prices the repairs, and hands you the exact lowball offer or max bid to make.",
};

export const viewport = {
  themeColor: "#0A0B0D",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&family=Space+Grotesk:wght@500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ margin: 0, background: "#0A0B0D", colorScheme: "dark" }}>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
