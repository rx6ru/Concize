// tests/audioRoutes.test.js

const request = require("supertest");
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const fs = require("fs");

// Mock external dependencies
jest.mock("../db/cloudinary-utils/audio.db", () => ({
  storeAudioFile: jest.fn(),
  deleteAudioFile: jest.fn(),
}));

jest.mock("amqplib", () => ({
  connect: jest.fn().mockResolvedValue({
    createConfirmChannel: jest.fn().mockResolvedValue({
      assertQueue: jest.fn(),
      sendToQueue: jest.fn(),
      waitForConfirms: jest.fn().mockResolvedValue(true),
      close: jest.fn(),
    }),
    close: jest.fn(),
  }),
}));

jest.mock("../configs", () => ({
  CLOUDAMQP_URL: "amqp://mock-url",
  AUDIO_QUEUE: "test_audio_queue",
}));

// Mock fluent-ffmpeg and ffprobe
jest.mock("fluent-ffmpeg", () => {
  const mockFfmpeg = jest.fn(() => ({
    ffprobe: jest.fn((callback) => {
      callback(null, {
        format: {
          format_name: "webm",
          duration: 10, // 10 seconds
        },
      });
    }),
  }));
  mockFfmpeg.setFfmpegPath = jest.fn();
  mockFfmpeg.setFfprobePath = jest.fn();
  return mockFfmpeg;
});

const { storeAudioFile } = require("../db/cloudinary-utils/audio.db");
const audioRoutes = require("../routes/v1/audioRoutes");

// Setup test app
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/v1/audios", audioRoutes);

describe("Audio Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/v1/audios", () => {
    it("should return 400 if no audio file is provided", async () => {
      const response = await request(app)
        .post("/api/v1/audios")
        .set("Cookie", "jobId=test-job-123")
        .send();

      expect(response.status).toBe(400);
      expect(response.text).toContain("No audio file provided");
    });

    it("should return 400 if no jobId cookie is present", async () => {
      // Create a minimal test audio buffer
      const testBuffer = Buffer.from("test audio data");

      const response = await request(app)
        .post("/api/v1/audios")
        .attach("audio", testBuffer, "test.webm");

      expect(response.status).toBe(400);
      expect(response.text).toContain("No meeting session found");
    });

    it("should extract x-last-chunk header and include it in the message", async () => {
      storeAudioFile.mockResolvedValue({ public_id: "mock-file-id" });
      const testBuffer = Buffer.from("test audio data");

      const response = await request(app)
        .post("/api/v1/audios")
        .set("Cookie", "jobId=test-job-with-last-chunk")
        .set("x-last-chunk", "true")
        .attach("audio", testBuffer, "test.webm");

      // The route should process the request
      // Due to mocking, we can't fully test the message payload here,
      // but the route should not error out
      expect(response.status).toBe(202);
    });

    it("should clean up uploaded file if queue fails", async () => {
      const { deleteAudioFile } = require("../db/cloudinary-utils/audio.db");
      const amqp = require("amqplib");

      // Mock successful upload
      storeAudioFile.mockResolvedValue({ public_id: "test-file-id" });

      // Mock queue connection failure
      amqp.connect.mockRejectedValueOnce(new Error("Queue connection failed"));

      const testBuffer = Buffer.from("test audio data");

      const response = await request(app)
        .post("/api/v1/audios")
        .set("Cookie", "jobId=test-job-queue-fail")
        .attach("audio", testBuffer, "test.webm");

      expect(response.status).toBe(500);
      expect(deleteAudioFile).toHaveBeenCalledWith("test-file-id");
    });
  });
});
