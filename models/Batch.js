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
    default: '09:00'
  },
  checkOutTime: {
    type: String, // format "HH:MM" e.g., "23:59"
    default: '23:59'
  },
  autoCheckOutTime: {
    type: String, // format "HH:MM" e.g., "23:59"
    default: '23:59'
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
    default: 4
  },
  maxValidHours: {
    type: Number,
    default: 10
  },
  onsiteMinHours: {
    type: Number,
    default: 4
  },
  onsiteMaxHours: {
    type: Number,
    default: 10
  },
  wfhMinHours: {
    type: Number,
    default: 4
  },
  wfhMaxHours: {
    type: Number,
    default: 10
  },
  autoWfhEnabled: {
    type: Boolean,
    default: true
  },
  autoWfhTime: {
    type: String, // format "HH:MM" e.g., "19:00"
    default: '19:00'
  },
  autoOnsiteCheckoutEnabled: {
    type: Boolean,
    default: true
  },
  autoOnsiteCheckoutTime: {
    type: String, // format "HH:MM" e.g., "17:00"
    default: '17:00'
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Batch', batchSchema);
