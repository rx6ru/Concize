// db/cloudinary-utils/audio.db.js
const cloudinary = require("cloudinary").v2;
const axios = require('axios');
const path = require('path');

// Initialize Cloudinary once
const initialiseCloudinary = () => {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log("✅ Cloudinary initialized.");
};

// Upload audio
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
          console.error("❌ Cloudinary upload failed:", error);
          return reject(error);
        }
        console.log(`✅ Uploaded: ${result.secure_url}`);
        resolve({
          public_id: result.public_id,
          url: result.secure_url,
        });
      }
    );

    uploadStream.end(audioData);
  });
};

// Fetch audio as Buffer from Cloudinary
const fetchAudioFile = async (publicId, resourceType = "video") => {
  if (!publicId) throw new Error("A publicId is required to fetch the audio file.");
  
  // Use the exact publicId as stored - it already includes the folder prefix
  const url = cloudinary.url(publicId, { resource_type: resourceType, secure: true });
  console.log(`Fetching audio from Cloudinary URL: ${url}`);
  
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000 // 30 second timeout
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error('Error downloading audio from Cloudinary:', error);
    
    // Enhanced error logging
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response headers:', error.response.headers);
    }
    
    throw new Error(`Failed to fetch audio file: ${error.message}`);
  }
};

// Delete audio
const deleteAudioFile = async (publicId) => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: "video" });
    console.log(`Cloudinary delete response for ${publicId}:`, result);
    return result;
  } catch (error) {
    console.error("❌ Delete failed:", error);
    throw error;
  }
};

module.exports = {
  initialiseCloudinary,
  storeAudioFile,
  fetchAudioFile,
  deleteAudioFile,
};