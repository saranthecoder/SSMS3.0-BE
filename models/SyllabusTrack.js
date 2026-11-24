const mongoose = require('mongoose');

const syllabusTrackSchema = new mongoose.Schema({
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    required: [true, 'Batch is required'],
    index: true
  },
  batchName: {
    type: String,
    trim: true,
    default: ''
  },
  mentorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Mentor ID is required'],
    index: true
  },
  mentorName: {
    type: String,
    trim: true,
    default: 'Mentor'
  },
  date: {
    type: Date,
    required: [true, 'Date is required'],
    default: Date.now,
    index: true
  },
  dateStr: {
    type: String,
    trim: true,
    index: true
  },
  title: {
    type: String,
    required: [true, 'Topic or chapter title is required'],
    trim: true
  },
  subtopics: {
    type: [String],
    default: []
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  resources: [
    {
      title: { type: String, trim: true },
      url: { type: String, trim: true }
    }
  ],
  assignmentsAssigned: {
    type: String,
    trim: true,
    default: ''
  },
  hoursSpent: {
    type: Number,
    min: 0,
    default: 1
  },
  completionPercentage: {
    type: Number,
    min: 0,
    max: 100,
    default: 100
  },
  status: {
    type: String,
    enum: ['completed', 'in-progress', 'revised'],
    default: 'completed'
  }
}, {
  timestamps: true
});

syllabusTrackSchema.index({ batchId: 1, date: -1 });

module.exports = mongoose.model('SyllabusTrack', syllabusTrackSchema);
