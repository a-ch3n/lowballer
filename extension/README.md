# Lowballer — "Lowball This" browser extension

Adds a floating **Lowball this** button to listing pages on Facebook Marketplace, Craigslist, eBay, OfferUp, Copart, and IAAI. One click sends the listing to Lowballer.org, prefilled and ready to appraise.

## Why it works this way

This extension reads **only the page the user is already looking at, in their own browser, when they click the button.** It doesn't touch cookies, doesn't make requests to Facebook on anyone's behalf, and doesn't crawl in the background. It's the same text the user can see on screen — the extension just saves them the screenshot-and-paste step.

The listing data travels to Lowballer in the **URL fragment** (`/#lb=…`). Fragments are never transmitted to the server, so the listing text stays client-side until the user runs the appraisal from their own logged-in session. That also means: no CORS setup, no cross-site cookies, no second auth system. The site handles metering and Stripe exactly as it already does.

## How extraction survives site redesigns

Selectors are the **last** resort here, not the first. Extraction runs in five layers, ordered by how stable each source is:

| Layer | Source | Why it's stable |
|---|---|---|
| L1 | JSON-LD (`schema.org`) | Publishers maintain it for Google Search; changes rarely |
| L2 | Meta tags (OpenGraph) | Maintained for link previews; changes rarely |
| L3 | Embedded JSON field names | Backend contract names (`marketplace_listing_title`, `primaryDamage`) survive redesigns that wipe every CSS class |
| L4 | Semantic DOM | `h1`, `[itemprop]`, `[data-testid]` — no generated class names |
| L5 | Visible text + regex | Works as long as a human can read the page |

Fields merge by precedence, and each records **which layer produced it**. Confidence is scored from those sources:

- **high** — title and price came from JSON-LD or meta tags
- **medium** — one stable layer hit, the rest from text
- **low** — text-only read

The visible page text always ships alongside the structured fields, so even a "low" read gives Claude everything it needs to parse the listing. A redesign degrades quality instead of breaking the feature.

The popup shows the confidence badge and a per-field source table, so if Facebook changes something, you see `title: text` instead of `title: embedded` immediately — silent failure becomes visible failure.

## Install (development)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `extension/` folder
4. Click the extension icon → set **Site URL** to `http://localhost:3000` while developing

Then open any supported listing and click the blue button in the bottom-right.

## Supported sites

| Site | Mode | Notes |
|---|---|---|
| Facebook Marketplace | auto-detects car vs item | reads embedded JSON field names, not CSS classes |
| Craigslist | car if in a `/cto/` `/ctd/` `/cta/` section | pulls the attributes block |
| eBay | item | grabs condition |
| OfferUp | auto-detects | |
| Copart | salvage | pulls primary/secondary damage, odometer, title type, current bid |
| IAAI | salvage | basic extraction |

## Files

- `manifest.json` — MV3 manifest, host matches, permissions (`activeTab`, `storage` only)
- `content.js` — site adapters, mode detection, floating button, payload encoding
- `content.css` — button styling with hover lift
- `background.js` — service worker; opens the Lowballer tab
- `popup.html` / `popup.js` — toolbar popup showing what was detected + site URL setting

## Site-side counterpart

`app/page.jsx` reads `#lb=<base64url json>` on mount, decodes it, sets the right mode, prefills price/damage/title, drops the listing text into the paste box, clears the hash, and shows an "Imported from …" banner.

Payload shape (v1):

```json
{
  "v": 2,
  "site": "Copart",
  "url": "https://www.copart.com/lot/12345",
  "mode": "salvage",
  "confidence": "high",
  "title": "2019 HONDA CIVIC EX",
  "price": "4200",
  "description": "…listing description…",
  "rawText": "…visible page text, the safety net…",
  "fields": {
    "year": "2019", "make": "HONDA", "model": "CIVIC",
    "mileage": "62000", "brand": "", "condition": "",
    "damage": "FRONT END, UNDERCARRIAGE",
    "titleType": "SALVAGE CERTIFICATE", "runs": "RUN AND DRIVE"
  },
  "sources": { "title": "jsonld", "price": "embedded", "damage": "embedded" }
}
```

## Maintenance

Because L1–L3 depend on data contracts rather than styling, most site redesigns pass through without a code change. When something does drift, the popup's source table tells you exactly which field dropped to a lower layer — add the new key to `EMBEDDED_KEYS` in `content.js` and you're done. Adding a whole new site usually means nothing but a new `content_scripts.matches` entry, since extraction is generic.

## Before publishing to the Chrome Web Store

- Replace `icons/icon128.png` with a real logo (16/48/128 sizes)
- Write a privacy policy — you must disclose that listing text is sent to lowballer.org for appraisal
- Narrow `host_permissions` in the store listing description; reviewers ask why each match is needed
- $5 one-time developer registration fee; review typically takes a few days
