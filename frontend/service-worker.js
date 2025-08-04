// service-worker.js
const BACKEND_API_URL = 'http://localhost:3000/api/audios/';
const START_MEETING_API_URL = 'http://localhost:3000/api/meeting/start';
const STOP_MEETING_API_URL = 'http://localhost:3000/api/meeting/stop';
const MEET_URL_PATTERN = 'https://meet.google.com/*';
let workerStatus = 'stopped';
let activeMeetTabId = null; // Store the ID of the Google Meet tab.
let isRecording = false; // Tracks if recording is active.
let isStopping = false; // Tracks if a stop request has been initiated.

// A simple exponential backoff retry function for API calls.
const fetchWithRetry = async (url, options, retries = 3) => {
    let delay = 1000;
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                const errorBody = await response.text();
                console.error('Backend error response:', errorBody);
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response;
        } catch (error) {
            console.error(`Attempt ${i + 1} failed: ${error}. Retrying in ${delay}ms...`);
            if (i < retries - 1) {
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
            } else {
                throw error;
            }
        }
    }
};

// Function to ensure the offscreen document is open and ready.
async function getOffscreenDocument() {
    const offscreenUrl = chrome.runtime.getURL('offscreen.html');
    const existingOffscreen = await chrome.tabs.query({ url: offscreenUrl });
    if (!existingOffscreen.length) {
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['USER_MEDIA'],
            justification: 'To handle audio recording from the microphone.',
        });
    }
}

// Function to close the offscreen document.
async function closeOffscreenDocument() {
    const offscreenUrl = chrome.runtime.getURL('offscreen.html');
    const existingOffscreen = await chrome.tabs.query({ url: offscreenUrl });
    if (existingOffscreen.length) {
        await chrome.offscreen.closeDocument();
    }
}

// Listen for messages from the popup script or offscreen document.
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    switch (message.action) {
        case 'startRecording':
            chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
                if (tabs[0] && tabs[0].url.startsWith('https://meet.google.com/')) {
                    if (isRecording) {
                        console.log('Recording is already in progress.');
                        return;
                    }

                    try {
                        console.log('Starting backend worker...');
                        await fetchWithRetry(START_MEETING_API_URL, {
                            method: 'POST'
                        });
                        workerStatus = 'running';
                        isRecording = true;
                        isStopping = false;
                        activeMeetTabId = tabs[0].id;
                        
                        console.log('Service worker received start recording request. Initializing offscreen document...');
                        await getOffscreenDocument();
                        chrome.runtime.sendMessage({ action: 'startRecordingOffscreen' });
                    } catch (error) {
                        console.error('Failed to start backend worker:', error);
                        chrome.runtime.sendMessage({
                            type: 'error',
                            message: 'Failed to start meeting session.'
                        });
                        isRecording = false;
                        workerStatus = 'stopped';
                    }
                } else {
                    console.log('Recording can only be started on a Google Meet page.');
                    chrome.runtime.sendMessage({
                        type: 'error',
                        message: 'Recording can only be started on a Google Meet page.'
                    });
                }
            });
            break;
        case 'stopRecording':
            if (!isRecording) {
                console.log('No recording to stop.');
                return;
            }
            isStopping = true;
            isRecording = false;
            console.log('Service worker received stop recording request. Forwarding to offscreen document...');
            // Forward the message to the offscreen document.
            chrome.runtime.sendMessage({ action: 'stopRecordingOffscreen' });
            break;
        case 'onAudioChunkReady':
            // Only process audio chunks if we are locked to a tab.
            if (activeMeetTabId) {
                console.log('Service worker received audio chunk. Handling upload...');
                // Create a Blob from the ArrayBuffer directly.
                const audioChunkBlob = new Blob([message.audioData.buffer], { type: message.audioData.mimeType });
                await handleAudioUpload(audioChunkBlob);
                
                // If we are stopping, this is the last chunk, so perform cleanup.
                if (isStopping) {
                    console.log('Last chunk received. Stopping backend worker and cleaning up...');
                    await fetchWithRetry(STOP_MEETING_API_URL, {
                        method: 'POST'
                    });
                    await closeOffscreenDocument();
                    workerStatus = 'stopped';
                    activeMeetTabId = null;
                    isStopping = false;
                }
            }
            break;
        case 'getRecordingStatus':
            // Send the current worker status to the popup.
            chrome.runtime.sendMessage({
                type: 'recordingStatus',
                isRecording: isRecording,
                workerStatus: workerStatus
            });
            break;
    }
});

// Listener for tab updates to stop recording if the Meet tab is closed.
chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === activeMeetTabId) {
        console.log('Meet tab was closed. Stopping recording.');
        chrome.runtime.sendMessage({ action: 'stopRecording' });
    }
});

async function handleAudioUpload(audioBlob) {
    if (workerStatus !== 'running') {
        console.error('No active meeting session. Starting one...');
        try {
            await fetchWithRetry(START_MEETING_API_URL, {
                method: 'POST'
            });
            workerStatus = 'running';
        } catch (error) {
            console.error('Failed to start meeting session:', error);
            chrome.runtime.sendMessage({
                type: 'error',
                message: 'Failed to start meeting session. Please try again.'
            });
            return;
        }
    }

    try {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'audio_chunk.webm');
        
        console.log('Sending audio file to backend...');
        const response = await fetchWithRetry(BACKEND_API_URL, {
            method: 'POST',
            body: formData,
        });
        const transcription = await response.json();
        console.log('Backend response:', transcription);
        chrome.runtime.sendMessage({
            type: 'transcriptionResult',
            transcription
        });
    } catch (error) {
        console.error('Failed to send audio to backend:', error);
        chrome.runtime.sendMessage({
            type: 'error',
            message: error.message
        });
        // If we get a 400 error about no meeting session, reset the worker status
        if (error.message.includes('400')) {
            workerStatus = 'stopped';
        }
    }
}
