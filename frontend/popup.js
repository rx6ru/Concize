const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusEl = document.getElementById('status');
const statusIndicator = document.getElementById('status-indicator');
const transcriptionOutputEl = document.getElementById('transcription-output');

// Update UI based on recording state
function updateUI(isRecording) {
    startBtn.style.display = isRecording ? 'none' : 'block';
    stopBtn.style.display = isRecording ? 'block' : 'none';
    
    if (isRecording) {
        statusEl.textContent = 'Status: Recording...';
        statusEl.className = 'text-sm text-green-800 bg-green-100 px-3 py-1.5 rounded-lg inline-block';
        statusIndicator.className = 'w-3 h-3 bg-red-500 rounded-full pulse';
    } else {
        statusEl.textContent = 'Status: Idle';
        statusEl.className = 'text-sm text-gray-600 bg-gray-100 px-3 py-1.5 rounded-lg inline-block';
        statusIndicator.className = 'w-3 h-3 bg-gray-400 rounded-full';
    }
}

// Start recording
startBtn.addEventListener('click', () => {
    transcriptionOutputEl.innerHTML = '';
    // Send the message and let the background script handle the response and state updates.
    // No callback is needed here, which prevents the "could not send message" error.
    chrome.runtime.sendMessage({ type: 'start-recording', target: 'background' }, (response) => {
        if (chrome.runtime.lastError) {
             // This might still happen if the background script is inactive.
            console.error("Start recording message failed:", chrome.runtime.lastError.message);
        } else if (response && response.status === 'error') {
            // Handle specific errors sent from the background script, like not being on a Meet page.
            statusEl.textContent = response.message;
            startBtn.disabled = true;
        }
    });
});

// Stop recording
stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'stop-recording', target: 'background' });
});

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((request) => {
    if (request.target !== 'popup') return;

    switch (request.type) {
        case 'state-update':
            // This is the primary way the UI gets updated.
            updateUI(request.isRecording);
            break;
        case 'log-update':
            if (transcriptionOutputEl.childElementCount === 0) {
                 transcriptionOutputEl.innerHTML = ''; // Clear any initial text
            }
            const p = document.createElement('p');
            p.textContent = `[${new Date().toLocaleTimeString()}] ${request.message}`;
            transcriptionOutputEl.appendChild(p);
            transcriptionOutputEl.scrollTop = transcriptionOutputEl.scrollHeight;
            break;
    }
});

// Check recording status and page validity when popup opens
document.addEventListener('DOMContentLoaded', () => {
    // First, get the true recording state from the background script
    chrome.runtime.sendMessage({ type: 'get-status', target: 'background' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Get status failed:", chrome.runtime.lastError.message);
            updateUI(false);
        } else if (response) {
            const isRecording = response.isRecording;
            updateUI(isRecording);

            // Only check the active tab if we are NOT currently recording.
            if (!isRecording) {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs.length === 0 || !tabs[0] || !tabs[0].url.includes('meet.google.com')) {
                        statusEl.textContent = 'Navigate to a Meet page to start.';
                        startBtn.disabled = true;
                    } else {
                        startBtn.disabled = false;
                    }
                });
            }
        }
    });
});
