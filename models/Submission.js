const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
  taskId: {
    type: mongoose.Schema.ObjectId,
    ref: 'Task',
    required: true
  },
  studentId: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  submissionType: {
    type: String,
    enum: ['text', 'file', 'link'],
    required: [true, 'Please provide a submission type']
  },
  textContent: {
    type: String
  },
  fileUrl: {
    type: String
  },
  linkUrl: {
    type: String
  },
  githubLink: {
    type: String
  },
  liveLink: {
    type: String
  },
  remarks: {
    type: String,
    maxlength: [500, 'Remarks cannot exceed 500 characters']
  },
  status: {
    type: String,
    enum: ['submitted', 'graded', 'resubmit'],
    default: 'submitted'
  },
  submittedAt: {
    type: Date,
    default: Date.now
  },
  submittedLinks: [{
    label: { type: String, required: true },
    url: { type: String, required: false }
  }]
}, {
  timestamps: true
});

// A student should only have one submission per task
submissionSchema.index({ taskId: 1, studentId: 1 }, { unique: true });
submissionSchema.index({ studentId: 1 });
submissionSchema.index({ submittedAt: -1 });
submissionSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Submission', submissionSchema);
