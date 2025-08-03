// This content script is now much simpler.
// Its primary role is to confirm that the script is running on a meet.google.com page.
// The popup uses this to enable/disable the start button.
// All recording logic has been moved to the background and offscreen scripts.

console.log('Meet Transcriber content script loaded.');

// You can add listeners here for DOM events in the Meet call if needed in the future.
