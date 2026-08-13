export const metadata = {
  title: "Lowballer.com — Know your number before you make the offer",
  description:
    "Screenshot any Facebook Marketplace listing or Copart lot. Lowballer pulls live comps, prices the repairs, and hands you the exact lowball offer or max bid to make.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
