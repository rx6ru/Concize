
// offscreen.js
// This file is now responsible for getting the stream and recording audio.
let mediaRecorder;
let audioStream = null;
const MAX_RECORDING_DURATION_MS = 15 * 60 * 1000;
const CHUNK_DURATION_MS = 15000;

// Utility function to generate a filename.
const getFileName = () => {
    const now = new Date();
    const pad = (num) => num.toString().padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `recording_${date}_${time}.webm`;
};

// Starts the recording process by getting the stream using its ID.
async function startRecordingFromStreamId(streamId) {
    try {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            console.log('Offscreen document: MediaRecorder already active.');
            return;
        }

        console.log(`Offscreen document: Requesting stream with ID ${streamId}...`);
        
        // CRITICAL FIX: The offscreen document gets the stream using the ID.
        // This is possible here but not in the service worker.
        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId
                }
            },
            video: false
        });
        
        console.log('Offscreen document: Received audio stream from service worker.');

        mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });

        mediaRecorder.ondataavailable = async (event) => {
            if (event.data.size > 0) {
                console.log('Offscreen document: Sending audio chunk to service worker...');
                const arrayBuffer = await event.data.arrayBuffer();
                const filename = getFileName();

                // Send the audio data to the service worker for upload.
                chrome.runtime.sendMessage({
                    action: 'onAudioChunkReady',
                    audioData: {
                        buffer: arrayBuffer,
                        mimeType: 'audio/webm',
                        fileName: filename
                    }
                });
            }
        };

        mediaRecorder.onstop = () => {
            console.log('Offscreen document: Recording stopped. Cleaning up.');
            if (audioStream) {
                audioStream.getTracks().forEach(track => track.stop());
                audioStream = null;
            }
        };

        mediaRecorder.start(CHUNK_DURATION_MS);
        console.log('Offscreen document: Recording started, sending chunks every ' + CHUNK_DURATION_MS / 1000 + ' seconds.');
        
        // Stop recording after a max duration to prevent infinite recording.
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
        if (audioStream) {
            audioStream.getTracks().forEach(track => track.stop());
            audioStream = null;
        }
    }
}

// Stops the media recorder.
function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        console.log('Offscreen document: Stopping media recorder.');
        mediaRecorder.stop();
    }
}

// Main message listener for the offscreen document.
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'startRecordingOffscreenWithStreamId' && message.streamId) {
        startRecordingFromStreamId(message.streamId);
    } else if (message.action === 'stopRecordingOffscreen') {
        stopRecording();
    }
});
