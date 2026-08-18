const cloudinary = require("cloudinary").v2;
const axios = require('axios');
const path = require('path');
const config = require('../core/config');
const { createLogger } = require('../core/logger');

const logger = createLogger('cloudinaryUtils');

const initialiseCloudinary = () => {
  cloudinary.config({
    cloud_name: config.storage.CLOUDINARY_CLOUD_NAME,
    api_key: config.storage.CLOUDINARY_API_KEY,
    api_secret: config.storage.CLOUDINARY_API_SECRET,
  });
  logger.info("Cloudinary initialized");
};

const storeAudioFile = (audioData, fileName, jobId) => {
  return new Promise((resolve, reject) => {
    // Remove extension from fileName to prevent double extensions
    const fileNameWithoutExt = path.parse(fileName).name;
    const uniquePublicId = `${jobId}_${Date.now()}_${fileNameWithoutExt}`;

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: "video", // audio stored as video
        folder: "audio",
        public_id: uniquePublicId,
      },
      (error, result) => {
        if (error) {
          logger.error("Cloudinary upload failed", { error });
          return reject(error);
        }
        logger.info(`Uploaded audio file`, { url: result.secure_url, publicId: result.public_id });
        resolve({
          public_id: result.public_id,
          url: result.secure_url,
        });
      }
    );

    uploadStream.end(audioData);
  });
};

const fetchAudioFile = async (publicId, resourceType = "video") => {
  if (!publicId) throw new Error("A publicId is required to fetch the audio file.");

  // Use the exact publicId as stored - it already includes the folder prefix
  const url = cloudinary.url(publicId, { resource_type: resourceType, secure: true });
  logger.debug(`Fetching audio from Cloudinary`, { url, publicId });

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error('Error downloading audio from Cloudinary:', error);

    if (error.response) {
      logger.error('Error downloading audio', {
        status: error.response.status,
        headers: error.response.headers,
        publicId
      });
    } else {
      logger.error('Error downloading audio', { error: error.message, publicId });
    }

    throw new Error(`Failed to fetch audio file: ${error.message}`);
  }
};

const deleteAudioFile = async (publicId) => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: "video" });
    logger.info(`Cloudinary delete response`, { publicId, result });
    return result;
  } catch (error) {
    logger.error("Delete failed", { publicId, error });
    throw error;
  }
};

module.exports = {
  initialiseCloudinary,
  storeAudioFile,
  fetchAudioFile,
  deleteAudioFile,
};