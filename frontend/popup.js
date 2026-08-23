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
const transcriptTurns = document.getElementById("transcriptTurns");
const downloadButtonWrapper = document.getElementById("downloadButtonWrapper");
const downloadTranscriptionButton = document.getElementById("downloadTranscriptionButton");
const openChatButton = document.getElementById("openChat");
const meetingListArea = document.getElementById("meetingListArea");
const meetingList = document.getElementById("meetingList");

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

let fullTranscriptionText = '';

// Live turns arrive by turnId; keeping the element per id lets a revision correct one in place.
const liveTurnElements = new Map();

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
        await loadMeetings();
    }
}

function showAuthMessage(message, isError = true) {
    authMessageDiv.textContent = message;
    authMessageDiv.style.display = "block";
    authMessageDiv.style.backgroundColor = isError ? "#c64545" : "#cc785c";
}

async function handleSignIn() {
    const email = authEmailInput.value.trim();
    const password = authPasswordInput.value;
    if (!email || !password) return showAuthMessage("Enter email and password.");
    try {
        signInButton.disabled = true;
        await ConcizeAuth.signIn(email, password);
        // Signing in is a user gesture, which is the only context Chrome grants host access from.
        if (!await ConcizeAuth.hasBackendAccess() && !await ConcizeAuth.requestBackendAccess()) {
            return showAuthMessage("Concize needs access to your backend to work.");
        }
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

function showStatusMessage(message, isError = false) {
    statusMessageDiv.textContent = message;
    statusMessageDiv.style.display = "block";
    if (isError) {
        statusMessageDiv.style.backgroundColor = "#c64545"; // error red
    } else {
        statusMessageDiv.style.backgroundColor = "#cc785c"; // coral (brand)
    }
}

function hideStatusMessage() {
    statusMessageDiv.style.display = "none";
    statusMessageDiv.textContent = "";
}

function showPermissionMessage(message) {
    permissionStatusDiv.textContent = message;
    permissionStatusDiv.style.display = "block";
}

function hidePermissionMessage() {
    permissionStatusDiv.style.display = "none";
    permissionStatusDiv.textContent = "";
}

/** @param {'Stopped' | 'Recording' | 'Running'} status */
function updateWorkerStatus(status) {
    workerStatusSpan.textContent = status;
    workerStatusSpan.classList.remove('stopped', 'recording', 'running');
    workerStatusSpan.classList.add(status.toLowerCase());
}

/** Updates the UI for recording state: button visibility, wrapper color, and the recording indicator. */
function updateUIForRecording(isRecording) {
    if (isRecording) {
        startButton.classList.remove("visible");
        stopButton.classList.add("visible");

        toggleButtonWrapper.classList.add("stop");

        recordingIndicatorDiv.classList.remove("hidden");
        recordingGlyphDiv.classList.add("blink");

        updateWorkerStatus('Recording');
    } else {
        stopButton.classList.remove("visible");
        startButton.classList.add("visible");

        toggleButtonWrapper.classList.remove("stop");

        recordingIndicatorDiv.classList.add("hidden");
        recordingGlyphDiv.classList.remove("blink");

        updateWorkerStatus('Stopped');
    }
}

async function checkMicrophonePermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Stop the stream immediately after checking to release resources
        stream.getTracks().forEach(track => track.stop());
        hidePermissionMessage();
        return true;
    } catch (error) {
        if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
            showPermissionMessage("Microphone access denied. Please grant permission in your browser settings to record.");
            chrome.tabs.create({ url: "permission.html" });
        } else {
            showPermissionMessage("Could not access microphone: " + error.message);
        }
        return false;
    }
}

