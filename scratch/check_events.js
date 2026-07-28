const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const connString = process.env.MONGODB_URI || 'mongodb://localhost:27017/lms';

mongoose.connect(connString)
  .then(async () => {
    console.log('Connected to MongoDB.');
    const User = require('../models/User');
    
    // Find Chethan B's User document
    const chethan = await User.findOne({ name: /Chethan B/i }).lean();
    if (!chethan) {
      console.log('Chethan B not found.');
      mongoose.connection.close();
      return;
    }
    console.log(`Found Chethan B: ID=${chethan._id}, Email=${chethan.email}`);

    // Check MockDriveScore records for Chethan B
    const MockDriveScore = require('../models/MockDriveScore');
    const mockScores = await MockDriveScore.find({ studentId: chethan._id }).lean();
    console.log(`MockDriveScores for Chethan B (${mockScores.length}):`);
    console.log(JSON.stringify(mockScores, null, 2));

    // Check Grade records for Chethan B
    const Grade = require('../models/Grade');
    const Submission = require('../models/Submission');
    const submissions = await Submission.find({ studentId: chethan._id }).lean();
    const submissionIds = submissions.map(s => s._id);
    const grades = await Grade.find({ submissionId: { $in: submissionIds } }).lean();
    console.log(`Grades for Chethan B (${grades.length}):`);
    console.log(JSON.stringify(grades, null, 2));

    // Check Gamification Events for Chethan B
    const GamificationEvent = require('../models/GamificationEvent');
    const events = await GamificationEvent.find({ userId: chethan._id }).sort({ createdAt: -1 }).limit(10).lean();
    console.log(`Gamification Events for Chethan B (${events.length}):`);
    events.forEach(e => {
      console.log(`Reason: ${e.reason}, Coins: ${e.coinsChange}, XP: ${e.xpChange}, Date: ${e.createdAt}`);
    });

    mongoose.connection.close();
  })
  .catch(err => {
    console.error('Connection error:', err);
  });
