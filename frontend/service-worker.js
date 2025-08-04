// service-worker.js
let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let workerStatus = 'stopped';
const MAX_RECORDING_DURATION_MS = 15 * 60 * 1000; // 15 minutes in milliseconds

// This is the backend API URL. It must be the same as in service-worker.js.
// NOTE: You must update this URL to your backend's actual endpoint.
const BACKEND_API_URL = 'http://localhost:3000/api/audios/';
const START_MEETING_API_URL = 'http://localhost:3000/api/meeting/start';
const STOP_MEETING_API_URL = 'http://localhost:3000/api/meeting/stop';

// A simple exponential backoff retry function for API calls.
const fetchWithRetry = async (url, options, retries = 3) => {
    let delay = 1000;
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response;
        } catch (error) {
            console.error(`Attempt ${i + 1} failed: ${error}. Retrying in ${delay}ms...`);
            if (i < retries - 1) {
                await new Promise(res => setTimeout(res, delay));
                delay *= 2; // Exponential backoff
            } else {
                throw error;
            }
        }
    }
};

// Function to generate a timestamp-based filename
const getFileName = () => {
    const now = new Date();
    const pad = (num) => num.toString().padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `recording_${date}_${time}.webm`;
};

// Listen for messages from the popup script.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'startRecording':
            startRecording();
            break;
        case 'stopRecording':
            stopRecording();
            break;
        case 'getRecordingStatus':
            // Send the current recording status to the popup.
            chrome.runtime.sendMessage({
                type: 'recordingStatus',
                isRecording,
                workerStatus
            });
            break;
    }
});

async function startRecording() {
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

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true
        });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        isRecording = true;

        mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            console.log('Recording stopped. Processing audio...');
            const audioBlob = new Blob(audioChunks, {
                type: 'audio/webm'
            });
            const audioFile = new File([audioBlob], getFileName(), {
                type: 'audio/webm'
            });

            const formData = new FormData();
            formData.append('audio', audioFile);

            console.log('Sending audio file to backend...');
            try {
                const response = await fetchWithRetry(BACKEND_API_URL, {
                    method: 'POST',
                    body: formData,
                    // Note: No 'Content-Type' header needed for FormData; the browser sets it automatically.
                });
                const transcription = await response.json();
                console.log('Backend response:', transcription);
                // Send the transcription result back to the popup.
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
            } finally {
                // Now that the audio has been sent, stop the backend worker.
                await fetchWithRetry(STOP_MEETING_API_URL, {
                    method: 'POST'
                });
                workerStatus = 'stopped';
            }
        };

        mediaRecorder.start();
        console.log('Recording started.');

        // Update the popup UI
        chrome.runtime.sendMessage({
            type: 'recordingStatus',
            isRecording,
            workerStatus
        });

        // Automatically stop the recording after the maximum duration
        setTimeout(() => {
            if (mediaRecorder.state === 'recording') {
                console.log('Max recording duration reached. Stopping...');
                stopRecording();
            }
        }, MAX_RECORDING_DURATION_MS);

    } catch (error) {
        console.error('Error starting recording:', error);
        isRecording = false;
        workerStatus = 'stopped';
        chrome.runtime.sendMessage({
            type: 'error',
            message: error.message
        });
    }
}

async function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        isRecording = false;
        mediaRecorder.stop();
        // Update the popup UI
        chrome.runtime.sendMessage({
            type: 'recordingStatus',
            isRecording,
            workerStatus
        });
    }
}
