const mongoose = require('mongoose');

const uploadSchema = new mongoose.Schema({
  filename: {
    type: String,
    required: true,
    unique: true
  },
  contentType: {
    type: String,
    required: true
  },
  data: {
    type: Buffer,
    default: null
  },
  cloudinaryUrl: {
    type: String,
    default: ''
  },
  cloudinaryPublicId: {
    type: String,
    default: ''
  },
  storageType: {
    type: String,
    enum: ['cloudinary', 'mongodb', 'disk'],
    default: 'mongodb'
  }
}, { timestamps: true });

module.exports = mongoose.model('Upload', uploadSchema);
