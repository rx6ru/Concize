// controllers/worker.js

const amqp = require("amqplib");
const { transcribe } = require("./transcription");
const { clean } = require("./clean");
const { upsertTranscriptionChunks } = require("./embedding/embedTranscriptions");
const { createTranCollection } = require("./embedding/embedTranscriptions");
const { createChatCollection } = require("./embedding/embedChat");
const { appendTranscription, getMeetingStatus } = require("../db/mongoutils/transcription.db");
const {
  fetchAudioFile,
  deleteAudioFile,
  initialiseCloudinary,
} = require("../db/cloudinary-utils/audio.db"); // Cloudinary utils
const config = require("../utils/config");

const audioQueue = "audio_queue";
const CLOUDAMQP_URL = config.CLOUDAMQP_URL;

let globalConnection = null;
let globalChannel = null;

/**
 * @description Starts the persistent worker that consumes audio transcription jobs from the RabbitMQ queue.
 */
const startWorker = async () => {
  try {
    // Initialise Cloudinary once
    initialiseCloudinary();

    console.log("Worker: Attempting to connect to RabbitMQ...");
    globalConnection = await amqp.connect(CLOUDAMQP_URL);
    globalChannel = await globalConnection.createChannel();

    globalConnection.on("close", (err) => {
      console.error("Worker: RabbitMQ connection closed unexpectedly:", err);
    });
    globalChannel.on("close", (err) => {
      console.error("Worker: RabbitMQ channel closed unexpectedly:", err);
    });

    await globalChannel.assertQueue(audioQueue, { durable: true });

    console.log("Worker: Initializing Qdrant collections...");
    await createTranCollection();
    await createChatCollection();

    console.log("Worker: Connected to RabbitMQ and waiting for audio transcription jobs...");
    globalChannel.prefetch(1);

    globalChannel.consume(
      audioQueue,
      async (msg) => {
        console.log("Worker: Received a message from the queue.");
        if (msg === null) {
          console.log("Worker: Consumer cancelled. No message received.");
          return;
        }

        let messageContent;
        let fileId;
        let metadata = {};
        let jobId;

        try {
          // Parse message
          const messageString = msg.content.toString();
          messageContent = JSON.parse(messageString);
          console.log("Worker: Message content parsed successfully.");

          jobId = messageContent.jobId;
          fileId = messageContent.fileId; // Cloudinary publicId
          metadata = messageContent.metadata || {};

          console.log(`Worker: Processing job - JobId: ${jobId}, FileId: ${fileId}`);

          // Ensure meeting is still active
          const meetingStatus = await getMeetingStatus(jobId);
          if (meetingStatus === "completed") {
            console.log(
              `Worker: Skipping job for jobId ${jobId}. Meeting is already completed.`
            );
            await deleteAudioFile(fileId);
            globalChannel.ack(msg);
            return;
          }

          console.log(
            `Worker: Received job for audio file with ID: ${fileId} for jobId: ${jobId}`
          );

          // Fetch audio file from Cloudinary → returns Buffer
          console.log(`Worker: Fetching audio file from Cloudinary...`);
          const audioBuffer = await fetchAudioFile(fileId);
          console.log(
            `Worker: Audio buffer fetched from Cloudinary. Size: ${audioBuffer.length} bytes. Original file: ${metadata.originalFileName || 'unknown'}`
          );

          // Transcribe
          console.log(
            `Worker: Processing transcription for: ${metadata.originalFileName || "unknown file"}`
          );
          const transcribeResult = await transcribe(audioBuffer, metadata);
          if (!transcribeResult.success) {
            throw new Error(`Transcription failed: ${transcribeResult.error}`);
          }
          const transcribedText = transcribeResult.transcription;
          console.log(`Worker: Transcription completed. Text length: ${transcribedText?.length || 0} characters`);

          // Save transcription
          if (transcribedText && transcribedText.trim().length > 0) {
            const appendResult = await appendTranscription(jobId, transcribedText);
            if (!appendResult) {
              throw new Error(
                `Failed to append transcription to MongoDB for jobId: ${jobId}`
              );
            }
            console.log(
              `Worker: Transcription appended to MongoDB for jobId: ${jobId}`
            );
          } else {
            console.warn(
              `Worker: No text to append for jobId: ${jobId}. Skipping database update.`
            );
          }

          // Clean & Embed
          if (transcribedText && transcribedText.trim().length > 0) {
            console.log(`Worker: Cleaning transcription text...`);
            const cleanedChunks = await clean(transcribedText);
            console.log(
              `Worker: Cleaned transcript into ${cleanedChunks.length} structured chunks.`
            );

            if (cleanedChunks.length > 0) {
              console.log(`Worker: Embedding transcription chunks...`);
              const embedResult = await upsertTranscriptionChunks(
                jobId,
                cleanedChunks,
                metadata
              );
              if (!embedResult.success) {
                throw new Error(
                  `Embedding and upsert failed: ${embedResult.error}`
                );
              }
              console.log(`Worker: Embedding completed successfully.`);
            }
          }

          console.log(
            `Worker: Transcription processed and embedded successfully for "${
              metadata.originalFileName || "unknown"
            }"`
          );

          // Delete from Cloudinary
          await deleteAudioFile(fileId);
          console.log(
            `Worker: Deleted processed audio file and metadata for ID: ${fileId}`
          );

          globalChannel.ack(msg);
          console.log(
            `Worker: Acknowledged message for "${
              metadata.originalFileName || "unknown"
            }"`
          );
        } catch (error) {
          console.error(
            `Worker: An error occurred during message processing for "${
              metadata.originalFileName || "unknown"
            }"`
          );
          console.error("Worker: Error details:", error);

          // Delete from Cloudinary even if failure
          if (fileId) {
            try {
              await deleteAudioFile(fileId);
              console.log(
                `Worker: Deleted failed job's audio file and metadata for ID: ${fileId}`
              );
            } catch (deleteError) {
              console.error(
                `Worker: Failed to delete audio file and metadata for failed job:`,
                deleteError
              );
            }
          }

          // Don't requeue failed messages to prevent infinite loops
          globalChannel.nack(msg, false, false);
          console.error(
            `Worker: Nacked message for "${
              metadata.originalFileName || "unknown"
            }" (requeued: false)`
          );
        }
      },
      {
        noAck: false,
      }
    );

    console.log("Worker: Persistent worker started successfully.");
  } catch (error) {
    console.error("Worker: Initialization or connection error:", error);
    if (globalConnection) {
      try {
        await globalConnection.close();
      } catch (e) {
        console.error(
          "Worker: Error closing connection during error:",
          e
        );
      }
    }
    throw error; // Re-throw to allow restart logic
  }
};

// Graceful shutdown handler
const shutdown = async () => {
  console.log("Worker: Shutting down gracefully...");
  try {
    if (globalChannel) {
      await globalChannel.close();
    }
    if (globalConnection) {
      await globalConnection.close();
    }
    console.log("Worker: Shutdown complete.");
  } catch (error) {
    console.error("Worker: Error during shutdown:", error);
  }
};

// Handle process termination
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = {
  startWorker,
  shutdown,
};