// Run: node scratch/inspect_mock_drives.js
require('dotenv').config();
const mongoose = require('mongoose');
const MockDrive = require('../models/MockDrive');
const MockDriveScore = require('../models/MockDriveScore');
const User = require('../models/User');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lms');
  console.log('Connected to DB');

  const drives = await MockDrive.find().lean();
  console.log(`Found ${drives.length} Mock Drives in total:`);
  for (const d of drives) {
    const scoresCount = await MockDriveScore.countDocuments({ mockDriveId: d._id });
    const attendedCount = await MockDriveScore.countDocuments({ mockDriveId: d._id, attended: true });
    console.log(`- Drive: "${d.title}" (ID: ${d._id}) | Total Scores Enrolled: ${scoresCount} | Attended: ${attendedCount}`);
  }

  await mongoose.disconnect();
}
run().catch(console.error);
