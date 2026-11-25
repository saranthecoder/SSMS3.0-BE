const mongoose = require('mongoose');

const feedbackAuditSchema = new mongoose.Schema({
  editedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  editedAt: {
    type: Date,
    default: Date.now
  },
  version: {
    type: Number,
    required: true
  },
  summary: {
    type: String,
    default: 'Mentor feedback updated'
  }
}, { _id: false });

const studentReportSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
    type: String, // e.g., '2026-W47', '2026-11', 'cumulative_2026-11-25'
    required: true
  },
  startDate: {
    type: String, // YYYY-MM-DD
    required: true
  },
  endDate: {
    type: String, // YYYY-MM-DD
    required: true
  },
  joiningDate: {
    type: String // YYYY-MM-DD
  },
  status: {
    type: String,
    enum: ['draft', 'generated', 'in_review', 'released', 'revoked'],
    default: 'generated'
  },
  version: {
    type: Number,
    default: 1
  },
  dataSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  scoringWeights: {
    attendance: { type: Number, default: 20 },
    taskCompletion: { type: Number, default: 25 },
    grades: { type: Number, default: 25 },
    leetcode: { type: Number, default: 15 },
    workingConsistency: { type: Number, default: 15 }
  },
  dataCompleteness: {
    percentage: { type: Number, default: 100 },
    availableModules: [{ type: String }],
    missingModules: [{ type: String }],
    notes: [{ type: String }]
  },
  mentorFeedback: {
    overallObservation: { type: String, default: '' },
    strengths: { type: String, default: '' },
    areasForImprovement: { type: String, default: '' },
    academicFeedback: { type: String, default: '' },
    codingFeedback: { type: String, default: '' },
    attendanceFeedback: { type: String, default: '' },
    workDisciplineFeedback: { type: String, default: '' },
    nextMonthGoals: { type: String, default: '' },
    recommendedPractice: { type: String, default: '' },
    suggestedRoadmap: { type: String, default: '' },
    editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    editedAt: { type: Date }
  },
  feedbackAuditLog: [feedbackAuditSchema],
  generatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  generatedAt: {
    type: Date,
    default: Date.now
  },
  releasedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  releasedAt: {
    type: Date
  },
  viewedByStudentAt: {
    type: Date
  },
  viewCount: {
    type: Number,
    default: 0
  },
  notificationSent: {
    type: Boolean,
    default: false
  },
  revokedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  revokedAt: {
    type: Date
  },
  revokeReason: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

studentReportSchema.index({ studentId: 1, batchId: 1, reportType: 1, periodKey: 1, version: -1 });
studentReportSchema.index({ batchId: 1, reportType: 1, periodKey: 1, status: 1 });
studentReportSchema.index({ studentId: 1, status: 1, releasedAt: -1 });
studentReportSchema.index({ status: 1, generatedAt: -1 });

module.exports = mongoose.model('StudentReport', studentReportSchema);
