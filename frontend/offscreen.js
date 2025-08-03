// This script runs in the offscreen document.
// It establishes a persistent connection with the background script.

// Establish a connection with the background script
const port = chrome.runtime.connect({ name: 'offscreen' });

let audioContext;
let mediaStream;
let processor;
let intervalId;
let audioBuffer = [];
const sampleRate = 44100;
const bufferSize = 4096;

// Listen for messages from the background script via the port
port.onMessage.addListener((msg) => {
    switch (msg.type) {
        case 'start-recording':
            startRecording(msg.streamId);
            break;
        case 'stop-recording':
            stopRecording();
            break;
    }
});

async function startRecording(streamId) {
    if (audioContext) {
        console.warn('Recording is already in progress.');
        return;
    }

    console.log('Offscreen: Received start command.');
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId
                }
            }
        });

        audioContext = new AudioContext({ sampleRate: sampleRate });
        const source = audioContext.createMediaStreamSource(mediaStream);
        processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

        processor.onaudioprocess = (e) => {
            const pcmData = e.inputBuffer.getChannelData(0);
            audioBuffer.push(new Float32Array(pcmData));
        };
        
        source.connect(processor);
        processor.connect(audioContext.destination);

        // Every 60 seconds, process the buffered audio
        intervalId = setInterval(processAudioBuffer, 60000);

        console.log('Offscreen recording started successfully.');

    } catch (error) {
        console.error('Offscreen Error: Failed to start recording.', error);
    }
}

function stopRecording() {
    console.log('Offscreen: Received stop command.');
    if (!audioContext) return;

    // Stop the interval and process any remaining audio
    clearInterval(intervalId);
    intervalId = null;
    processAudioBuffer(); // Process the final chunk

    // Crucially, stop all media tracks to remove the "sharing" indicator
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        console.log('Media stream tracks stopped.');
    }

    // Clean up audio context resources
    processor.disconnect();
    audioContext.close().then(() => {
        console.log('AudioContext closed.');
        // Disconnect the port and close the offscreen document
        port.disconnect();
        window.close();
    });
}

function processAudioBuffer() {
    if (audioBuffer.length === 0) return;
    console.log(`Processing audio buffer of length ${audioBuffer.length}`);

    const totalLength = audioBuffer.reduce((acc, val) => acc + val.length, 0);
    const combinedBuffer = new Float32Array(totalLength);
    let offset = 0;
    for (const buffer of audioBuffer) {
        combinedBuffer.set(buffer, offset);
        offset += buffer.length;
    }
    
    audioBuffer = []; // Clear the buffer

    encodeFloat32ToMp3(combinedBuffer);
}

function encodeFloat32ToMp3(pcmData) {
    try {
        const encoder = new lamejs.Mp3Encoder(1, sampleRate, 128); // mono, 44100hz, 128kbps
        const samples = new Int16Array(pcmData.length);
        for (let i = 0; i < pcmData.length; i++) {
            samples[i] = pcmData[i] * 32767;
        }

        const mp3Data = [];
        const sampleBlockSize = 1152; // MP3 frame size

        for (let i = 0; i < samples.length; i += sampleBlockSize) {
            const sampleChunk = samples.subarray(i, i + sampleBlockSize);
            const mp3buf = encoder.encodeBuffer(sampleChunk);
            if (mp3buf.length > 0) mp3Data.push(mp3buf);
        }
        
        const mp3buf = encoder.flush();
        if (mp3buf.length > 0) mp3Data.push(mp3buf);

        const mp3Blob = new Blob(mp3Data, { type: 'audio/mpeg' });
        
        const reader = new FileReader();
        reader.onloadend = () => {
            // Send the encoded chunk back to the background script
            port.postMessage({ type: 'audio-chunk', data: reader.result });
        };
        reader.readAsDataURL(mp3Blob);
    } catch (error) {
        console.error("Offscreen Error: MP3 encoding failed.", error);
    }
}
