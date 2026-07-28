const mongoose = require('mongoose');

const enrollmentSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  batchId: {
    type: mongoose.Schema.ObjectId,
    ref: 'Batch',
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  }
}, {
  timestamps: true
});

// Prevent duplicate enrollments
enrollmentSchema.index({ studentId: 1, batchId: 1 }, { unique: true });
enrollmentSchema.index({ batchId: 1, status: 1 });

module.exports = mongoose.model('Enrollment', enrollmentSchema);
