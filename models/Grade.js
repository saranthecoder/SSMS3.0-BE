const mongoose = require('mongoose');

const gradeSchema = new mongoose.Schema({
  submissionId: {
    type: mongoose.Schema.ObjectId,
    ref: 'Submission',
    required: true,
    unique: true
  },
  marksObtained: {
    type: Number,
    required: [true, 'Please add marks obtained']
  },
  feedback: {
    type: String,
    required: [true, 'Please add feedback']
  },
  reviewedBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  reviewedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Grade', gradeSchema);
