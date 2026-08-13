/* Service worker: opens Lowballer in a new tab with the payload in the fragment. */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "OPEN_LOWBALLER" && msg.url) {
    chrome.tabs.create({
      url: msg.url,
      index: sender.tab ? sender.tab.index + 1 : undefined,
    });
  }
});
