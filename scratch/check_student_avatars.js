const mongoose = require('mongoose');
const dotenv = require('dotenv');
const connectDB = require('../config/db');
const User = require('../models/User');

dotenv.config();

const run = async () => {
  try {
    await connectDB();
    
    // Find Chethan B
    const chethan = await User.findOne({ name: /CHETHAN/i });
    if (chethan) {
      console.log('Chethan B details:');
      console.log('  Name:', chethan.name);
      console.log('  Role:', chethan.role);
      console.log('  equippedAvatar:', chethan.equippedAvatar);
      console.log('  unlockedAvatars:', chethan.unlockedAvatars);
    } else {
      console.log('Chethan not found.');
    }

    // Find some other students
    const students = await User.find({ role: 'student' }).limit(5);
    console.log('\nOther students equippedAvatar:');
    students.forEach(s => {
      console.log(`  - ${s.name} (${s.rollNumber}): ${s.equippedAvatar}`);
    });

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
};

run();
