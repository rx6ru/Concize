// Constants
const CHUNK_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const OVERLAP_MS = 30 * 1000; // 30 seconds

// State
let recorderA, recorderB;
let dataA = [], dataB = [];
let activeStreams = [];
let currentMeetingId;
let stopTimeouts = [];
let userStopped = false;
let audioContext = null;
let lastChunkSent = false;
let globalStartTimeMs = 0;

// Entry point for messages from other parts of the extension
chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target === "offscreen") {
    switch (message.type) {
      case "start-recording":
        userStopped = false; // Reset flag on new recording
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

// Main function to start the recording process
async function startRecording(streamId) {
  console.log("Starting recording process...");
  if (recorderA || recorderB) {
    console.warn("startRecording called while a recorder is already active.");
    return;
  }

  // Get the combined media stream
  const mediaStream = await getMediaStream(streamId);
  if (!mediaStream) {
    return; // Error already handled in getMediaStream
  }

  // Anchor the global meeting start time
  globalStartTimeMs = Date.now();

  // Start the first recorder cycle
  runRecorderCycle('A', mediaStream);

  window.location.hash = "recording";
  chrome.runtime.sendMessage({
    type: "update-icon",
    target: "service-worker",
    recording: true,
  });
}

// Main function to stop the recording process
async function stopRecording() {
  console.log("Stopping recording process...");
  userStopped = true;

  // Stop all running recorders
  if (recorderA?.state === 'recording') {
    recorderA.stop();
  }
  if (recorderB?.state === 'recording') {
    recorderB.stop();
  }

  // Clear any pending timeouts to prevent new recorders from starting
  stopTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
  stopTimeouts = [];

  // Stop all underlying media stream tracks
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

// Manages the lifecycle of a single recorder
function runRecorderCycle(recorderName, stream) {
  console.log(`Starting cycle for recorder ${recorderName}`);
  const isRecorderA = recorderName === 'A';

  // 1. Create and start the recorder
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  let dataBuffer = isRecorderA ? dataA : dataB;
  dataBuffer.length = 0; // Clear previous data

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      dataBuffer.push(event.data);
    }
  };

  // Capture the moment this specific chunk begins recording
  const chunkStartTimeMs = Date.now() - globalStartTimeMs;

  recorder.onstop = () => {
    const isLast = userStopped && !lastChunkSent;
    if (isLast) lastChunkSent = true;
    console.log(`Recorder ${recorderName} stopped. isLast: ${isLast}, offsetMs: ${chunkStartTimeMs}`);
    sendAudioChunk(new Blob(dataBuffer, { type: 'audio/webm' }), isLast, chunkStartTimeMs);
    dataBuffer.length = 0; // Clear buffer after sending
    if (isRecorderA) recorderA = null;
    else recorderB = null;
  };

  if (isRecorderA) recorderA = recorder;
  else recorderB = recorder;

  recorder.start();
  console.log(`Recorder ${recorderName} started. Offset: ${chunkStartTimeMs}ms`);

  // 2. Schedule the *other* recorder to start with an overlap
  const nextRecorderName = isRecorderA ? 'B' : 'A';
  const startNextTimeout = setTimeout(() => {
    runRecorderCycle(nextRecorderName, stream);
  }, CHUNK_DURATION_MS - OVERLAP_MS);
  stopTimeouts.push(startNextTimeout);

  // 3. Schedule this recorder to stop
  const stopThisTimeout = setTimeout(() => {
    if (recorder.state === 'recording') {
      recorder.stop();
    }
  }, CHUNK_DURATION_MS);
  stopTimeouts.push(stopThisTimeout);
}

// Handles sending the audio blob to the backend
async function sendAudioChunk(audioBlob, isLastChunk = false, chunkStartTimeMs = 0) {
  if (audioBlob.size === 0) {
    console.log("Skipping empty audio chunk.");
    return;
  }

  const offsetSeconds = (chunkStartTimeMs / 1000).toFixed(3);
  console.log(`Preparing to send audio chunk of size ${audioBlob.size}, isLast: ${isLastChunk}, offset: M${offsetSeconds}s`);

  const formData = new FormData();
  formData.append('audio', audioBlob, `recording-${new Date().toISOString()}.webm`);

  try {
    if (!currentMeetingId) {
      throw new Error("No meeting ID found for sending chunk.");
    }

    const response = await ConcizeAuth.authedFetch(`/api/v1/meetings/${currentMeetingId}/audio`, {
      method: 'POST',
      headers: {
        'x-last-chunk': isLastChunk.toString(),
        'x-audio-offset': offsetSeconds.toString()
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to upload audio: ${response.status} ${errorText}`);
    }
    console.log("Audio chunk uploaded successfully.");
  } catch (error) {
    console.error("Error uploading audio chunk:", error);
    chrome.runtime.sendMessage({
      type: "recording-error",
      target: "popup",
      error: `Upload failed: ${error.message}`,
    });
  }
}

// Helper to get the combined tab and mic stream
async function getMediaStream(streamId) {
  await stopAllStreams();
  try {
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });

    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });

    activeStreams.push(tabStream, micStream);

    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();

    const tabSource = audioContext.createMediaStreamSource(tabStream);
    const tabGain = audioContext.createGain();
    tabGain.gain.value = 1.0;
    tabSource.connect(tabGain).connect(destination);

    const micSource = audioContext.createMediaStreamSource(micStream);
    const micGain = audioContext.createGain();
    micGain.gain.value = 1.5;
    micSource.connect(micGain).connect(destination);

    // This is a mixed stream, but we also need to connect tab audio to speakers
    tabGain.connect(audioContext.destination);

    return destination.stream;
  } catch (error) {
    console.error("Error getting media stream:", error);
    chrome.runtime.sendMessage({
      type: "recording-error",
      target: "popup",
      error: `Stream setup failed: ${error.message}`,
    });
    return null;
  }
}

// Helper to stop all active stream tracks
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
