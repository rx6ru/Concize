# Details

Date : 2026-02-21 14:19:38

Directory /home/rxbru/myspace/Projects/Concice/Concize

Total : 92 files,  16054 codes, 1179 comments, 1408 blanks, all 18641 lines

[Summary](results.md) / Details / [Diff Summary](diff.md) / [Diff Details](diff-details.md)

## Files
| filename | language | code | comment | blank | total |
| :--- | :--- | ---: | ---: | ---: | ---: |
| [README.md](/README.md) | Markdown | 89 | 0 | 32 | 121 |
| [backend/configs/appConfig.js](/backend/configs/appConfig.js) | JavaScript JSX | 69 | 16 | 18 | 103 |
| [backend/configs/auth.js](/backend/configs/auth.js) | JavaScript JSX | 6 | 2 | 3 | 11 |
| [backend/configs/chunking.js](/backend/configs/chunking.js) | JavaScript JSX | 6 | 8 | 5 | 19 |
| [backend/configs/database.js](/backend/configs/database.js) | JavaScript JSX | 9 | 2 | 3 | 14 |
| [backend/configs/inference.js](/backend/configs/inference.js) | JavaScript JSX | 54 | 20 | 11 | 85 |
| [backend/configs/queues.js](/backend/configs/queues.js) | JavaScript JSX | 6 | 2 | 3 | 11 |
| [backend/configs/server.js](/backend/configs/server.js) | JavaScript JSX | 5 | 2 | 2 | 9 |
| [backend/configs/storage.js](/backend/configs/storage.js) | JavaScript JSX | 5 | 2 | 2 | 9 |
| [backend/controllers/audioController.js](/backend/controllers/audioController.js) | JavaScript JSX | 136 | 29 | 33 | 198 |
| [backend/controllers/chatLLM.js](/backend/controllers/chatLLM.js) | JavaScript JSX | 272 | 57 | 63 | 392 |
| [backend/controllers/meetingController.js](/backend/controllers/meetingController.js) | JavaScript JSX | 60 | 15 | 16 | 91 |
| [backend/db/cloudinary-utils/audio.db.js](/backend/db/cloudinary-utils/audio.db.js) | JavaScript JSX | 79 | 8 | 12 | 99 |
| [backend/db/models/chat.model.js](/backend/db/models/chat.model.js) | JavaScript JSX | 21 | 5 | 4 | 30 |
| [backend/db/models/meeting.model.js](/backend/db/models/meeting.model.js) | JavaScript JSX | 27 | 7 | 4 | 38 |
| [backend/db/models/meetingSummary.model.js](/backend/db/models/meetingSummary.model.js) | JavaScript JSX | 39 | 0 | 3 | 42 |
| [backend/db/mongoutils/chat.db.js](/backend/db/mongoutils/chat.db.js) | JavaScript JSX | 56 | 33 | 11 | 100 |
| [backend/db/mongoutils/summary.db.js](/backend/db/mongoutils/summary.db.js) | JavaScript JSX | 84 | 29 | 12 | 125 |
| [backend/db/mongoutils/transcription.db.js](/backend/db/mongoutils/transcription.db.js) | JavaScript JSX | 92 | 32 | 12 | 136 |
| [backend/jest.config.js](/backend/jest.config.js) | JavaScript JSX | 14 | 0 | 1 | 15 |
| [backend/middlewares/requestLogger.js](/backend/middlewares/requestLogger.js) | JavaScript JSX | 23 | 11 | 9 | 43 |
| [backend/middlewares/tempAuthCheck.js](/backend/middlewares/tempAuthCheck.js) | JavaScript JSX | 36 | 4 | 10 | 50 |
| [backend/package-lock.json](/backend/package-lock.json) | JSON | 7,436 | 0 | 1 | 7,437 |
| [backend/package.json](/backend/package.json) | JSON | 44 | 0 | 0 | 44 |
| [backend/routes/v1/audioRoutes.js](/backend/routes/v1/audioRoutes.js) | JavaScript JSX | 10 | 8 | 3 | 21 |
| [backend/routes/v1/chatRoutes.js](/backend/routes/v1/chatRoutes.js) | JavaScript JSX | 18 | 10 | 7 | 35 |
| [backend/routes/v1/index.js](/backend/routes/v1/index.js) | JavaScript JSX | 6 | 3 | 4 | 13 |
| [backend/routes/v1/meetingRoutes.js](/backend/routes/v1/meetingRoutes.js) | JavaScript JSX | 6 | 9 | 4 | 19 |
| [backend/routes/v1/transcRoutes.js](/backend/routes/v1/transcRoutes.js) | JavaScript JSX | 20 | 5 | 7 | 32 |
| [backend/server.js](/backend/server.js) | JavaScript JSX | 108 | 27 | 29 | 164 |
| [backend/services/chunkOrchestrator.js](/backend/services/chunkOrchestrator.js) | JavaScript JSX | 111 | 25 | 21 | 157 |
| [backend/services/cleanService.js](/backend/services/cleanService.js) | JavaScript JSX | 70 | 14 | 18 | 102 |
| [backend/services/embedding/chatEmbedding.js](/backend/services/embedding/chatEmbedding.js) | JavaScript JSX | 71 | 22 | 16 | 109 |
| [backend/services/embedding/embeddingService.js](/backend/services/embedding/embeddingService.js) | JavaScript JSX | 107 | 50 | 29 | 186 |
| [backend/services/embedding/transcriptionEmbedding.js](/backend/services/embedding/transcriptionEmbedding.js) | JavaScript JSX | 123 | 35 | 30 | 188 |
| [backend/services/meetingService.js](/backend/services/meetingService.js) | JavaScript JSX | 36 | 17 | 5 | 58 |
| [backend/services/preChunker.js](/backend/services/preChunker.js) | JavaScript JSX | 117 | 52 | 29 | 198 |
| [backend/services/retrieval/vectorSearchService.js](/backend/services/retrieval/vectorSearchService.js) | JavaScript JSX | 78 | 23 | 18 | 119 |
| [backend/services/summaryService.js](/backend/services/summaryService.js) | JavaScript JSX | 52 | 18 | 16 | 86 |
| [backend/services/transcription/groqNormalizer.js](/backend/services/transcription/groqNormalizer.js) | JavaScript JSX | 52 | 21 | 15 | 88 |
| [backend/services/transcription/sarvamBatchProvider.js](/backend/services/transcription/sarvamBatchProvider.js) | JavaScript JSX | 101 | 25 | 23 | 149 |
| [backend/services/transcription/sarvamNormalizer.js](/backend/services/transcription/sarvamNormalizer.js) | JavaScript JSX | 63 | 14 | 17 | 94 |
| [backend/services/transcription/transcriptionResult.js](/backend/services/transcription/transcriptionResult.js) | JavaScript JSX | 44 | 33 | 14 | 91 |
| [backend/services/transcriptionService.js](/backend/services/transcriptionService.js) | JavaScript JSX | 106 | 30 | 28 | 164 |
| [backend/tests/audioRoutes.test.js](/backend/tests/audioRoutes.test.js) | JavaScript JSX | 91 | 10 | 23 | 124 |
| [backend/tests/baseKeyRotation.test.js](/backend/tests/baseKeyRotation.test.js) | JavaScript JSX | 22 | 0 | 6 | 28 |
| [backend/tests/clean.test.js](/backend/tests/clean.test.js) | JavaScript JSX | 96 | 6 | 19 | 121 |
| [backend/tests/cloudAMQP.js](/backend/tests/cloudAMQP.js) | JavaScript JSX | 16 | 1 | 5 | 22 |
| [backend/tests/groqNormalizer.test.js](/backend/tests/groqNormalizer.test.js) | JavaScript JSX | 106 | 1 | 20 | 127 |
| [backend/tests/integration\_rotation.test.js](/backend/tests/integration_rotation.test.js) | JavaScript JSX | 20 | 1 | 5 | 26 |
| [backend/tests/llmSecurity.test.js](/backend/tests/llmSecurity.test.js) | JavaScript JSX | 126 | 4 | 23 | 153 |
| [backend/tests/meetingCompletion.test.js](/backend/tests/meetingCompletion.test.js) | JavaScript JSX | 82 | 5 | 30 | 117 |
| [backend/tests/meetingRoutes.test.js](/backend/tests/meetingRoutes.test.js) | JavaScript JSX | 80 | 6 | 29 | 115 |
| [backend/tests/preChunker.test.js](/backend/tests/preChunker.test.js) | JavaScript JSX | 121 | 10 | 22 | 153 |
| [backend/tests/qdrant\_connectivity.js](/backend/tests/qdrant_connectivity.js) | JavaScript JSX | 32 | 2 | 7 | 41 |
| [backend/tests/sarvamNormalizer.test.js](/backend/tests/sarvamNormalizer.test.js) | JavaScript JSX | 112 | 2 | 21 | 135 |
| [backend/tests/summary.db.test.js](/backend/tests/summary.db.test.js) | JavaScript JSX | 142 | 5 | 31 | 178 |
| [backend/tests/summaryService.test.js](/backend/tests/summaryService.test.js) | JavaScript JSX | 108 | 6 | 24 | 138 |
| [backend/tests/testAuth.js](/backend/tests/testAuth.js) | JavaScript JSX | 81 | 3 | 14 | 98 |
| [backend/tests/testConsumer.js](/backend/tests/testConsumer.js) | JavaScript JSX | 32 | 6 | 11 | 49 |
| [backend/tests/transcription.db.test.js](/backend/tests/transcription.db.test.js) | JavaScript JSX | 123 | 4 | 42 | 169 |
| [backend/tests/verify\_error\_categories.test.js](/backend/tests/verify_error_categories.test.js) | JavaScript JSX | 94 | 7 | 16 | 117 |
| [backend/tests/verify\_groq\_models.js](/backend/tests/verify_groq_models.js) | JavaScript JSX | 22 | 0 | 5 | 27 |
| [backend/utils/config.js](/backend/utils/config.js) | JavaScript JSX | 11 | 19 | 3 | 33 |
| [backend/utils/llm/baseKeyRotation.js](/backend/utils/llm/baseKeyRotation.js) | JavaScript JSX | 27 | 1 | 7 | 35 |
| [backend/utils/llm/cerebrasService.js](/backend/utils/llm/cerebrasService.js) | JavaScript JSX | 23 | 9 | 5 | 37 |
| [backend/utils/llm/geminiService.js](/backend/utils/llm/geminiService.js) | JavaScript JSX | 20 | 5 | 4 | 29 |
| [backend/utils/llm/groqService.js](/backend/utils/llm/groqService.js) | JavaScript JSX | 20 | 5 | 4 | 29 |
| [backend/utils/llm/inferenceProvider.js](/backend/utils/llm/inferenceProvider.js) | JavaScript JSX | 46 | 21 | 7 | 74 |
| [backend/utils/llm/sarvamService.js](/backend/utils/llm/sarvamService.js) | JavaScript JSX | 16 | 9 | 6 | 31 |
| [backend/utils/llmSecurity/index.js](/backend/utils/llmSecurity/index.js) | JavaScript JSX | 17 | 9 | 8 | 34 |
| [backend/utils/llmSecurity/inputGuardrails.js](/backend/utils/llmSecurity/inputGuardrails.js) | JavaScript JSX | 33 | 22 | 8 | 63 |
| [backend/utils/llmSecurity/outputGuardrails.js](/backend/utils/llmSecurity/outputGuardrails.js) | JavaScript JSX | 61 | 20 | 14 | 95 |
| [backend/utils/llmSecurity/relevanceFilter.js](/backend/utils/llmSecurity/relevanceFilter.js) | JavaScript JSX | 78 | 42 | 18 | 138 |
| [backend/utils/llmSecurity/securityMonitor.js](/backend/utils/llmSecurity/securityMonitor.js) | JavaScript JSX | 53 | 26 | 17 | 96 |
| [backend/utils/logger.js](/backend/utils/logger.js) | JavaScript JSX | 31 | 14 | 9 | 54 |
| [backend/utils/systemCheck.js](/backend/utils/systemCheck.js) | JavaScript JSX | 62 | 13 | 13 | 88 |
| [backend/workers/summaryWorker.js](/backend/workers/summaryWorker.js) | JavaScript JSX | 71 | 20 | 22 | 113 |
| [backend/workers/transcriptionWorker.js](/backend/workers/transcriptionWorker.js) | JavaScript JSX | 181 | 12 | 32 | 225 |
| [frontend/chat-popup.css](/frontend/chat-popup.css) | PostCSS | 400 | 2 | 62 | 464 |
| [frontend/chat-popup.html](/frontend/chat-popup.html) | HTML | 47 | 2 | 4 | 53 |
| [frontend/chat-popup.js](/frontend/chat-popup.js) | JavaScript JSX | 263 | 25 | 59 | 347 |
| [frontend/manifest.json](/frontend/manifest.json) | JSON | 40 | 0 | 1 | 41 |
| [frontend/marked.min.js](/frontend/marked.min.js) | JavaScript JSX | 2,210 | 9 | 3 | 2,222 |
| [frontend/offscreen.html](/frontend/offscreen.html) | HTML | 9 | 0 | 1 | 10 |
| [frontend/offscreen.js](/frontend/offscreen.js) | JavaScript JSX | 185 | 18 | 34 | 237 |
| [frontend/permission.html](/frontend/permission.html) | HTML | 48 | 0 | 1 | 49 |
| [frontend/permission.js](/frontend/permission.js) | JavaScript JSX | 16 | 0 | 3 | 19 |
| [frontend/popup.css](/frontend/popup.css) | PostCSS | 220 | 0 | 37 | 257 |
| [frontend/popup.html](/frontend/popup.html) | HTML | 75 | 14 | 11 | 100 |
| [frontend/popup.js](/frontend/popup.js) | JavaScript JSX | 256 | 52 | 51 | 359 |
| [frontend/service-worker.js](/frontend/service-worker.js) | JavaScript JSX | 62 | 6 | 8 | 76 |

[Summary](results.md) / Details / [Diff Summary](diff.md) / [Diff Details](diff-details.md)