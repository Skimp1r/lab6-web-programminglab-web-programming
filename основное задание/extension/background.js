chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'open-check-panel' || !message.url) return;

  const target = chrome.runtime.getURL(`panel.html?fileUrl=${encodeURIComponent(message.url)}`);
  chrome.tabs.create({ url: target });
});
