const mongoose = require('mongoose');
const dotenv = require('dotenv');
const connectDB = require('../config/db');
const User = require('../models/User');
const LeetcodeSubmission = require('../models/LeetcodeSubmission');

dotenv.config();

const run = async () => {
  try {
    await connectDB();
    
    const students = await User.find({ role: 'student' });
    console.log(`Starting LeetCode streak synchronization for ${students.length} students...`);
    
    for (const student of students) {
      const solvedCount = await LeetcodeSubmission.countDocuments({ studentId: student._id });
      
      console.log(`Student: ${student.name} (${student.rollNumber})`);
      console.log(`  Current leetcodeStreak: ${student.leetcodeStreak}`);
      console.log(`  Actual problems solved (submissions): ${solvedCount}`);
      
      student.leetcodeStreak = solvedCount;
      student.totalLeetcodeSubmissions = solvedCount;
      student.totalProblemsSolved = solvedCount;
      await student.save();
      
      console.log(`  Synced leetcodeStreak successfully to ${solvedCount}.\n`);
    }
    
    console.log('Synchronization complete for all students!');
    process.exit(0);
  } catch (err) {
    console.error('Error during synchronization:', err);
    process.exit(1);
  }
};

run();
