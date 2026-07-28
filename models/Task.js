const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Please add a task title'],
    trim: true,
    maxlength: [100, 'Title can not be more than 100 characters']
  },
  description: {
    type: String, // Kept for backwards compatibility or big text instructions
    required: false
  },
  taskType: {
    type: String,
    enum: ['text', 'file', 'link'],
    default: 'text'
  },
  category: {
    type: String,
    enum: ['CW', 'HW', 'General', 'Project'],
    default: 'General'
  },
  fileUrl: {
    type: String
  },
  linkUrl: {
    type: String
  },
  dueDate: {
    type: Date,
    required: [true, 'Please add a due date']
  },
  maxMarks: {
    type: Number,
    required: [true, 'Please add maximum marks']
  },
  batchId: {
    type: mongoose.Schema.ObjectId,
    ref: 'Batch',
    required: true
  },
  createdBy: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  scheduledAt: {
    type: Date
  },
  requiredLinks: [{
    label: { type: String, required: true },
    isMandatory: { type: Boolean, default: true }
  }]
}, {
  timestamps: true
});

taskSchema.index({ batchId: 1 });
taskSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Task', taskSchema);
