
// service-worker.js
// This file is now solely responsible for backend communication and state management.
const BACKEND_AUDIO_API_URL = 'http://localhost:3000/api/audios/';
const START_MEETING_API_URL = 'http://localhost:3000/api/meeting/start';
const STOP_MEETING_API_URL = 'http://localhost:3000/api/meeting/stop';
const GET_TRANSCRIPTION_API_URL = 'http://localhost:3000/api/transcription';

let isRecording = false;
let isStopping = false;
let activeTabId = null;
let workerStatus = 'stopped';

// Utility for fetching with exponential backoff retry logic.
const fetchWithRetry = async (url, options, retries = 3) => {
    let delay = 1000;
    for (let i = 0; i < retries; i++) {
        try {
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

// Waits for the backend to set a jobId cookie.
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

// Polls the backend for the final transcription result.
const pollForTranscription = async (maxAttempts = 30, delayMs = 2000) => {
    let delay = delayMs;
    for (let i = 0; i < maxAttempts; i++) {
        console.log(`Polling for transcription (Attempt ${i + 1}/${maxAttempts})...`);
        try {
            const response = await fetchWithRetry(GET_TRANSCRIPTION_API_URL, {
                method: 'GET'
            }, 1);
            const data = await response.json();
            
            if (data && data.status === 'completed' && data.transcriptionChunks) {
                console.log('Transcription is complete!');
                return data;
            } else {
                console.log('Transcription not yet ready. Status:', data.status);
            }
        } catch (error) {
            console.warn('Polling attempt failed:', error);
        }
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    throw new Error('Transcription not ready after multiple polling attempts.');
};

// Creates the offscreen document if it doesn't exist.
async function getOffscreenDocument() {
    if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['USER_MEDIA'],
            justification: 'To handle audio recording from the active tab.',
        });
    }
}

// Closes the offscreen document.
async function closeOffscreenDocument() {
    if (await chrome.offscreen.hasDocument()) {
        await chrome.offscreen.closeDocument();
        console.log('Offscreen document closed.');
    } else {
        console.log('No offscreen document to close.');
    }
}

// Main message listener for the service worker.
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    switch (message.action) {
        // New action: Start the backend session.
        case 'startMeeting':
            if (isRecording) {
                console.log('Recording is already in progress.');
                return;
            }
            workerStatus = 'starting';
            isRecording = true;
            isStopping = false;
            
            console.log('Initiating new meeting session on backend...');
            try {
                const response = await fetchWithRetry(START_MEETING_API_URL, {
                    method: 'POST'
                });
                const responseData = await response.json();
                console.log('Meeting session initiated:', responseData.message, 'JobId:', responseData.jobId);

                await waitForJobIdCookie();
                
                chrome.runtime.sendMessage({ type: 'recordingStatus', isRecording: true, workerStatus: 'running' });
                workerStatus = 'running';

            } catch (error) {
                console.error('Failed to start recording session:', error);
                chrome.runtime.sendMessage({
                    type: 'error',
                    message: 'Failed to start recording session: ' + error.message
                });
                isRecording = false;
                activeTabId = null;
                workerStatus = 'stopped';
                await closeOffscreenDocument();
            }
            break;
        
        case 'stopRecording':
            if (!isRecording && !isStopping) {
                console.log('No active recording to stop.');
                return;
            }
            isStopping = true;
            isRecording = false;
            console.log('Service worker received stop recording request. Forwarding to offscreen document...');
            // Notify the offscreen document to stop
            chrome.runtime.sendMessage({ action: 'stopRecordingOffscreen' });

            // Immediately change UI state to 'stopped'
            chrome.runtime.sendMessage({ type: 'recordingStatus', isRecording: false, workerStatus: 'stopped' });
            break;

        case 'onAudioChunkReady':
            // Offscreen document sends audio chunks here for upload.
            console.log('Service worker received audio chunk. Handling upload...');
            const audioChunkBlob = new Blob([message.audioData.buffer], { type: message.audioData.mimeType });
            await handleAudioUpload(audioChunkBlob);

            if (isStopping) {
                console.log('Last chunk received after stop request. Marking session complete and fetching transcription...');
                try {
                    await fetchWithRetry(STOP_MEETING_API_URL, {
                        method: 'POST'
                    });
                    console.log('Meeting session marked as completed. Starting to poll for transcription...');
                    const transcriptionData = await pollForTranscription();
                    
                    console.log('Final transcription received:', transcriptionData);
                    chrome.runtime.sendMessage({
                        type: 'transcriptionResult',
                        transcription: { text: transcriptionData.transcriptionChunks.join('\n') }
                    });
                } catch (error) {
                    console.error('Error during stop cleanup or fetching transcription:', error);
                    chrome.runtime.sendMessage({
                        type: 'error',
                        message: 'Error during stop or transcription fetch: ' + error.message
                    });
                } finally {
                    await closeOffscreenDocument();
                    activeTabId = null;
                    isStopping = false;
                    workerStatus = 'stopped';
                    console.log('Recording session fully terminated and cleaned up.');
                }
            }
            break;

        case 'getRecordingStatus':
            chrome.runtime.sendMessage({
                type: 'recordingStatus',
                isRecording: isRecording,
                workerStatus: workerStatus
            });
            break;
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === activeTabId && isRecording) {
        console.log('Active tab was closed. Stopping recording.');
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
    } catch (error) {
        console.error('Failed to send audio chunk to backend:', error);
        chrome.runtime.sendMessage({
            type: 'error',
            message: 'Failed to send audio chunk: ' + error.message
        });
    }
}