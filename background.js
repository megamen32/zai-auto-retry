// Toggle state on icon click
chrome.action.onClicked.addListener(async () => {
  const { autoRetryEnabled } = await chrome.storage.local.get('autoRetryEnabled');
  const newState = !autoRetryEnabled; // default false → true on first click
  await chrome.storage.local.set({ autoRetryEnabled: newState });
  updateBadge(newState);
});

// Set initial badge on install / startup
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('autoRetryEnabled', ({ autoRetryEnabled }) => {
    updateBadge(!!autoRetryEnabled);
  });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get('autoRetryEnabled', ({ autoRetryEnabled }) => {
    updateBadge(!!autoRetryEnabled);
  });
});

function updateBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#00AA00' : '#DD0000' });
}