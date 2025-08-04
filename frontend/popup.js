// popup.js
document.addEventListener('DOMContentLoaded', () => {
    const toggleButton = document.getElementById('toggleButton');
    const startIcon = document.getElementById('startIcon');
    const stopIcon = document.getElementById('stopIcon');
    const buttonText = document.getElementById('buttonText');
    const recordingIndicator = document.getElementById('recordingIndicator');
    const statusMessage = document.getElementById('statusMessage');
    const workerStatusBadge = document.getElementById('workerStatus');
    const transcriptionText = document.getElementById('transcriptionText');

    let isRecording = false;

    // Function to update UI based on recording state
    const updateUI = (newIsRecording, newWorkerStatus) => {
        isRecording = newIsRecording;
        workerStatusBadge.textContent = newWorkerStatus;
        workerStatusBadge.className = `status-badge ${newWorkerStatus.toLowerCase()}`;
        
        if (isRecording) {
            toggleButton.classList.remove('start');
            toggleButton.classList.add('stop');
            startIcon.classList.add('hidden');
            stopIcon.classList.remove('hidden');
            buttonText.textContent = 'Stop Recording';
            recordingIndicator.classList.remove('hidden');
            statusMessage.textContent = 'Recording in progress... (max 15 mins)';
            statusMessage.className = 'mt-4 p-2 w-full text-center text-sm font-medium rounded-lg bg-yellow-600';
        } else {
            toggleButton.classList.remove('stop');
            toggleButton.classList.add('start');
            startIcon.classList.remove('hidden');
            stopIcon.classList.add('hidden');
            buttonText.textContent = 'Start Recording';
            recordingIndicator.classList.add('hidden');
            statusMessage.textContent = 'Ready to record.';
            statusMessage.className = 'mt-4 p-2 w-full text-center text-sm font-medium rounded-lg bg-gray-600';
        }
    };
    
    // Set initial UI state on page load
    updateUI(false, 'Stopped');

    // Listen for messages from the service worker
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log("Message received in popup.js:", message);
        if (message.type === 'recordingStatus') {
            updateUI(message.isRecording, message.workerStatus);
        } else if (message.type === 'transcriptionResult') {
            const transcription = message.transcription.text;
            transcriptionText.textContent = transcription;
        } else if (message.type === 'error') {
            statusMessage.textContent = `Error: ${message.message}`;
            statusMessage.className = 'mt-4 p-2 w-full text-center text-sm font-medium rounded-lg bg-red-600';
        }
    });

    toggleButton.addEventListener('click', () => {
        if (isRecording) {
            chrome.runtime.sendMessage({ action: 'stopRecording' });
        } else {
            chrome.runtime.sendMessage({ action: 'startRecording' });
        }
    });

    // Check recording status with the service worker after setting the initial UI
    chrome.runtime.sendMessage({ action: 'getRecordingStatus' });
});
