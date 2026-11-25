const mongoose = require('mongoose');

const reportConfigSchema = new mongoose.Schema({
  scope: {
    type: String,
    enum: ['global', 'batch'],
    default: 'global'
  },
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    default: null
  },
  weights: {
    attendance: { type: Number, default: 20, min: 0, max: 100 },
    taskCompletion: { type: Number, default: 25, min: 0, max: 100 },
    grades: { type: Number, default: 25, min: 0, max: 100 },
    leetcode: { type: Number, default: 15, min: 0, max: 100 },
    workingConsistency: { type: Number, default: 15, min: 0, max: 100 }
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

reportConfigSchema.index({ scope: 1, batchId: 1 }, { unique: true });

module.exports = mongoose.model('ReportConfig', reportConfigSchema);
