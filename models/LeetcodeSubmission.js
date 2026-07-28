const mongoose = require('mongoose');

const leetcodeSubmissionSchema = new mongoose.Schema({
  problemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Leetcode',
    required: true
  },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  solutionLink: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

leetcodeSubmissionSchema.index({ problemId: 1, studentId: 1 }, { unique: true });

module.exports = mongoose.model('LeetcodeSubmission', leetcodeSubmissionSchema);
