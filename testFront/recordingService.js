/**
 * Recording Service for Chrome Extension
 * Handles continuous audio recording with parallel chunk uploads
 */

class RecordingService {
    constructor() {
        this.isRecording = false;
        this.currentJobId = null;
        this.recorder = null;
        this.audioContext = null;
        this.tabStream = null;
        this.micStream = null;
        this.uploadQueue = [];
        this.chunkCounter = 0;
        this.recordingInterval = null;
        this.backendUrl = 'http://localhost:3000'; // Adjust as needed
    }

    /**
     * Start a new meeting session and begin continuous recording
     */
    async startRecordingSession() {
        // ADDED CHECK: Prevent starting a new session if one is already active
        if (this.isRecording) {
            console.warn('A recording session is already active.');
            return { success: false, error: 'Cannot start a new recording while one is in progress.' };
        }

        try {
            // Step 1: Start meeting session to get jobId
            const meetingResponse = await fetch(`${this.backendUrl}/api/meeting/start`, {
                method: 'POST',
                credentials: 'include' // Important for cookies
            });

            if (!meetingResponse.ok) {
                throw new Error('Failed to start meeting session');
            }

            const meetingData = await meetingResponse.json();
            this.currentJobId = meetingData.jobId;

            console.log('Meeting session started with jobId:', this.currentJobId);

            // Set the recording flag to true immediately to prevent re-entry
            this.isRecording = true;

            // Step 2: Set up audio streams
            const mixedStream = await this.setupAudioStreams();
            
            // Step 3: Start continuous recording
            await this.startContinuousRecording(mixedStream);

            return { success: true, jobId: this.currentJobId };

        } catch (error) {
            console.error('Error starting recording session:', error);
            // Ensure the recording flag is reset on failure
            this.isRecording = false; 
            return { success: false, error: error.message };
        }
    }

    /**
     * Set up audio streams for recording
     */
    async setupAudioStreams() {
        try {
            // Get tab audio stream
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

            this.tabStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: "tab",
                        chromeMediaSourceId: streamId,
                    },
                },
                video: false,
            });

            // Get microphone stream
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
                video: false,
            });

            // Create audio context and mix streams
            this.audioContext = new AudioContext();

            const tabSource = this.audioContext.createMediaStreamSource(this.tabStream);
            const micSource = this.audioContext.createMediaStreamSource(this.micStream);
            const destination = this.audioContext.createMediaStreamDestination();

            const tabGain = this.audioContext.createGain();
            const micGain = this.audioContext.createGain();

            tabGain.gain.value = 1.0;
            micGain.gain.value = 1.5;

            tabSource.connect(tabGain);
            tabGain.connect(destination);

            micSource.connect(micGain);
            micGain.connect(destination);

            return destination.stream;

        } catch (error) {
            console.error('Error setting up audio streams:', error);
            throw error;
        }
    }

    /**
     * Start continuous recording with chunk-based uploads
     */
    async startContinuousRecording(mixedStream) {
        try {
            // Configure MediaRecorder for 10-minute chunks
            const options = {
                mimeType: 'audio/webm;codecs=opus',
                audioBitsPerSecond: 128000
            };

            this.recorder = new MediaRecorder(mixedStream, options);
            // The isRecording flag is now set in startRecordingSession()
            // this.isRecording = true;

            this.recorder.ondataavailable = async (event) => {
                if (event.data.size > 0) {
                    await this.handleChunkUpload(event.data);
                }
            };

            // Start recording with 10-minute chunks (600000ms)
            this.recorder.start(600000);

            console.log('Continuous recording started');

        } catch (error) {
            console.error('Error starting continuous recording:', error);
            // Ensure the recording flag is reset on failure
            this.isRecording = false;
            throw error;
        }
    }

    /**
     * Handle chunk upload in parallel
     */
    async handleChunkUpload(chunkBlob) {
        const chunkNumber = ++this.chunkCounter;
        const fileName = `chunk_${this.currentJobId}_${chunkNumber}_${Date.now()}.webm`;

        console.log(`Uploading chunk ${chunkNumber}...`);

        // Create FormData for upload
        const formData = new FormData();
        formData.append('audio', chunkBlob, fileName);

        try {
            // Upload chunk in parallel (non-blocking)
            const uploadPromise = fetch(`${this.backendUrl}/api/audio/`, {
                method: 'POST',
                body: formData,
                credentials: 'include' // Include cookies with jobId
            });

            // Add to upload queue for tracking
            this.uploadQueue.push({
                chunkNumber,
                uploadPromise,
                fileName,
                timestamp: new Date().toISOString()
            });

            // Process upload queue in background
            this.processUploadQueue();

        } catch (error) {
            console.error(`Error uploading chunk ${chunkNumber}:`, error);
        }
    }

    /**
     * Process upload queue to handle parallel uploads
     */
    async processUploadQueue() {
        // Use a flag to prevent multiple instances from running
        if (this._isProcessingQueue) return;
        this._isProcessingQueue = true;

        while (this.uploadQueue.length > 0) {
            const uploadItem = this.uploadQueue.shift();

            try {
                const response = await uploadItem.uploadPromise;

                if (response.ok) {
                    console.log(`Chunk ${uploadItem.chunkNumber} uploaded successfully`);
                } else {
                    console.error(`Chunk ${uploadItem.chunkNumber} upload failed:`, response.status);
                }

            } catch (error) {
                console.error(`Chunk ${uploadItem.chunkNumber} upload error:`, error);
            }
        }
        this._isProcessingQueue = false;
    }

    /**
     * Stop recording and upload final chunk
     */
    async stopRecordingSession() {
        if (!this.isRecording) {
            return { success: false, error: 'Not currently recording' };
        }

        try {
            // Stop recorder
            if (this.recorder && this.recorder.state === 'recording') {
                this.recorder.stop();
            }

            // Clean up streams
            if (this.tabStream) {
                this.tabStream.getTracks().forEach(track => track.stop());
            }
            if (this.micStream) {
                this.micStream.getTracks().forEach(track => track.stop());
            }
            if (this.audioContext) {
                await this.audioContext.close();
            }

            this.isRecording = false;

            // Stop meeting session
            const stopResponse = await fetch(`${this.backendUrl}/api/meeting/stop`, {
                method: 'POST',
                credentials: 'include'
            });

            if (stopResponse.ok) {
                console.log('Meeting session stopped successfully');
            }

            return { success: true, message: 'Recording session stopped' };

        } catch (error) {
            console.error('Error stopping recording session:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get current recording status
     */
    getStatus() {
        return {
            isRecording: this.isRecording,
            jobId: this.currentJobId,
            chunkCount: this.chunkCounter,
            pendingUploads: this.uploadQueue.length
        };
    }

    /**
     * Check if all uploads are complete
     */
    async waitForAllUploads() {
        await this.processUploadQueue();
        return this.uploadQueue.length === 0;
    }
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RecordingService;
} else {
    window.RecordingService = RecordingService;
}