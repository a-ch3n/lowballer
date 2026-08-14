const DEFAULT_BASE = "https://lowballer.org";
const detail = document.getElementById("detail");
const go = document.getElementById("go");
const base = document.getElementById("base");
const conf = document.getElementById("conf");
const layers = document.getElementById("layers");

chrome.storage.sync.get({ baseUrl: DEFAULT_BASE }).then(({ baseUrl }) => {
  base.value = baseUrl;
});
base.addEventListener("change", () => {
  chrome.storage.sync.set({
    baseUrl: base.value.replace(/\/$/, "") || DEFAULT_BASE,
  });
});

const MODE_LABEL = { car: "Car", item: "Item", salvage: "Salvage lot" };
const CONF_TEXT = {
  high: ["Clean read", "Structured data found — fields should be accurate."],
  medium: ["Partial read", "Some fields came from page text. Double-check them."],
  low: ["Text-only read", "Structured data missed. Claude will parse the raw text."],
};

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  chrome.tabs.sendMessage(tab.id, { type: "GET_PAYLOAD" }, (payload) => {
    if (chrome.runtime.lastError || !payload) {
      detail.textContent =
        "No listing detected. Open a Marketplace, Craigslist, eBay, OfferUp, or Copart listing.";
      return;
    }

    const price = payload.price ? ` · $${Number(payload.price).toLocaleString()}` : "";
    detail.textContent = `${MODE_LABEL[payload.mode] || "Listing"}: ${
      payload.title || payload.site
    }${price}`;

    const [label, help] = CONF_TEXT[payload.confidence] || CONF_TEXT.low;
    conf.className = `conf conf-${payload.confidence}`;
    conf.innerHTML = `<b>${label}</b>${help}`;

    // Show which layer produced each field — a site redesign becomes visible
    // here immediately instead of failing silently.
    const src = payload.sources || {};
    const rows = ["title", "price", "description", "mileage", "damage"]
      .filter((k) => src[k])
      .map((k) => `<span>${k}</span><em>${src[k]}</em>`)
      .join("");
    layers.innerHTML = rows || "";

    go.disabled = false;
    go.addEventListener("click", () => {
      chrome.tabs.sendMessage(tab.id, { type: "TRIGGER" }, () => window.close());
    });
  });
})();
