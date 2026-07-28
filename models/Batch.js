const mongoose = require('mongoose');

const batchSchema = new mongoose.Schema({
  batchName: {
    type: String,
    required: [true, 'Please add a batch name'],
    trim: true,
    maxlength: [50, 'Name can not be more than 50 characters']
  },
  panelName: {
    type: String,
    trim: true,
    default: ''
  },
  panelSubheading: {
    type: String,
    trim: true,
    default: ''
  },
  description: {
    type: String,
    required: [true, 'Please add a description'],
    maxlength: [500, 'Description can not be more than 500 characters']
  },
  startDate: {
    type: Date,
    required: [true, 'Please add a start date']
  },
  endDate: {
    type: Date,
    required: [true, 'Please add an end date']
  },
  status: {
    type: String,
    enum: ['Active', 'Completed', 'Upcoming'],
    default: 'Upcoming'
  },
  checkInTime: {
    type: String, // format "HH:MM" e.g., "09:00"
    default: ''
  },
  checkOutTime: {
    type: String, // format "HH:MM" e.g., "18:00"
    default: ''
  },
  autoCheckOutTime: {
    type: String, // format "HH:MM" e.g., "21:00"
    default: '21:00'
  },
  autoCheckOutEnabled: {
    type: Boolean,
    default: true
  },
  mentorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  requiredPresentHours: {
    type: Number,
    default: 8
  },
  maxValidHours: {
    type: Number,
    default: 10
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Batch', batchSchema);
