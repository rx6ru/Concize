let liveClient = null;
let captureSource = null;
let captureNode = null;
let captureSink = null;
let activeStreams = [];
let currentMeetingId;
let audioContext = null;

// Guarded so the file can be required by a test, where there is no extension runtime to listen on.
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target === "offscreen") {
    switch (message.type) {
      case "start-recording":
        currentMeetingId = message.data.meetingId;
        await startRecording(message.data.streamId);
        break;
      case "stop-recording":
        await stopRecording();
        break;
      default:
        console.warn(`Unrecognized message: ${message.type}`);
        break;
    }
  }
});
}

async function startRecording(streamId) {
  console.log("Starting recording process...");
  if (liveClient) {
    console.warn("startRecording called while a client is already active.");
    return;
  }

  const mediaStream = await getMediaStream(streamId);
  if (!mediaStream) {
    return; // Error already handled in getMediaStream
  }

  const session = await ConcizeAuth.getSession();
  if (!session) {
    chrome.runtime.sendMessage({
      type: "recording-error",
      target: "popup",
      error: "Not signed in.",
    });
    await stopAllStreams();
    return;
  }

  liveClient = new ConcizeLiveClient.LiveClient({
    backendUrl: CONCIZE_CONFIG.BACKEND_URL,
    meetingId: currentMeetingId,
    token: session.access_token,
    onEvent: handleServerEvent,
    onStatus: (status) => console.log("LiveClient status:", status.state, status.code ?? ""),
  });
  liveClient.start();

  try {
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL("audio-capture.worklet.js"));
  } catch (error) {
    console.error("Error loading capture worklet:", error);
    chrome.runtime.sendMessage({
      type: "recording-error",
      target: "popup",
      error: `Capture setup failed: ${error.message}`,
    });
    liveClient.stop();
    liveClient = null;
    await stopAllStreams();
    return;
  }

  captureSource = audioContext.createMediaStreamSource(mediaStream);
  captureNode = new AudioWorkletNode(audioContext, "capture-processor");
  captureNode.port.onmessage = (event) => {
    liveClient.pushAudio(event.data, audioContext.sampleRate);
  };
  captureSource.connect(captureNode);

  // Chrome only pulls a node's process() callback if it's reachable from the destination.
  // Silent, so this doesn't add anything to what the user hears on top of getMediaStream's own tabGain->destination path.
  captureSink = audioContext.createGain();
  captureSink.gain.value = 0;
  captureNode.connect(captureSink).connect(audioContext.destination);

  window.location.hash = "recording";
  chrome.runtime.sendMessage({
    type: "update-icon",
    target: "service-worker",
    recording: true,
  });
}

async function stopRecording() {
  console.log("Stopping recording process...");

  if (captureNode) {
    captureSource.disconnect();
    captureNode.disconnect();
    captureSink.disconnect();
    captureNode.port.onmessage = null;
    captureSource = null;
    captureNode = null;
    captureSink = null;
  }

  if (liveClient) {
    liveClient.stop();
    liveClient = null;
  }

  await stopAllStreams();
  window.location.hash = "";

  chrome.runtime.sendMessage({
    type: "update-icon",
    target: "service-worker",
    recording: false,
  });
  chrome.runtime.sendMessage({
    type: "recording-stopped",
    target: "service-worker",
  });
  console.log("Recording process stopped.");
}

/** Forwards the events worth showing live in the popup; session.ready and watermark stay internal. */
function handleServerEvent(msg) {
  switch (msg.type) {
    // Volatile and unattributed, and the only thing standing between a speaker and the six second
    // median wait for a final. Shown as one provisional line the final then replaces.
    case "partial":
      chrome.runtime.sendMessage({ type: "live-partial", target: "popup", text: msg.text });
      break;
    case "final":
    case "revision":
      chrome.runtime.sendMessage({
        type: "live-turn",
        target: "popup",
        turn: {
          turnId: msg.turnId,
          text: msg.text,
          t0: msg.t0,
          t1: msg.t1,
          speaker: msg.speaker,
          overlap: msg.overlap,
        },
      });
      break;
    case "lane.status":
      chrome.runtime.sendMessage({
        type: "lane-status",
        target: "popup",
        lane: msg.lane,
        status: msg.status,
        reason: msg.reason,
      });
      break;
    case "error":
      if (msg.fatal) {
        chrome.runtime.sendMessage({
          type: "recording-error",
          target: "popup",
          error: `Realtime session error: ${msg.code}`,
        });
      }
      break;
  }
}

// Tab audio and microphone are acquired independently, because losing one is not a reason to lose
// the other. A machine with no microphone, or a denied mic prompt, used to take the tab down with
// it and record nothing at all -- which is the worse half to lose, since the tab carries everyone
// else in the meeting.
async function getMediaStream(streamId) {
  await stopAllStreams();

  let tabStream = null;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
  } catch (error) {
    console.warn("Tab audio unavailable:", error.message);
  }

  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (error) {
    console.warn("Microphone unavailable:", error.message);
  }

  if (!tabStream && !micStream) {
    console.error("Error getting media stream: no audio source available");
    chrome.runtime.sendMessage({
      type: "recording-error",
      target: "popup",
      error: "Stream setup failed: neither tab audio nor microphone is available.",
    });
    return null;
  }

  if (tabStream) activeStreams.push(tabStream);
  if (micStream) activeStreams.push(micStream);

  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  if (tabStream) {
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    const tabGain = audioContext.createGain();
    tabGain.gain.value = 1.0;
    tabSource.connect(tabGain).connect(destination);
    // The mixed stream goes to the recorder; this second hop is what keeps the tab audible to the user.
    tabGain.connect(audioContext.destination);
  }

  if (micStream) {
    const micSource = audioContext.createMediaStreamSource(micStream);
    const micGain = audioContext.createGain();
    micGain.gain.value = 1.5;
    micSource.connect(micGain).connect(destination);
  }

  // Recording on one source is worth doing and worth saying out loud, so the user is not left
  // believing the transcript covers a room it never heard.
  if (!tabStream || !micStream) {
    chrome.runtime.sendMessage({
      type: "recording-degraded",
      target: "popup",
      source: tabStream ? "tab-only" : "microphone-only",
    });
  }

  return destination.stream;
}

async function stopAllStreams() {
  activeStreams.forEach((stream) => {
    stream.getTracks().forEach((track) => track.stop());
  });
  activeStreams = [];
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  await new Promise(resolve => setTimeout(resolve, 100)); // Short delay to ensure tracks are released
}

// Exported for tests; the extension loads this file as a plain script and uses neither.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { getMediaStream, stopAllStreams };
}
