// This service worker is the central controller for the extension.

const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';
let recording = false;
let recordingTabId = null;
let offscreenPort = null; // Port for persistent connection to offscreen doc
let chunkCounter = 0;

// Function to broadcast state changes to any interested popups
function broadcastState() {
    chrome.runtime.sendMessage({
        type: 'state-update',
        target: 'popup',
        isRecording: recording
    }).catch(err => {
        if (err && !err.message.includes("Could not establish connection")) {
            console.error("Broadcast error:", err);
        }
    });
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.target !== 'background') return true;

    switch (request.type) {
        case 'start-recording':
            handleStartRecording(sendResponse);
            break;
        case 'stop-recording':
            handleStopRecording(sendResponse);
            break;
        case 'get-status':
            sendResponse({ isRecording: recording });
            break;
    }
    return true;
});

async function handleStartRecording(sendResponse) {
    if (recording) {
        sendResponse({ status: 'error', message: 'Recording is already active.' });
        return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes("meet.google.com")) {
        sendResponse({ status: 'error', message: 'Navigate to a Meet tab to start.' });
        return;
    }

    recordingTabId = tab.id;
    recording = true;
    chunkCounter = 0;
    broadcastState();

    await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
    
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: recordingTabId });
    
    // Send the streamId to the offscreen document to start recording
    offscreenPort.postMessage({ type: 'start-recording', streamId: streamId });

    chrome.action.setIcon({ path: { '128': 'icons/icon128-recording.png' }, tabId: recordingTabId });
    chrome.action.setTitle({ title: 'Stop Recording', tabId: recordingTabId });
    sendResponse({ status: 'recording' });
}

async function handleStopRecording(sendResponse) {
    if (!recording || !offscreenPort) {
        sendResponse({ status: 'error', message: 'No recording to stop.' });
        return;
    }
    
    offscreenPort.postMessage({ type: 'stop-recording' });
    
    recording = false;
    broadcastState();

    if (recordingTabId) {
        chrome.action.setIcon({ path: { '128': 'icons/icon128.png' }, tabId: recordingTabId });
        chrome.action.setTitle({ title: 'Meet Audio Transcriber', tabId: recordingTabId });
    }
    recordingTabId = null;
    offscreenPort = null; // The port will be disconnected by the offscreen doc
    
    sendResponse({ status: 'stopped' });
}

function saveAudioChunk(dataUrl) {
    chunkCounter++;
    const filename = `meet_recording_chunk_${chunkCounter}.mp3`;
    chrome.downloads.download({ url: dataUrl, filename: filename });
    chrome.runtime.sendMessage({
        type: 'log-update',
        target: 'popup',
        message: `Saved ${filename}`
    }).catch(() => {});
}

async function setupOffscreenDocument(path) {
    const existingContexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existingContexts.length > 0) {
        // If it exists, we still need to establish a connection
        console.log("Offscreen document already exists.");
    } else {
        await chrome.offscreen.createDocument({
            url: path,
            reasons: ['USER_MEDIA'],
            justification: 'Required to record tab audio and process it.',
        });
    }
}

// Listen for connections from the offscreen document
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'offscreen') {
        offscreenPort = port;
        console.log('Connected to offscreen document.');

        // Handle messages from the offscreen document (e.g., audio chunks)
        offscreenPort.onMessage.addListener((msg) => {
            if (msg.type === 'audio-chunk') {
                saveAudioChunk(msg.data);
            }
        });
        
        // When the offscreen document closes, this will fire
        offscreenPort.onDisconnect.addListener(() => {
            console.log('Offscreen document disconnected.');
            offscreenPort = null;
            if (recording) {
                // If we were recording, it means the offscreen doc closed unexpectedly.
                handleStopRecording(() => {});
            }
        });
    }
});