/** Checks the current recording state from the offscreen document and updates UI. */
async function checkRecordingState() {
    hideStatusMessage();
    hidePermissionMessage();

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

startButton.addEventListener("click", async () => {
    hideStatusMessage();
    hidePermissionMessage();

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
        resetLiveTranscript();

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
    hideStatusMessage();
    hidePermissionMessage();
    
            updateUIForRecording(false);

    chrome.runtime.sendMessage({
        type: "stop-recording",
        target: "offscreen",
    });
});



/** A date a person can place: today and yesterday by name, older ones by date. */
function meetingDate(iso) {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return "";
    const days = Math.floor((Date.now() - then.getTime()) / 86400000);
    const time = then.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (days === 0) return time;
    if (days === 1) return `Yesterday ${time}`;
    return then.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Lists the caller's meetings, most recent first. Without this the extension can only ever show
 * the recording in progress, and every meeting becomes unreachable the moment the next one starts.
 */
async function loadMeetings() {
    try {
        const res = await ConcizeAuth.authedFetch("/api/v1/meetings?limit=50", {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) return;

        const { meetings = [] } = await res.json();
        if (!meetings.length) {
            meetingListArea.classList.add("hidden");
            return;
        }

        meetingList.textContent = "";
        for (const m of meetings) {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "meeting";

            const title = document.createElement("span");
            title.className = m.title ? "meeting-title" : "meeting-title untitled";
            title.textContent = m.title || "Untitled meeting";

            const date = document.createElement("span");
            date.className = "meeting-date";
            date.textContent = meetingDate(m.createdAt);

            row.append(title, date);

            if (m.status && m.status !== "completed") {
                const status = document.createElement("span");
                status.className = m.status === "recording" ? "meeting-status recording" : "meeting-status";
                status.textContent = m.status;
                row.append(status);
            }

            row.addEventListener("click", () => openMeeting(m.meetingId));
            meetingList.append(row);
        }
        meetingListArea.classList.remove("hidden");
    } catch (err) {
        console.error("Could not list meetings:", err);
    }
}

/** Shows one meeting's transcript, whether or not it is the one being recorded. */
async function openMeeting(meetingId) {
    hideStatusMessage();
    showStatusMessage("Loading transcript...");
    try {
        if (await loadTranscript(meetingId)) {
            transcriptionDisplayArea.classList.remove("hidden");
            downloadButtonWrapper.classList.remove("hidden");
            hideStatusMessage();
        } else {
            transcriptTurns.textContent = "Nothing transcribed for this meeting yet.";
            transcriptionDisplayArea.classList.remove("hidden");
            downloadButtonWrapper.classList.add("hidden");
        }
    } catch (err) {
        showStatusMessage(`Could not load that meeting: ${err.message}`, true);
    }
}

/** mm:ss for a millisecond offset into the meeting. */
function clock(ms) {
    const total = Math.floor((ms || 0) / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Renders or updates one turn as it comes off the live socket. A revision reuses the element
 * already on screen for its turnId instead of duplicating it.
 */
const partials = ConcizeLiveRender.partialTracker();
let partialElement = null;

/** The one provisional line, shown until a final replaces it. */
function showPartial(text) {
    const shown = partials.onPartial({ text });
    if (!shown) return;

    transcriptionDisplayArea.classList.remove("hidden");
    if (!partialElement) {
        partialElement = document.createElement("div");
        partialElement.className = "turn partial";
        const speaker = document.createElement("span");
        speaker.className = "turn-speaker unnamed";
        speaker.textContent = "…";
        const body = document.createElement("div");
        const el = document.createElement("span");
        el.className = "turn-text";
        body.append(el);
        partialElement.append(speaker, body);
        transcriptTurns.append(partialElement);
    }
    partialElement.querySelector(".turn-text").textContent = shown;
}

/** Drops the provisional line once its final has arrived. */
function clearPartial() {
    partials.onFinal();
    if (partialElement) {
        partialElement.remove();
        partialElement = null;
    }
}

function showLiveTurn(turn) {
    clearPartial();
    transcriptionDisplayArea.classList.remove("hidden");

    let el = liveTurnElements.get(turn.turnId);
    if (!el) {
        el = document.createElement("div");

        const speaker = document.createElement("span");
        speaker.className = "turn-speaker unnamed";

        const body = document.createElement("div");
        const time = document.createElement("span");
        time.className = "turn-time";
        const text = document.createElement("span");
        text.className = "turn-text";
        body.append(time, text);

        el.append(speaker, body);
        transcriptTurns.append(el);
        liveTurnElements.set(turn.turnId, el);
    }

    el.className = turn.overlap ? "turn contested" : "turn";
    el.querySelector(".turn-speaker").textContent = turn.speaker || "unattributed";
    el.querySelector(".turn-time").textContent = `${clock(turn.t0)}  `;
    el.querySelector(".turn-text").textContent = turn.text;
}

/** Clears the live view for a fresh recording. A previously loaded meeting's turns are not this one's. */
function resetLiveTranscript() {
    clearPartial();
    liveTurnElements.clear();
    transcriptTurns.textContent = "";
    transcriptionDisplayArea.classList.add("hidden");
    downloadButtonWrapper.classList.add("hidden");
}

/** Surfaces a lane going up or down as a status message; 'down' reads as an error. */
function showLaneStatus({ lane, status, reason }) {
    showStatusMessage(reason ? `${lane} lane ${status}: ${reason}` : `${lane} lane ${status}`, status === "down");
}

/**
 * Renders speaker-attributed turns. Clicking a speaker names them, which is the only way a
 * name can ever be known: diarization can tell two voices apart but not whose they are.
 */
function renderTurns(utterances, meetingId) {
    liveTurnElements.clear();
    transcriptTurns.textContent = "";

    for (const u of utterances) {
        const turn = document.createElement("div");
        turn.className = u.overlap ? "turn contested" : "turn";

        const speaker = document.createElement("button");
        speaker.type = "button";
        speaker.className = u.speakerName && u.speakerName !== u.speaker
            ? "turn-speaker"
            : "turn-speaker unnamed";
        speaker.textContent = u.speakerName || u.speaker || "unattributed";
        speaker.title = u.speaker ? `Click to name ${u.speaker}` : "No speaker detected for this turn";
        if (u.speaker) {
            speaker.addEventListener("click", () => renameSpeaker(meetingId, u.speaker, u.speakerName));
        } else {
            speaker.disabled = true;
        }

        const body = document.createElement("div");
        const time = document.createElement("span");
        time.className = "turn-time";
        time.textContent = `${clock(u.t0)}  `;
        const text = document.createElement("span");
        text.className = "turn-text";
        text.textContent = u.text;
        body.append(time, text);

        turn.append(speaker, body);
        transcriptTurns.append(turn);
    }
}

/** Names one speaker, then re-renders so every turn of theirs updates at once. */
async function renameSpeaker(meetingId, label, current) {
    const name = prompt(`What is ${label} called?`, current && current !== label ? current : "");
    if (name === null) return;
    try {
        const res = await ConcizeAuth.authedFetch(
            `/api/v1/meetings/${meetingId}/speakers/${encodeURIComponent(label)}`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
            }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadTranscript(meetingId);
    } catch (err) {
        showStatusMessage(`Could not rename ${label}: ${err.message}`, true);
    }
}

/** Fetches the speaker-attributed log and renders it. */
async function loadTranscript(meetingId) {
    const res = await ConcizeAuth.authedFetch(`/api/v1/meetings/${meetingId}/utterances?limit=500`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP error! status: ${res.status}`);
    }

    const { utterances = [] } = await res.json();
    if (!utterances.length) return false;

    renderTurns(utterances, meetingId);
    // The download still writes plain text, which is what someone pasting it elsewhere wants.
    fullTranscriptionText = utterances
        .map((u) => `${u.speakerName || u.speaker || "unattributed"}: ${u.text}`)
        .join("\n");
    return true;
}

getTranscriptionButton.addEventListener("click", async () => {
    hideStatusMessage();
    hidePermissionMessage();
    downloadButtonWrapper.classList.add('hidden');

    try {
        const result = await chrome.storage.local.get('meetingId');
        const meetingId = result.meetingId;

        if (!meetingId) {
            showStatusMessage("No active recording session found. Please start a recording first.", true);
            return;
        }

        showStatusMessage("Fetching transcription...");

        if (await loadTranscript(meetingId)) {
            transcriptionDisplayArea.classList.remove('hidden');
            downloadButtonWrapper.classList.remove('hidden');
            showStatusMessage("Transcription loaded successfully.");
        } else {
            fullTranscriptionText = ''; // Keep empty to prevent downloading placeholder
            transcriptTurns.textContent = "No transcription available for this session yet.";
            transcriptionDisplayArea.classList.remove('hidden');
            downloadButtonWrapper.classList.add('hidden');
            showStatusMessage("No transcription available.", true);
        }
    } catch (error) {
        console.error("Error fetching transcription:", error);
        showStatusMessage(`Failed to get transcription: ${error.message}`, true);
        transcriptionDisplayArea.classList.add('hidden');
        downloadButtonWrapper.classList.add('hidden');
    }
});

downloadTranscriptionButton.addEventListener("click", async () => {
    if (!fullTranscriptionText) {
        showStatusMessage("No transcription text to download.", true);
        return;
    }
    
    try {
        const result = await chrome.storage.local.get('meetingId');
        const meetingId = result.meetingId || 'session';

        const blob = new Blob([fullTranscriptionText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `transcription-${meetingId}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
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
                updateUIForRecording(false);
                break;
            case "recording-stopped":
                updateUIForRecording(false);
                break;
            case "live-partial":
                showPartial(message.text);
                break;
            case "live-turn":
                showLiveTurn(message.turn);
                break;
            case "lane-status":
                showLaneStatus(message);
                break;
        }
    }
});