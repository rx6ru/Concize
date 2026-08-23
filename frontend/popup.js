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
const shareArea = document.getElementById("shareArea");
const shareList = document.getElementById("shareList");
const shareEmail = document.getElementById("shareEmail");
const shareButton = document.getElementById("shareButton");
// The meeting the share controls currently act on, set when one is opened.
let currentShareMeetingId = null;
// Opening a meeting fans out into several independent requests. Clicking a second meeting while
// the first is still loading used to let the slower chain finish and write its results over the
// newer one, so the share panel could end up bound to a meeting other than the one on screen --
// and sharing it would then grant a stranger access to the wrong meeting. Each open takes a
// number; a load that is no longer the current one discards its result instead of rendering it.
let openGeneration = 0;
const summaryDisplayArea = document.getElementById("summaryDisplayArea");
const summaryContent = document.getElementById("summaryContent");
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
            if (!await ConcizeAuth.hasBackendAccess() && !await ConcizeAuth.requestBackendAccess()) {
                return showAuthMessage("Concize needs access to your backend to work.");
            }
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

    // A recording that failed to start did so while this popup was closed, so the message saying
    // why went nowhere. The service worker kept it; show it once and clear it.
    if (!isCurrentlyRecording) {
        const { lastRecordingError } = await chrome.storage.local.get("lastRecordingError");
        if (lastRecordingError) {
            showStatusMessage(lastRecordingError, true);
            await chrome.storage.local.remove("lastRecordingError");
        }
    }
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

        // The token travels with the message because an offscreen document cannot read it itself:
        // MV3 gives offscreen documents chrome.runtime and nothing else, so chrome.storage is
        // undefined there and the session lookup it used to do threw before recording ever began.
        const session = await ConcizeAuth.getSession();
        if (!session) throw new Error("Not signed in.");

        chrome.runtime.sendMessage({
            type: "start-recording",
            target: "offscreen",
            data: {
                streamId: streamId,
                meetingId: meetingId,
                token: session.access_token
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
            // A row is a wrapper, not a button, because the delete control sits inside it and a
            // button nested in a button is invalid and does not reliably receive its own clicks.
            const wrapper = document.createElement("div");
            wrapper.className = "meeting-row";

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
            wrapper.append(row);

            // Shared with this account rather than owned by it: read and chat, nothing more, and
            // the server would answer a delete with a 403.
            if (m.shared) {
                const badge = document.createElement("span");
                badge.className = "meeting-status";
                badge.textContent = "shared";
                row.append(badge);
            } else if (m.status === "completed" || m.status === "completed_with_errors") {
                // Nothing to delete safely while the meeting is still being written to.
                wrapper.append(deleteControl(m));
            }

            meetingList.append(wrapper);
        }
        meetingListArea.classList.remove("hidden");
    } catch (err) {
        console.error("Could not list meetings:", err);
    }
}

/**
 * The delete control for one meeting row. Deleting removes the transcript and its vectors and
 * cannot be undone, so the first click only arms the button; the second one does it. An inline
 * confirm rather than window.confirm, which in an extension popup can dismiss the popup itself.
 */
function deleteControl(meeting) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "meeting-delete";
    button.textContent = "Delete";
    button.title = "Delete this meeting";

    let armed = false;
    let disarm = null;

    button.addEventListener("click", async () => {
        if (!armed) {
            armed = true;
            button.textContent = "Sure?";
            button.classList.add("armed");
            // Re-arming is deliberate friction, so a stray click cannot delete on the way past.
            disarm = setTimeout(() => {
                armed = false;
                button.textContent = "Delete";
                button.classList.remove("armed");
            }, 4000);
            return;
        }

        clearTimeout(disarm);
        button.disabled = true;
        button.textContent = "Deleting";
        try {
            const res = await ConcizeAuth.authedFetch(`/api/v1/meetings/${meeting.meetingId}`, {
                method: "DELETE",
            });
            // 404 means it is already gone, which is the outcome the user asked for.
            if (!res.ok && res.status !== 404) throw new Error(`server returned ${res.status}`);
            await loadMeetings();
        } catch (err) {
            console.error("Could not delete meeting:", err);
            showStatusMessage("Could not delete that meeting. Nothing was removed.", true);
            // Disarm as well as repaint. Leaving `armed` set put the button back to looking
            // untouched while still being one ordinary click away from deleting.
            armed = false;
            button.disabled = false;
            button.textContent = "Delete";
            button.classList.remove("armed");
        }
    });

    return button;
}

