importScripts('config.js', 'auth.js');

// Background Supabase token refresh via alarms
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('sb-token-refresh', { periodInMinutes: 30 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('sb-token-refresh', { periodInMinutes: 30 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sb-token-refresh') {
    await ConcizeAuth.maybeRefresh();
  }
});

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target === "service-worker") {
    switch (message.type) {
      case "request-recording":
        try {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });

          if (
            !tab ||
            tab.url.startsWith("chrome://") ||
            tab.url.startsWith("chrome-extension://")
          ) {
            chrome.runtime.sendMessage({
              type: "recording-error",
              target: "offscreen",
              error:
                "Cannot record Chrome system pages. Please try on a regular webpage.",
            });
            return;
          }

          // Ensure we have access to the tab
          await chrome.tabs.update(tab.id, {});

          const streamId = await chrome.tabCapture.getMediaStreamId({
            targetTabId: tab.id,
          });

          chrome.runtime.sendMessage({
            type: "start-recording",
            target: "offscreen",
            data: streamId,
          });

          chrome.action.setIcon({ path: "/icons/recording.png" });
        } catch (error) {
          chrome.runtime.sendMessage({
            type: "recording-error",
            target: "offscreen",
            error: error.message,
          });
        }
        break;

      case "recording-stopped":
        chrome.action.setIcon({ path: "icons/not-recording.png" });
        {
          const existingContexts = await chrome.runtime.getContexts({});
          const offscreenDocument = existingContexts.find(
              (c) => c.contextType === 'OFFSCREEN_DOCUMENT'
          );
          if (offscreenDocument) {
              await chrome.offscreen.closeDocument();
          }
        }
        break;

      // Held here rather than in the popup because the popup is gone by the time most of these
      // arrive. Read and cleared the next time one opens.
      case "recording-failed":
        chrome.storage.local.set({ lastRecordingError: message.error });
        chrome.action.setIcon({ path: "icons/not-recording.png" });
        break;

      case "update-icon":
        chrome.action.setIcon({
          path: message.recording
            ? "icons/recording.png"
            : "icons/not-recording.png",
        });
        break;
    }
  }
});
