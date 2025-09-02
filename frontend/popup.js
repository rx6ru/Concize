const startButton = document.getElementById("startRecord");
const stopButton = document.getElementById("stopRecord");
const permissionStatusDiv = document.getElementById("permissionStatus");
const statusMessageDiv = document.getElementById("statusMessage");
const workerStatusSpan = document.getElementById("workerStatus");
const recordingIndicatorDiv = document.getElementById("recordingIndicator");
const recordingGlyphDiv = document.getElementById("recordingGlyph");
const toggleButtonWrapper = document.getElementById("toggleButtonWrapper");

/**
 * Displays a general status message to the user.
 * @param {string} message - The message to display.
 * @param {boolean} isError - True if it's an error message, false otherwise.
 */
function showStatusMessage(message, isError = false) {
    statusMessageDiv.textContent = message;
    statusMessageDiv.style.display = "block";
    if (isError) {
        statusMessageDiv.style.backgroundColor = "#dc2626"; // Red for errors
    } else {
        statusMessageDiv.style.backgroundColor = "#3f51b5"; // Blue for general status
    }
}

/**
 * Hides the general status message.
 */
function hideStatusMessage() {
    statusMessageDiv.style.display = "none";
    statusMessageDiv.textContent = "";
}

/**
 * Displays a permission-related message to the user.
 * @param {string} message - The permission message to display.
 */
function showPermissionMessage(message) {
    permissionStatusDiv.textContent = message;
    permissionStatusDiv.style.display = "block";
}

/**
 * Hides the permission-related message.
 */
function hidePermissionMessage() {
    permissionStatusDiv.style.display = "none";
    permissionStatusDiv.textContent = "";
}

/**
 * Updates the worker status text and badge color.
 * @param {'Stopped' | 'Recording' | 'Running'} status - The new status.
 */
function updateWorkerStatus(status) {
    workerStatusSpan.textContent = status;
    workerStatusSpan.classList.remove('stopped', 'recording', 'running');
    workerStatusSpan.classList.add(status.toLowerCase());
}

/**
 * Updates the UI based on whether recording is active or not.
 * This includes button visibility, wrapper color, and recording indicator.
 * @param {boolean} isRecording - True if recording is active, false otherwise.
 */
function updateUIForRecording(isRecording) {
    if (isRecording) {
        // Show stop button, hide start button
        startButton.classList.remove("visible");
        stopButton.classList.add("visible");

        // Change button wrapper to red (stop state)
        toggleButtonWrapper.classList.add("stop");

        // Show and animate recording indicator
        recordingIndicatorDiv.classList.remove("hidden");
        recordingGlyphDiv.classList.add("blink");

        // Update worker status
        updateWorkerStatus('Recording');
    } else {
        // Show start button, hide stop button
        stopButton.classList.remove("visible");
        startButton.classList.add("visible");

        // Change button wrapper to blue (start state)
        toggleButtonWrapper.classList.remove("stop");

        // Hide and stop animating recording indicator
        recordingIndicatorDiv.classList.add("hidden");
        recordingGlyphDiv.classList.remove("blink");

        // Update worker status
        updateWorkerStatus('Stopped');
    }
}

/**
 * Checks for microphone permission.
 * @returns {Promise<boolean>} - True if permission is granted, false otherwise.
 */
async function checkMicrophonePermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Stop the stream immediately after checking to release resources
        stream.getTracks().forEach(track => track.stop());
        hidePermissionMessage(); // Hide message if permission is granted
        return true;
    } catch (error) {
        if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
            showPermissionMessage("Microphone access denied. Please grant permission in your browser settings to record.");
            // Open permission.html to guide the user to grant permission
            chrome.tabs.create({ url: "permission.html" });
        } else {
            showPermissionMessage("Could not access microphone: " + error.message);
        }
        return false;
    }
}

/**
 * Checks the current recording state from the offscreen document and updates UI.
 */
