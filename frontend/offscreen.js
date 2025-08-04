// offscreen.js
let mediaRecorder;
let audioChunks = [];
let audioStream = null;
const MAX_RECORDING_DURATION_MS = 15 * 60 * 1000;
const CHUNK_DURATION_MS = 15000; // Send an audio chunk every 15 seconds for testing.

// Function to generate a timestamp-based filename
const getFileName = () => {
    const now = new Date();
    const pad = (num) => num.toString().padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `recording_${date}_${time}.webm`;
};

async function startRecording() {
    try {
        if (!audioStream) {
            console.log('Offscreen document requesting microphone access...');
            audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log('Offscreen document: Microphone access granted.');
        }

        mediaRecorder = new MediaRecorder(audioStream);
        audioChunks = [];

        // This event now fires every CHUNK_DURATION_MS with a chunk of data.
        mediaRecorder.ondataavailable = async (event) => {
            if (event.data.size > 0) {
                console.log('Offscreen document: Sending audio chunk to service worker...');
                const arrayBuffer = await event.data.arrayBuffer();
                chrome.runtime.sendMessage({
                    action: 'onAudioChunkReady', // Use a new action for chunks.
                    audioData: {
                        buffer: arrayBuffer,
                        mimeType: 'audio/webm',
                        fileName: getFileName()
                    }
                });
            }
        };

        // The onstop event will now only handle the cleanup.
        mediaRecorder.onstop = () => {
            console.log('Offscreen document: Recording stopped.');
            // Stop the stream to release the microphone.
            audioStream.getTracks().forEach(track => track.stop());
            audioStream = null;
            
            // Let the popup know we've stopped recording.
            chrome.runtime.sendMessage({
                type: 'recordingStatus',
                isRecording: false,
                workerStatus: 'stopped'
            });
        };

        // Start recording and get a chunk every CHUNK_DURATION_MS.
        mediaRecorder.start(CHUNK_DURATION_MS);
        console.log('Offscreen document: Recording started, sending chunks every ' + CHUNK_DURATION_MS / 1000 + ' seconds.');
        
        // Let the popup know we're recording.
        chrome.runtime.sendMessage({
            type: 'recordingStatus',
            isRecording: true,
            workerStatus: 'running'
        });

        setTimeout(() => {
            if (mediaRecorder.state === 'recording') {
                console.log('Offscreen document: Max recording duration reached. Stopping...');
                stopRecording();
            }
        }, MAX_RECORDING_DURATION_MS);

    } catch (error) {
        console.error('Offscreen document: Error starting recording:', error);
        chrome.runtime.sendMessage({
            type: 'error',
            message: `Recording error: ${error.message}`
        });
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        console.log('Offscreen document: Stopping media recorder.');
        mediaRecorder.stop();
    }
}

// Listen for messages from the service worker.
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'startRecordingOffscreen') {
        startRecording();
    } else if (message.action === 'stopRecordingOffscreen') {
        stopRecording();
    }
});
