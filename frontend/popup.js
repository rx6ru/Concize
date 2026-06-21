const startButton = document.getElementById("startRecord");
const stopButton = document.getElementById("stopRecord");
const permissionStatusDiv = document.getElementById("permissionStatus");
const statusMessageDiv = document.getElementById("statusMessage");
const workerStatusSpan = document.getElementById("workerStatus");
const recordingIndicatorDiv = document.getElementById("recordingIndicator");
const recordingGlyphDiv = document.getElementById("recordingGlyph");
const toggleButtonWrapper = document.getElementById("toggleButtonWrapper");
const getTranscriptionButton = document.getElementById("getTranscriptionButton");
const transcriptionDisplayArea = document.getElementById("transcriptionDisplayArea");
const transcriptionTextContent = document.getElementById("transcriptionTextContent");
const downloadButtonWrapper = document.getElementById("downloadButtonWrapper");
const downloadTranscriptionButton = document.getElementById("downloadTranscriptionButton");
const openChatButton = document.getElementById("openChat");

// --- Auth elements ---
const authSection = document.getElementById("authSection");
const appSection = document.getElementById("appSection");
const accountBar = document.getElementById("accountBar");
const accountEmail = document.getElementById("accountEmail");
const authEmailInput = document.getElementById("authEmail");
const authPasswordInput = document.getElementById("authPassword");
const signInButton = document.getElementById("signInButton");
const signUpButton = document.getElementById("signUpButton");
const signOutButton = document.getElementById("signOutButton");
const authMessageDiv = document.getElementById("authMessage");

let fullTranscriptionText = ''; // To store the transcription

/**
 * Toggles the popup between the login form and the app based on auth state.
 * When signed in, also kicks off the recording-state check.
 */
async function applyAuthState() {
    const signedIn = await ConcizeAuth.isAuthenticated();
    authSection.classList.toggle("hidden", signedIn);
    appSection.classList.toggle("hidden", !signedIn);
    accountBar.classList.toggle("hidden", !signedIn);
    if (signedIn) {
        await checkRecordingState();
    }
}

function showAuthMessage(message, isError = true) {
    authMessageDiv.textContent = message;
    authMessageDiv.style.display = "block";
    authMessageDiv.style.backgroundColor = isError ? "#dc2626" : "#3f51b5";
}

async function handleSignIn() {
    const email = authEmailInput.value.trim();
    const password = authPasswordInput.value;
    if (!email || !password) return showAuthMessage("Enter email and password.");
    try {
        signInButton.disabled = true;
        await ConcizeAuth.signIn(email, password);
        authMessageDiv.style.display = "none";
        await applyAuthState();
    } catch (err) {
        showAuthMessage(err.message);
    } finally {
        signInButton.disabled = false;
    }
}

async function handleSignUp() {
    const email = authEmailInput.value.trim();
    const password = authPasswordInput.value;
    if (!email || !password) return showAuthMessage("Enter email and password.");
    try {
        signUpButton.disabled = true;
        const data = await ConcizeAuth.signUp(email, password);
        if (data.access_token) {
            await applyAuthState();
        } else {
            // Email confirmation required.
            showAuthMessage("Account created — check your email to confirm, then sign in.", false);
        }
    } catch (err) {
        showAuthMessage(err.message);
    } finally {
        signUpButton.disabled = false;
    }
}

async function handleSignOut() {
    await ConcizeAuth.signOut();
    await chrome.storage.local.remove('meetingId');
    await applyAuthState();
}

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

// On open, decide between login form and app.
document.addEventListener("DOMContentLoaded", applyAuthState);
signInButton.addEventListener("click", handleSignIn);
signUpButton.addEventListener("click", handleSignUp);
signOutButton.addEventListener("click", handleSignOut);

// Add button click listeners
startButton.addEventListener("click", async () => {
    hideStatusMessage(); // Clear any old status messages when starting
    hidePermissionMessage(); // Clear any old permission messages when starting

    const hasPermission = await checkMicrophonePermission();
    if (!hasPermission) {
        return; // Stop if no permission (message already shown by checkMicrophonePermission and permission.html opened)
    }

    try {
        // Create a meeting (RESTful, authenticated). Returns a meetingId.
        const startMeetingResponse = await ConcizeAuth.authedFetch('/api/v1/meetings', {
            method: 'POST',
        });
        const startMeetingData = await startMeetingResponse.json();

        if (!startMeetingResponse.ok || !startMeetingData.success) {
            showStatusMessage(`Failed to start meeting session: ${startMeetingData.message || startMeetingResponse.status}`, true);
            updateUIForRecording(false); // Revert UI if meeting session can't start
            return;
        }
        const meetingId = startMeetingData.meetingId;
        console.log(`Meeting session started with meetingId: ${meetingId}`);
        await chrome.storage.local.set({ meetingId });

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
            data: {
                streamId: streamId,
                meetingId: meetingId
            },
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

// Event listener for the Get Transcription button
getTranscriptionButton.addEventListener("click", async () => {
    hideStatusMessage();
    hidePermissionMessage();
    downloadButtonWrapper.classList.add('hidden'); // Hide download button initially

    try {
        const result = await chrome.storage.local.get('meetingId');
        const meetingId = result.meetingId;

        if (!meetingId) {
            showStatusMessage("No active recording session found. Please start a recording first.", true);
            return;
        }

        showStatusMessage("Fetching transcription...");

        const response = await ConcizeAuth.authedFetch(`/api/v1/meetings/${meetingId}/transcript`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }

        const transcriptionData = await response.json();
        console.log('Received transcription data:', transcriptionData);

        if (transcriptionData.transcriptionChunks && transcriptionData.transcriptionChunks.length > 0) {
            fullTranscriptionText = transcriptionData.transcriptionChunks.join(' ');
            console.log('Full Transcription:', fullTranscriptionText);

            transcriptionTextContent.textContent = fullTranscriptionText;
            transcriptionDisplayArea.classList.remove('hidden');
            downloadButtonWrapper.classList.remove('hidden'); // Show download button
            showStatusMessage("Transcription loaded successfully.");
        } else {
            fullTranscriptionText = ''; // Keep empty to prevent downloading placeholder
            transcriptionTextContent.textContent = "No transcription available for this session yet.";
            transcriptionDisplayArea.classList.remove('hidden');
            downloadButtonWrapper.classList.add('hidden'); // Keep download hidden
            showStatusMessage("No transcription available.", true);
        }
    } catch (error) {
        console.error("Error fetching transcription:", error);
        showStatusMessage(`Failed to get transcription: ${error.message}`, true);
        transcriptionDisplayArea.classList.add('hidden');
        downloadButtonWrapper.classList.add('hidden');
    }
});

// Event listener for the Download Transcription button
downloadTranscriptionButton.addEventListener("click", async () => {
    if (!fullTranscriptionText) {
        showStatusMessage("No transcription text to download.", true);
        return;
    }
    
    try {
        const result = await chrome.storage.local.get('meetingId');
        const meetingId = result.meetingId || 'session';

        // Create a Blob from the transcription text
        const blob = new Blob([fullTranscriptionText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);

        // Create a temporary anchor element and trigger download
        const a = document.createElement('a');
        a.href = url;
        a.download = `transcription-${meetingId}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url); // Clean up the object URL
        
        showStatusMessage("Download started.", false);

    } catch (error) {
        console.error("Error creating download:", error);
        showStatusMessage(`Failed to create download: ${error.message}`, true);
    }
});

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
        }
    }
});