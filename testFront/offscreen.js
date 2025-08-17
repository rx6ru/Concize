let activeStreams = [];
let audioContext;
let destination;

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target === "offscreen") {
    switch (message.type) {
      case "get-audio-stream":
        return getAudioStream(message.data);
      case "cleanup-streams":
        await stopAllStreams();
        return { success: true };
      default:
        throw new Error("Unrecognized message:", message.type);
    }
  }
});

async function getAudioStream(streamId) {
  await stopAllStreams();

  try {
    // Get tab audio stream
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    // Get microphone stream with noise cancellation
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    activeStreams.push(tabStream, micStream);

    // Create audio context if not exists
    if (!audioContext) {
      audioContext = new AudioContext();
    }

    // Create sources and destination
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    const micSource = audioContext.createMediaStreamSource(micStream);
    destination = audioContext.createMediaStreamDestination();

    // Create gain nodes
    const tabGain = audioContext.createGain();
    const micGain = audioContext.createGain();

    // Set gain values
    tabGain.gain.value = 1.0; // Normal tab volume
    micGain.gain.value = 1.5; // Slightly boosted mic volume

    // Connect tab audio to both speakers and recorder
    tabSource.connect(tabGain);
    tabGain.connect(audioContext.destination);
    tabGain.connect(destination);

    // Connect mic to recorder only (prevents echo)
    micSource.connect(micGain);
    micGain.connect(destination);

    return {
      success: true,
      stream: destination.stream
    };
  } catch (error) {
    console.error("Error getting audio stream:", error);
    return {
      success: false,
      error: error.message
    };
  }
}

async function stopAllStreams() {
  activeStreams.forEach((stream) => {
    stream.getTracks().forEach((track) => {
      track.stop();
    });
  });

  activeStreams = [];
  
  if (audioContext) {
    audioContext.close();
    audioContext = null;
    destination = null;
  }
  
  await new Promise((resolve) => setTimeout(resolve, 100));
}
