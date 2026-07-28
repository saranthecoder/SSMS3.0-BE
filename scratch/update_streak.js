const mongoose = require('mongoose');
const dotenv = require('dotenv');
const connectDB = require('../config/db');
const User = require('../models/User');

dotenv.config();

const run = async () => {
  try {
    await connectDB();
    const roll = "23691a3342";
    
    // Search case-insensitively
    const user = await User.findOne({ rollNumber: { $regex: new RegExp(`^${roll}$`, 'i') } });
    if (!user) {
      console.log(`User with roll number ${roll} not found.`);
      process.exit(1);
    }
    
    console.log(`Found student: ${user.name} (${user.rollNumber})`);
    console.log(`Current LeetCode streak: ${user.leetcodeStreak}`);
    
    user.leetcodeStreak = 39;
    await user.save();
    
    console.log(`Updated LeetCode streak successfully to: ${user.leetcodeStreak}`);
    process.exit(0);
  } catch (err) {
    console.error('Error running script:', err);
    process.exit(1);
  }
};

run();
