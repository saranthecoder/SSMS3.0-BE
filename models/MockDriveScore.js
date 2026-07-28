const mongoose = require('mongoose');

const mockDriveScoreSchema = new mongoose.Schema({
  mockDriveId: {
    type: mongoose.Schema.ObjectId,
    ref: 'MockDrive',
    required: true
  },
  studentId: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  aptitude: {
    type: Number,
    default: null
  },
  mcq: {
    type: Number,
    default: null
  },
  coding: {
    type: Number,
    default: 0
  },
  techHr: {
    type: Number,
    default: 0
  },
  hr: {
    type: Number,
    default: 0
  },
  roundScores: [{
    name: { type: String },
    score: { type: Number, default: 0 },
    maxMarks: { type: Number, default: 0 }
  }],
  totalMarks: {
    type: Number,
    default: 0
  },
  percentage: {
    type: Number,
    default: 0
  },
  grade: {
    type: String,
    default: 'Fail'
  },
  attended: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Prevent duplicate score entries for a student in a single mock drive
mockDriveScoreSchema.index({ mockDriveId: 1, studentId: 1 }, { unique: true });
mockDriveScoreSchema.index({ studentId: 1 });

module.exports = mongoose.model('MockDriveScore', mockDriveScoreSchema);
