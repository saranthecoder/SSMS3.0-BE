const mongoose = require('mongoose');

const leetcodeSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  problemLink: {
    type: String,
    required: true
  },
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    required: true
  },
  deadline: {
    type: Date,
    required: true
  },
  processed: {
    type: Boolean,
    default: false
  },
  scheduledAt: {
    type: Date
  }
}, {
  timestamps: true
});

leetcodeSchema.index({ batchId: 1 });

module.exports = mongoose.model('Leetcode', leetcodeSchema);
