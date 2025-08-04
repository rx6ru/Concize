// service-worker.js
const BACKEND_AUDIO_API_URL = 'http://localhost:3000/api/audios/';
const START_MEETING_API_URL = 'http://localhost:3000/api/meeting/start';
const STOP_MEETING_API_URL = 'http://localhost:3000/api/meeting/stop';
const GET_TRANSCRIPTION_API_URL = 'http://localhost:3000/api/transcription';

let isRecording = false; // Tracks if recording is active.
let isStopping = false; // Tracks if a stop request has been initiated.
let activeTabId = null; // Store the ID of the active tab for locking.
let workerStatus = 'stopped'; // 'stopped', 'starting', 'running'

// A simple exponential backoff retry function for API calls.
const fetchWithRetry = async (url, options, retries = 3) => {
    let delay = 1000;
    for (let i = 0; i < retries; i++) {
        try {
            // Include credentials (cookies) with the request.
            const response = await fetch(url, { ...options, credentials: 'include' });
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

// Function to poll for the jobId cookie.
const waitForJobIdCookie = async (maxAttempts = 10, delayMs = 500) => {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const cookie = await chrome.cookies.get({ url: 'http://localhost:3000', name: 'jobId' });
            if (cookie && cookie.value) {
                console.log(`JobId cookie found after ${i + 1} attempts.`);
                return cookie.value;
            }
        } catch (e) {
            console.warn('Error checking for jobId cookie:', e);
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    throw new Error('JobId cookie not found after multiple attempts.');
};

// Function to ensure the offscreen document is open and ready.
async function getOffscreenDocument() {
    if (!(await chrome.offscreen.hasDocument())) { // Check if document already exists
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['USER_MEDIA'], // We use USER_MEDIA because tabCapture stream is treated similarly
            justification: 'To handle audio recording from the active tab.',
        });
    }
}

// Function to close the offscreen document.
async function closeOffscreenDocument() {
    if (await chrome.offscreen.hasDocument()) { // Check if document exists before closing
        await chrome.offscreen.closeDocument();
        console.log('Offscreen document closed.');
    } else {
        console.log('No offscreen document to close.');
    }
}

// Listen for messages from the popup script or offscreen document.
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    switch (message.action) {
        case 'startRecording':
            if (isRecording) {
                console.log('Recording is already in progress.');
                return;
            }
            // Set workerStatus to 'starting' immediately to prevent re-entry.
            workerStatus = 'starting';
            isRecording = true;
            isStopping = false;

            chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
                if (tabs.length === 0) {
                    console.error('No active tab found.');
                    isRecording = false; // Reset state if no active tab.
                    workerStatus = 'stopped';
                    return;
                }
                activeTabId = tabs[0].id; // Lock recording to this tab.

                console.log('Initiating new meeting session on backend...');
                try {
                    // Send the start meeting request. Browser handles Set-Cookie.
                    const response = await fetchWithRetry(START_MEETING_API_URL, {
                        method: 'POST'
                    });
                    const responseData = await response.json(); // Assuming backend returns JSON with jobId
                    console.log('Meeting session initiated:', responseData.message, 'JobId:', responseData.jobId);

                    // Wait for the jobId cookie to be set
                    await waitForJobIdCookie();
                    await new Promise(resolve => setTimeout(resolve, 200)); // Added small delay

                    console.log('Service worker received start recording request. Initializing offscreen document...');
                    await getOffscreenDocument();

                    // --- CRITICAL CHANGE: Send tabId to offscreen document for capture ---
                    console.log(`Service worker: Instructing offscreen document to capture audio from tabId: ${activeTabId}...`);
                    // Send the tabId to the offscreen document
                    chrome.runtime.sendMessage({ action: 'startRecordingOffscreen', tabId: activeTabId });
                    // --- END CRITICAL CHANGE ---

                    // Inform the popup that recording has started
                    chrome.runtime.sendMessage({ type: 'recordingStatus', isRecording: true, workerStatus: 'running' });
                    workerStatus = 'running'; // Update worker status after successful start.

                } catch (error) {
                    console.error('Failed to start meeting session or offscreen document:', error);
                    chrome.runtime.sendMessage({
                        type: 'error',
                        message: 'Failed to start recording session: ' + error.message
                    });
                    isRecording = false;
                    activeTabId = null;
                    workerStatus = 'stopped'; // Ensure status is reset on failure.
                    // Ensure offscreen document is closed if start fails.
                    await closeOffscreenDocument();
                }
            });
            break;

        case 'stopRecording':
            if (!isRecording && !isStopping) { // Prevent multiple stop calls or stopping when not recording
                console.log('No active recording to stop.');
                return;
            }
            isStopping = true;
            isRecording = false; // Immediately set to false for UI update
            console.log('Service worker received stop recording request. Forwarding to offscreen document...');
            // Inform the popup that recording is stopping for immediate UI update
            chrome.runtime.sendMessage({ type: 'recordingStatus', isRecording: false, workerStatus: 'stopped' });
            // Forward the message to the offscreen document to stop actual recording.
            chrome.runtime.sendMessage({ action: 'stopRecordingOffscreen' });
            break;

        case 'onAudioChunkReady':
            // Only process audio chunks if we are locked to the active tab.
            if (activeTabId) {
                console.log('Service worker received audio chunk. Handling upload...');
                const audioChunkBlob = new Blob([message.audioData.buffer], { type: message.audioData.mimeType });
                await handleAudioUpload(audioChunkBlob);
                
                // If we are stopping, this is the last chunk, so perform final cleanup.
                if (isStopping) {
                    console.log('Last chunk received after stop request. Marking session complete and fetching transcription...');
                    try {
                        // Mark session completion on backend.
                        await fetchWithRetry(STOP_MEETING_API_URL, {
                            method: 'POST'
                        });
                        console.log('Meeting session marked as completed.');

                        // Fetch final transcription.
                        const transcriptionResponse = await fetchWithRetry(GET_TRANSCRIPTION_API_URL, {
                            method: 'GET'
                        });
                        const transcriptionData = await transcriptionResponse.json();
                        console.log('Final transcription received:', transcriptionData);
                        chrome.runtime.sendMessage({
                            type: 'transcriptionResult',
                            transcription: { text: transcriptionData.transcriptionChunks.join('\n') } // Join chunks for display
                        });
                    } catch (error) {
                        console.error('Error during stop cleanup or fetching transcription:', error);
                        chrome.runtime.sendMessage({
                            type: 'error',
                            message: 'Error during stop or transcription fetch: ' + error.message
                        });
                    } finally {
                        // Always perform cleanup regardless of transcription fetch success.
                        await closeOffscreenDocument();
                        activeTabId = null;
                        isStopping = false;
                        workerStatus = 'stopped'; // Final state after stopping.
                        console.log('Recording session fully terminated and cleaned up.');
                    }
                }
            }
            break;

        case 'getRecordingStatus':
            // Send the current recording status to the popup.
            chrome.runtime.sendMessage({
                type: 'recordingStatus',
                isRecording: isRecording,
                workerStatus: workerStatus
            });
            break;
    }
});

// Listener for tab updates to stop recording if the active tab is closed.
chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === activeTabId) {
        console.log('Active tab was closed. Stopping recording.');
        // Trigger the stop recording flow, which handles backend stop and cleanup.
        chrome.runtime.sendMessage({ action: 'stopRecording' });
    }
});

async function handleAudioUpload(audioBlob) {
    try {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'audio_chunk.webm');
        
        console.log('Sending audio file chunk to backend...');
        const response = await fetchWithRetry(BACKEND_AUDIO_API_URL, {
            method: 'POST',
            body: formData,
        });
        const transcription = await response.json();
        console.log('Backend chunk response:', transcription);
        // You might want to update the UI with partial transcriptions here if your backend supports it.
        // For now, we'll wait for the final transcription.
    } catch (error) {
        console.error('Failed to send audio chunk to backend:', error);
        chrome.runtime.sendMessage({
            type: 'error',
            message: 'Failed to send audio chunk: ' + error.message
        });
    }
}
