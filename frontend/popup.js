// popup.js
// This file now sends the stream ID directly to the offscreen document.
document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const toggleButton = document.getElementById('toggleButton');
    const toggleButtonWrapper = document.getElementById('toggleButtonWrapper');
    const startIcon = document.getElementById('startIcon');
    const stopIcon = document.getElementById('stopIcon');
    const buttonText = document.getElementById('buttonText');
    const workerStatusBadge = document.getElementById('workerStatus');
    const recordingIndicator = document.getElementById('recordingIndicator');
    const statusMessage = document.getElementById('statusMessage');
    const transcriptionText = document.getElementById('transcriptionText');

    let isRecording = false;

    // Helper function to update the UI based on the recording state
    const updateUI = (newIsRecording, newWorkerStatus, message) => {
        isRecording = newIsRecording;
        
        toggleButton.disabled = false;
        
        // Update button state and styles
        if (isRecording) {
            startIcon.classList.add('hidden');
            stopIcon.classList.remove('hidden');
            buttonText.textContent = 'Stop Recording';
            toggleButtonWrapper.classList.add('bg-gradient-to-r', 'from-red-500', 'to-red-700');
            toggleButtonWrapper.classList.remove('from-blue-500', 'to-blue-700');
            recordingIndicator.classList.remove('hidden');
        } else {
            startIcon.classList.remove('hidden');
            stopIcon.classList.add('hidden');
            buttonText.textContent = 'Start Recording';
            toggleButtonWrapper.classList.add('from-blue-500', 'to-blue-700');
            toggleButtonWrapper.classList.remove('from-red-500', 'to-red-700');
            recordingIndicator.classList.add('hidden');
        }

        // Update status badge
        workerStatusBadge.textContent = newWorkerStatus.charAt(0).toUpperCase() + newWorkerStatus.slice(1);
        workerStatusBadge.classList.remove('bg-red-600', 'bg-green-600');
        if (newWorkerStatus === 'running') {
            workerStatusBadge.classList.add('bg-green-600');
        } else {
            workerStatusBadge.classList.add('bg-red-600');
        }

        // Update status message
        if (message) {
            statusMessage.textContent = message;
        } else {
            if (newWorkerStatus === 'starting') {
                statusMessage.textContent = 'Starting recording...';
            } else if (newWorkerStatus === 'running') {
                statusMessage.textContent = 'Recording in progress...';
            } else {
                statusMessage.textContent = 'Ready to record.';
            }
        }
    };

    // Initial status update from the service worker
    chrome.runtime.sendMessage({ action: 'getRecordingStatus' });

    toggleButton.addEventListener('click', async () => {
        toggleButton.disabled = true; // Disable button immediately
        
        if (isRecording) {
            console.log('Popup: Sending stop recording request...');
            updateUI(false, 'stopped', 'Stopping recording...');
            chrome.runtime.sendMessage({ action: 'stopRecording' });
        } else {
            console.log('Popup: Sending start recording request...');
            transcriptionText.textContent = 'Start recording to see the transcription appear here.';
            updateUI(true, 'starting', 'Starting recording...');

            // Fetch the active tab ID
            chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
                const activeTabId = tabs[0].id;
                
                try {
                    // CRITICAL FIX: Capture the stream directly from the popup
                    // This call requires a user gesture and must be done here.
                    chrome.tabCapture.capture({ video: false, audio: true }, (stream) => {
                        if (stream) {
                            console.log('Popup: Tab audio stream granted.');
                            
                            // Send the stream ID and tab ID to the offscreen document.
                            // The stream object itself is not serializable.
                            chrome.runtime.sendMessage({
                                action: 'startRecordingOffscreenWithStreamId',
                                streamId: stream.id,
                                tabId: activeTabId
                            });

                            // Tell the service worker to start the backend session.
                            // The service worker handles all API calls.
                            chrome.runtime.sendMessage({
                                action: 'startMeeting'
                            });

                        } else {
                            throw new Error(chrome.runtime.lastError.message || 'Failed to capture tab audio.');
                        }
                    });
                } catch (error) {
                    console.error('Popup: Error during tab capture:', error);
                    updateUI(false, 'stopped', `Error: Failed to start recording - ${error.message}`);
                }
            });
        }
    });

    // Listen for messages from the service worker and offscreen document
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'recordingStatus') {
            const { isRecording: status, workerStatus } = message;
            updateUI(status, workerStatus);
        } else if (message.type === 'transcriptionResult') {
            transcriptionText.textContent = message.transcription.text;
            updateUI(false, 'stopped', 'Transcription complete.');
        } else if (message.type === 'error') {
            updateUI(false, 'stopped', `Error: ${message.message}`);
        }
    });
});