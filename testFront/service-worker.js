// Service worker for managing recording state and providing utilities
chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target === "service-worker") {
    switch (message.type) {
      case "get-active-tab-info":
        try {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });

          if (!tab) {
            return { success: false, error: "No active tab found" };
          }

          // Check if we can record this tab
          if (
            tab.url.startsWith("chrome://") ||
            tab.url.startsWith("chrome-extension://") ||
            tab.url.startsWith("about:")
          ) {
            return { success: false, error: "Cannot record Chrome system pages" };
          }

          return { success: true, tab };
        } catch (error) {
          return { success: false, error: error.message };
        }

      case "get-tab-stream-id":
        try {
          const streamId = await chrome.tabCapture.getMediaStreamId({
            targetTabId: message.tabId,
          });
          return { success: true, streamId };
        } catch (error) {
          return { success: false, error: error.message };
        }

      case "update-icon":
        chrome.action.setIcon({
          path: message.recording
            ? "icons/recording.png"
            : "icons/not-recording.png",
        });
        return { success: true };

      case "set-recording-state":
        chrome.storage.local.set({ 
          isRecording: message.isRecording,
          jobId: message.jobId || null
        });
        chrome.action.setIcon({
          path: message.isRecording ? "icons/recording.png" : "icons/not-recording.png",
        });
        return { success: true };
    }
  }
});

// Initialize extension state on startup
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ isRecording: false, jobId: null });
  chrome.action.setIcon({ path: "icons/not-recording.png" });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ isRecording: false, jobId: null });
  chrome.action.setIcon({ path: "icons/not-recording.png" });
});
