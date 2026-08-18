// No popup is set, so clicking the toolbar icon fires this instead.
// Just relay it to the widget in the active tab — the widget owns all state.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_WIDGET" }).catch(() => {});
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-pause") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PAUSE" }).catch(() => {});
  });
});