async function checkRecordingState() {
    hideStatusMessage(); // Clear any old status messages on load
    hidePermissionMessage(); // Clear any old permission messages on load

    const hasPermission = await checkMicrophonePermission();
    if (!hasPermission) {
        updateUIForRecording(false);
        return;
    }

    const contexts = await chrome.runtime.getContexts({});
    const offscreenDocument = contexts.find(
        (c) => c.contextType === "OFFSCREEN_DOCUMENT"
    );

    const isCurrentlyRecording = offscreenDocument && offscreenDocument.documentUrl.endsWith("#recording");
    updateUIForRecording(isCurrentlyRecording);
}

// Call checkRecordingState when popup opens
document.addEventListener("DOMContentLoaded", checkRecordingState);

// Add button click listeners
startButton.addEventListener("click", async () => {
    hideStatusMessage(); // Clear any old status messages when starting
    hidePermissionMessage(); // Clear any old permission messages when starting

    const hasPermission = await checkMicrophonePermission();
    if (!hasPermission) {
        return; // Stop if no permission (message already shown by checkMicrophonePermission and permission.html opened)
    }

    try {
        // Call the meeting/start API to get a jobId
        const startMeetingResponse = await fetch('http://localhost:3000/api/meeting/start', {
            method: 'POST',
        });
        const startMeetingData = await startMeetingResponse.json();

        if (!startMeetingData.success) {
            showStatusMessage(`Failed to start meeting session: ${startMeetingData.message}`, true);
            updateUIForRecording(false); // Revert UI if meeting session can't start
            return;
        }
        console.log(`Meeting session started with jobId: ${startMeetingData.jobId}`);

        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
        });

        if (
            !tab ||
            tab.url.startsWith("chrome://") ||
            tab.url.startsWith("chrome-extension://") ||
            tab.url.startsWith("about:")
        ) {
            showStatusMessage("Cannot record Chrome system pages or internal browser pages. Please try on a regular webpage.", true);
            updateUIForRecording(false); // Revert UI if recording can't start
            return;
        }

        // Update UI immediately to show recording state
        updateUIForRecording(true);

        const contexts = await chrome.runtime.getContexts({});
        const offscreenDocument = contexts.find(
            (c) => c.contextType === "OFFSCREEN_DOCUMENT"
        );

        if (!offscreenDocument) {
            await chrome.offscreen.createDocument({
                url: "offscreen.html",
                reasons: ["USER_MEDIA"],
                justification: "Recording from chrome.tabCapture API",
            });
        }

        const streamId = await chrome.tabCapture.getMediaStreamId({
            targetTabId: tab.id,
        });

        chrome.runtime.sendMessage({
            type: "start-recording",
            target: "offscreen",
            data: streamId,
        });

    } catch (error) {
        showStatusMessage("Failed to start recording: " + error.message, true);
        updateUIForRecording(false); // Revert UI if an error occurs
    }
});

stopButton.addEventListener("click", () => {
    hideStatusMessage(); // Clear any old status messages when stopping
    hidePermissionMessage(); // Clear any old permission messages when stopping
    
    // Update UI immediately to show stopped state
            updateUIForRecording(false);

    chrome.runtime.sendMessage({
        type: "stop-recording",
        target: "offscreen",
    });
});

// Event listener for the chat button
const openChatButton = document.getElementById('openChat');
openChatButton.addEventListener('click', () => {
    chrome.windows.create({
        url: chrome.runtime.getURL('chat-popup.html'),
        type: 'popup',
        width: 350,
        height: 600,
        left: 100,
        top: 100
    });
});

// Listen for messages from offscreen document and service worker
chrome.runtime.onMessage.addListener((message) => {
    if (message.target === "popup") {
        switch (message.type) {
            case "recording-error":
                showStatusMessage(message.error, true);
                updateUIForRecording(false); // Ensure UI is reset to stopped
                break;
            case "recording-stopped":
                updateUIForRecording(false); // Ensure UI is reset to stopped
                break;
            case "update-transcription":
                document.getElementById('transcriptionText').textContent = message.data;
                break;
        }
    }
});