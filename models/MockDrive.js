const mongoose = require('mongoose');

const mockDriveSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Please add a mock drive title'],
    trim: true
  },
  batchId: {
    type: mongoose.Schema.ObjectId,
    ref: 'Batch',
    required: true
  },
  maxMarks: {
    type: Number,
    default: 749
  },
  date: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

mockDriveSchema.index({ batchId: 1 });

module.exports = mongoose.model('MockDrive', mockDriveSchema);
