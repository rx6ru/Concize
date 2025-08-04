// offscreen.js
let mediaRecorder;
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

// --- FUNCTION TO DOWNLOAD AUDIO BLOB (for verification) ---
const downloadAudioBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
    console.log(`Downloaded: ${filename}`);
};
// --- END FUNCTION ---

// Modified startRecording function to accept tabId
async function startRecording(tabId) {
    try {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            console.log('Offscreen document: MediaRecorder already active.');
            return;
        }

        console.log(`Offscreen document: Requesting tab audio capture for tabId: ${tabId}...`);
        // --- CRITICAL CHANGE: Use chrome.tabCapture.capture directly in offscreen.js ---
        audioStream = await new Promise((resolve, reject) => {
            chrome.tabCapture.capture({
                audio: true,
                video: false,
                tabId: tabId // Specify the tab to capture from
            }, (stream) => {
                if (stream) {
                    resolve(stream);
                } else {
                    reject(new Error(chrome.runtime.lastError.message || 'Failed to capture tab audio.'));
                }
            });
        });
        console.log('Offscreen document: Tab audio stream granted.');
        // --- END CRITICAL CHANGE ---

        mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });

        mediaRecorder.ondataavailable = async (event) => {
            if (event.data.size > 0) {
                console.log('Offscreen document: Sending audio chunk to service worker...');
                const arrayBuffer = await event.data.arrayBuffer();
                const filename = getFileName();
                const audioBlob = new Blob([arrayBuffer], { type: 'audio/webm' });

                // Download the audio chunk for verification
                downloadAudioBlob(audioBlob, filename);

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
            console.log('Offscreen document: Recording stopped.');
            // Stop the stream to release the audio capture.
            if (audioStream) {
                audioStream.getTracks().forEach(track => track.stop());
                audioStream = null;
            }
            
            // Let the popup know we've stopped recording.
            chrome.runtime.sendMessage({
                type: 'recordingStatus',
                isRecording: false,
                workerStatus: 'stopped'
            });
        };

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
        // Ensure stream is stopped and nullified if an error occurs during start
        if (audioStream) {
            audioStream.getTracks().forEach(track => track.stop());
            audioStream = null;
        }
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        console.log('Offscreen document: Stopping media recorder.');
        mediaRecorder.stop();
    }
}

// Listen for direct messages from service worker
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'startRecordingOffscreen' && message.tabId) {
        startRecording(message.tabId); // Pass the tabId to start capture
    } else if (message.action === 'stopRecordingOffscreen') {
        stopRecording();
    }
});