/**
 * Who the meeting is shared with. Owner-only on the server, which is what decides whether this
 * section appears at all: a 403 means the caller is a shared reader rather than the owner, and
 * sharing is not theirs to manage.
 */
async function loadShares(meetingId, generation) {
    shareArea.classList.add("hidden");
    shareList.textContent = "";
    try {
        const res = await ConcizeAuth.authedFetch(`/api/v1/meetings/${meetingId}/shares`, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) return;

        if (generation !== openGeneration) return;

        const { shares = [] } = await res.json();
        for (const share of shares) {
            const row = document.createElement("div");
            row.className = "share-row";

            const who = document.createElement("span");
            who.className = "share-who";
            // An account issued by Supabase has no local row to resolve an email from.
            who.textContent = share.email || share.userId;

            const revoke = document.createElement("button");
            revoke.type = "button";
            revoke.className = "share-revoke";
            revoke.textContent = "Revoke";
            revoke.addEventListener("click", async () => {
                revoke.disabled = true;
                try {
                    const del = await ConcizeAuth.authedFetch(
                        `/api/v1/meetings/${meetingId}/shares/${share.id}`,
                        { method: "DELETE" }
                    );
                    // Already revoked is the outcome that was asked for.
                    if (!del.ok && del.status !== 404) throw new Error(`server returned ${del.status}`);
                    await loadShares(meetingId);
                } catch (err) {
                    showStatusMessage(`Could not revoke access: ${err.message}`, true);
                    revoke.disabled = false;
                }
            });

            row.append(who, revoke);
            shareList.append(row);
        }

        if (!shares.length) {
            const empty = document.createElement("span");
            empty.className = "share-empty";
            empty.textContent = "Nobody yet.";
            shareList.append(empty);
        }

        currentShareMeetingId = meetingId;
        shareArea.classList.remove("hidden");
    } catch (err) {
        console.error("Could not load shares:", err);
    }
}


shareButton.addEventListener("click", async () => {
    const email = shareEmail.value.trim();
    if (!email || !currentShareMeetingId) return;

    shareButton.disabled = true;
    try {
        const res = await ConcizeAuth.authedFetch(`/api/v1/meetings/${currentShareMeetingId}/shares`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
        });
        if (!res.ok) throw new Error(`server returned ${res.status}`);

        // The server answers the same way whether or not that email has an account, so that this
        // cannot be used to find out who is registered. Say exactly that rather than implying it
        // worked.
        const { message } = await res.json();
        showStatusMessage(message || "Access granted if that email has an account.");
        shareEmail.value = "";
        await loadShares(currentShareMeetingId);
    } catch (err) {
        showStatusMessage(`Could not share this meeting: ${err.message}`, true);
    } finally {
        shareButton.disabled = false;
    }
});

/**
 * The meeting's summary, if there is one. Its own request and its own failure: a meeting with no
 * summary yet is the normal case while one is still being written, and it must not stop the
 * transcript from rendering.
 */
