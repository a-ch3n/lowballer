import Script from "next/script";

export const metadata = {
  title: "Lowballer.org — Know your number before you make the offer",
  description:
    "Screenshot any Facebook Marketplace listing or Copart lot. Lowballer pulls live comps, prices the repairs, and hands you the exact lowball offer or max bid to make.",
};

export const viewport = {
  themeColor: "#F7F6F2",
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
        <Script
          id="meta-pixel"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init', '2575327482903637');fbq('track', 'PageView');`,
          }}
        />
      </head>
      <body style={{ margin: 0 }}>
        <noscript>
          <img
            height="1"
            width="1"
            alt=""
            style={{ display: "none" }}
            src="https://www.facebook.com/tr?id=2575327482903637&ev=PageView&noscript=1"
          />
        </noscript>
        {children}
      </body>
    </html>
  );
}
