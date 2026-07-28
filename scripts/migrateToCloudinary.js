const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const Upload = require('../models/Upload');

const migrateFilesToCloudinary = async () => {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.log('[Cloudinary Migration] Cloudinary environment credentials missing. Aborting.');
    return;
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  try {
    // 1. Find all files in MongoDB that have binary data buffer stored
    const unmigratedFiles = await Upload.find({
      data: { $ne: null }
    });

    if (unmigratedFiles.length > 0) {
      console.log(`[Cloudinary Migration] Starting migration for ${unmigratedFiles.length} file(s)...`);

      let successCount = 0;
      for (const fileDoc of unmigratedFiles) {
        if (!fileDoc.data || fileDoc.data.length === 0) continue;

        try {
          const publicId = fileDoc.filename.split('.')[0];
          
          const cldResult = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
              {
                folder: 'ssms_uploads',
                public_id: publicId,
                resource_type: 'auto'
              },
              (error, result) => {
                if (error) return reject(error);
                resolve(result);
              }
            );
            uploadStream.end(fileDoc.data);
          });

          // Update database record: set Cloudinary metadata
          await Upload.updateOne(
            { _id: fileDoc._id },
            {
              $set: {
                cloudinaryUrl: cldResult.secure_url,
                cloudinaryPublicId: cldResult.public_id,
                storageType: 'cloudinary'
              },
              $unset: { data: 1 } // Completely delete binary data from MongoDB to free up space!
            }
          );

          successCount++;
          console.log(`[Cloudinary Migration] Shifted file "${fileDoc.filename}" -> ${cldResult.secure_url}`);
        } catch (err) {
          console.error(`[Cloudinary Migration] Failed to shift file "${fileDoc.filename}":`, err.message);
        }
      }

      console.log(`[Cloudinary Migration] Complete! Shifted ${successCount}/${unmigratedFiles.length} file(s) to Cloudinary.`);
    }

    // 2. Global Cleanup: Enforce $unset on all Cloudinary-backed records to permanently free MongoDB storage space
    const unsetResult = await Upload.updateMany(
      { storageType: 'cloudinary' },
      { $unset: { data: 1 } }
    );
    console.log(`[MongoDB Storage Cleanup] Reclaimed storage space. Removed binary data buffers from ${unsetResult.modifiedCount || unsetResult.nModified || 0} database document(s).`);

  } catch (error) {
    console.error('[Cloudinary Migration] Error during migration:', error);
  }
};

module.exports = migrateFilesToCloudinary;

// Run directly if invoked from command line
if (require.main === module) {
  const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://saranthecodder:saransaran@cluster0.hz2ibvp.mongodb.net/lms';
  mongoose.connect(mongoUri)
    .then(async () => {
      console.log('Connected to MongoDB for Cloudinary Migration & Storage Cleanup.');
      await migrateFilesToCloudinary();
      process.exit(0);
    })
    .catch(err => {
      console.error('MongoDB connection error:', err);
      process.exit(1);
    });
}
