const mongoose = require('mongoose');

const reportJobSchema = new mongoose.Schema({
  jobKey: {
    type: String,
    required: true
  },
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    required: true
  },
  reportType: {
    type: String,
    enum: ['weekly', 'monthly', 'cumulative'],
    required: true
  },
  periodKey: {
    type: String,
    required: true
  },
  startDate: {
    type: String,
    required: true
  },
  endDate: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending'
  },
  totalStudents: {
    type: Number,
    default: 0
  },
  processedStudents: {
    type: Number,
    default: 0
  },
  failedStudents: {
    type: Number,
    default: 0
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  instanceId: {
    type: String
  },
  error: {
    type: String,
    default: ''
  },
  startedAt: {
    type: Date
  },
  completedAt: {
    type: Date
  }
}, {
  timestamps: true
});

reportJobSchema.index({ jobKey: 1, status: 1 });
reportJobSchema.index({ batchId: 1, createdAt: -1 });

module.exports = mongoose.model('ReportJob', reportJobSchema);