async function loadSummary(meetingId, generation) {
    summaryDisplayArea.classList.add("hidden");
    shareArea.classList.add("hidden");
    summaryContent.textContent = "";
    try {
        const res = await ConcizeAuth.authedFetch(`/api/v1/meetings/${meetingId}/summary`, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });
        // 404 is "not summarised yet", not a failure worth telling the user about.
        if (!res.ok || generation !== openGeneration) return;

        const { summary } = await res.json();
        if (!summary || !summary.content) return;

        // The summary is model output over a transcript, so it goes through the same hardened
        // renderer the chat answers use rather than into innerHTML raw.
        summaryContent.innerHTML = ConcizeMarkdown.renderSafe(summary.content);
        summaryDisplayArea.classList.remove("hidden");
    } catch (err) {
        console.error("Could not load summary:", err);
    }
}

/** Shows one meeting's transcript, whether or not it is the one being recorded. */
async function openMeeting(meetingId) {
    const generation = ++openGeneration;
    hideStatusMessage();
    showStatusMessage("Loading transcript...");
    try {
        // The chat window reads the meeting out of storage, and only starting a recording used to
        // write it. Opening an older meeting and asking a question answered it about whichever
        // meeting was recorded last, with nothing to indicate the mismatch.
        await chrome.storage.local.set({ meetingId });
        if (generation !== openGeneration) return;
        await loadSummary(meetingId, generation);
        await loadShares(meetingId, generation);
        if (generation !== openGeneration) return;
        if (await loadTranscript(meetingId, generation)) {
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
    summaryDisplayArea.classList.add("hidden");
    downloadButtonWrapper.classList.add("hidden");
}

/**
 * The audio transport's own state. 'open' is the normal case and says nothing; anything else
 * means frames are not reaching the backend, which the recording icon alone would not reveal.
 */
function showLiveStatus(message) {
    if (message.state === "open") {
        hideStatusMessage();
        return;
    }
    if (message.state === "error") {
        showStatusMessage("Lost the connection to the server. Reconnecting.", true);
        return;
    }
    if (message.state === "closed" && message.code !== 1000) {
        showStatusMessage(`Connection closed (${message.code}). Reconnecting.`, true);
    }
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

// The server caps a page at 500, which is roughly forty minutes of conversation. Asking once
// returned the first page and nothing said so, silently truncating both the transcript on screen
// and the file the download button writes. It has always taken an `after` cursor; now we use it.
const TRANSCRIPT_PAGE = 500;
// A meeting longer than this many utterances is being read by the wrong tool. The bound exists so
// a runaway cursor cannot spin forever, not because a real meeting is expected to reach it.
const TRANSCRIPT_MAX_PAGES = 40;

/** Fetches the speaker-attributed log and renders it. */
async function loadTranscript(meetingId, generation) {
    const utterances = [];
    let after = null;

    for (let page = 0; page < TRANSCRIPT_MAX_PAGES; page += 1) {
        const url = `/api/v1/meetings/${meetingId}/utterances?limit=${TRANSCRIPT_PAGE}`
            + (after === null ? "" : `&after=${after}`);
        const res = await ConcizeAuth.authedFetch(url, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP error! status: ${res.status}`);
        }

        const { utterances: batch = [], nextCursor = null } = await res.json();
        utterances.push(...batch);
        // The server sends nextCursor null rather than omitting it, precisely so this can tell
        // "no more pages" from "field missing" without guessing from the batch length.
        if (nextCursor === null || nextCursor === undefined) break;
        after = nextCursor;
    }

    if (generation !== undefined && generation !== openGeneration) return false;
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
            case "recording-degraded":
                // Recording continues on one source. Not an error, but the user has to know the
                // transcript will not cover what the missing half would have heard.
                showStatusMessage(message.source === "tab-only"
                    ? "No microphone. Recording meeting audio only."
                    : "No meeting audio. Recording your microphone only.");
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
            case "live-status":
                showLiveStatus(message);
                break;
        }
    }
});

// Exported for tests; the extension loads this file as a plain script and uses none of it.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        openMeeting,
        loadShares,
        deleteControl,
        currentShare: () => currentShareMeetingId,
    };
}
