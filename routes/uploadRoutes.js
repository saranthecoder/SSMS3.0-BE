const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const Upload = require('../models/Upload');

const router = express.Router();

// Multer Memory Config
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Configure Cloudinary if environment variables are provided
const isCloudinaryConfigured = () => {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME && 
    process.env.CLOUDINARY_API_KEY && 
    process.env.CLOUDINARY_API_SECRET
  );
};

if (isCloudinaryConfigured()) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

// Helper: Stream buffer to Cloudinary
const uploadToCloudinary = (fileBuffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'ssms_uploads',
        resource_type: 'auto',
        ...options
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    uploadStream.end(fileBuffer);
  });
};

// @desc    Upload file to Cloudinary (with custom domain URL mapping)
// @route   POST /api/upload
// @access  Private
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Sanitize filename to prevent security issues
    const safeFilename = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const uniqueFilename = `${Date.now()}-${Math.round(Math.random() * 1E9)}-${safeFilename}`;

    let uploadItem;

    if (isCloudinaryConfigured()) {
      // Upload to Cloudinary
      const cldResult = await uploadToCloudinary(req.file.buffer, {
        public_id: uniqueFilename.split('.')[0]
      });

      uploadItem = new Upload({
        filename: uniqueFilename,
        contentType: req.file.mimetype,
        cloudinaryUrl: cldResult.secure_url,
        cloudinaryPublicId: cldResult.public_id,
        storageType: 'cloudinary'
      });
      await uploadItem.save();
      console.log(`[Cloudinary Upload] Stored file ${uniqueFilename} on Cloudinary (${cldResult.secure_url})`);
    } else {
      // Fallback: Save to MongoDB if Cloudinary keys not configured in .env
      uploadItem = new Upload({
        filename: uniqueFilename,
        contentType: req.file.mimetype,
        data: req.file.buffer,
        storageType: 'mongodb'
      });
      await uploadItem.save();
      console.log(`[MongoDB Upload Fallback] Stored file ${uniqueFilename} in MongoDB`);
    }

    // Generate custom URL for frontend using YOUR DOMAIN (not cloudinary.com in address bar)
    const fileUrl = `/uploads/${uniqueFilename}`;
    res.status(201).json({ url: fileUrl, filename: uniqueFilename, storage: uploadItem.storageType });
  } catch (error) {
    console.error('File upload error:', error);
    res.status(500).json({ message: error.message || 'File upload failed' });
  }
});

module.exports = router;
