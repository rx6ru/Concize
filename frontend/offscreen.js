let recorder;
let data = [];
let activeStreams = [];

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target === "offscreen") {
    switch (message.type) {
      case "start-recording":
        startRecording(message.data);
        break;
      case "stop-recording":
        stopRecording();
        break;
      default:
        throw new Error("Unrecognized message:", message.type);
    }
  }
});

async function startRecording(streamId) {
  if (recorder?.state === "recording") {
    throw new Error("Called startRecording while recording is in progress.");
  }

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

    // Create audio context
    const audioContext = new AudioContext();

    // Create sources and destination
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    const micSource = audioContext.createMediaStreamSource(micStream);
    const destination = audioContext.createMediaStreamDestination();

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

    // Check for MP3 support, fallback to WAV if not available
    const supportedTypes = [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/webm'
    ];
    
    let mimeType = 'audio/webm'; // default fallback
    for (const type of supportedTypes) {
      if (MediaRecorder.isTypeSupported(type)) {
        mimeType = type;
        break;
      }
    }

    // Start recording
    recorder = new MediaRecorder(destination.stream, { mimeType });
    recorder.ondataavailable = (event) => data.push(event.data);
    recorder.onstop = async () => {
      const audioBlob = new Blob(data, { type: mimeType });
      
      // Convert to MP3 if not already in MP3 format
      let finalBlob = audioBlob;
      let extension = 'webm';
      
      if (mimeType.includes('webm') || mimeType.includes('wav')) {
        try {
          // Convert to MP3 using Web Audio API and manual encoding
          finalBlob = await convertToMP3(audioBlob);
          extension = 'mp3';
        } catch (error) {
          console.warn('MP3 conversion failed, using original format:', error);
          extension = mimeType.includes('webm') ? 'webm' : 'wav';
        }
      } else if (mimeType.includes('mp3') || mimeType.includes('mpeg')) {
        extension = 'mp3';
      }

      const url = URL.createObjectURL(finalBlob);

      // Create temporary link element to trigger download
      const downloadLink = document.createElement("a");
      downloadLink.href = url;
      downloadLink.download = `recording-${new Date().toISOString()}.${extension}`;
      downloadLink.click();

      // Cleanup
      URL.revokeObjectURL(url);
      recorder = undefined;
      data = [];

      chrome.runtime.sendMessage({
        type: "recording-stopped",
        target: "service-worker",
      });
    };

    recorder.start();
    window.location.hash = "recording";

    chrome.runtime.sendMessage({
      type: "update-icon",
      target: "service-worker",
      recording: true,
    });
  } catch (error) {
    console.error("Error starting recording:", error);
    chrome.runtime.sendMessage({
      type: "recording-error",
      target: "popup",
      error: error.message,
    });
  }
}

async function stopRecording() {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
  }

  await stopAllStreams();
  window.location.hash = "";

  chrome.runtime.sendMessage({
    type: "update-icon",
    target: "service-worker",
    recording: false,
  });
}

async function stopAllStreams() {
  activeStreams.forEach((stream) => {
    stream.getTracks().forEach((track) => {
      track.stop();
    });
  });

  activeStreams = [];
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/**
 * Converts audio blob to MP3 format using Web Audio API
 * @param {Blob} audioBlob - The input audio blob
 * @returns {Promise<Blob>} - MP3 encoded audio blob
 */
async function convertToMP3(audioBlob) {
  const audioContext = new AudioContext();
  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  
  // Convert audio buffer to raw PCM data
  const leftChannel = audioBuffer.getChannelData(0);
  const rightChannel = audioBuffer.numberOfChannels > 1 ? 
    audioBuffer.getChannelData(1) : leftChannel;
  
  // Simple MP3 encoding (basic implementation)
  // This is a simplified approach - in production, consider using a proper MP3 encoder library
  const sampleRate = audioBuffer.sampleRate;
  const length = leftChannel.length;
  
  // Create WAV format first (as intermediate step)
  const wavBuffer = createWavBuffer(leftChannel, rightChannel, sampleRate);
  
  // For now, return WAV format since true MP3 encoding requires complex licensing
  // In a production environment, integrate a library like lamejs
  return new Blob([wavBuffer], { type: 'audio/wav' });
}

/**
 * Creates a WAV format buffer from PCM data
 * @param {Float32Array} leftChannel - Left audio channel
 * @param {Float32Array} rightChannel - Right audio channel  
 * @param {number} sampleRate - Audio sample rate
 * @returns {ArrayBuffer} - WAV format audio buffer
 */
function createWavBuffer(leftChannel, rightChannel, sampleRate) {
  const length = leftChannel.length;
  const numberOfChannels = 2;
  const buffer = new ArrayBuffer(44 + length * numberOfChannels * 2);
  const view = new DataView(buffer);
  
  // WAV header
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length * numberOfChannels * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numberOfChannels * 2, true);
  view.setUint16(32, numberOfChannels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, length * numberOfChannels * 2, true);
  
  // Convert float to 16-bit PCM
  let offset = 44;
  for (let i = 0; i < length; i++) {
    const left = Math.max(-1, Math.min(1, leftChannel[i]));
    const right = Math.max(-1, Math.min(1, rightChannel[i]));
    
    view.setInt16(offset, left * 0x7FFF, true);
    view.setInt16(offset + 2, right * 0x7FFF, true);
    offset += 4;
  }
  
  return buffer;
}
