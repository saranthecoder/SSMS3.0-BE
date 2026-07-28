// Run: node scratch/update_attendance_individual.js
// Updates attendance for roll 24695a3306 on 28th June and 29th June 2026 as present with 9 hours.

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Attendance = require('../models/Attendance');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lms');
  console.log('Connected to DB');

  const rollNumber = '24695a3306';
  const student = await User.findOne({ 
    $or: [
      { rollNumber: rollNumber },
      { email: new RegExp(rollNumber, 'i') }
    ]
  });

  if (!student) {
    console.log(`Student with roll number ${rollNumber} not found.`);
    await mongoose.disconnect();
    return;
  }

  console.log(`Found student: ${student.name} (${student.email})`);

  const datesToUpdate = ['2026-06-28', '2026-06-29'];

  for (const dateStr of datesToUpdate) {
    // Delete any existing attendance record for this date
    await Attendance.deleteMany({ studentId: student._id, dateStr: dateStr });
    console.log(`Deleted old attendance logs for ${dateStr}`);

    // Create new attendance record representing 9 hours of work
    const checkIn = new Date(`${dateStr}T09:00:00+05:30`);
    const checkOut = new Date(`${dateStr}T18:00:00+05:30`);

    const record = await Attendance.create({
      studentId: student._id,
      dateStr: dateStr,
      checkInTime: checkIn,
      lastCheckInTime: checkIn,
      checkOutTime: checkOut,
      sessionDurationSeconds: 9 * 3600, // 9 hours
      isActive: false,
      isLeave: false,
      leaveHours: 0,
      status: 'Present'
    });

    console.log(`Successfully created attendance record for ${dateStr}:`, record);
  }

  // Retroactively recalculate the attendance streak for this student
  const allAttendance = await Attendance.find({ studentId: student._id, status: 'Present' }).sort({ dateStr: 1 }).lean();
  console.log(`Total present days for student: ${allAttendance.length}`);

  // Let's set a realistic attendance streak based on their consecutive days
  let streak = 0;
  if (allAttendance.length > 0) {
    streak = 1;
    for (let i = 1; i < allAttendance.length; i++) {
      const prevDate = new Date(allAttendance[i - 1].dateStr);
      const currDate = new Date(allAttendance[i].dateStr);
      const diffTime = Math.abs(currDate - prevDate);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        streak++;
      } else if (diffDays > 1) {
        streak = 1; // reset streak if gap exists
      }
    }
  }

  student.attendanceStreak = streak;
  student.lastAttendanceDate = new Date(`${datesToUpdate[1]}T18:00:00+05:30`);
  
  // Award milestones retroactively
  const { checkAndAwardStreakMilestones } = require('../utils/gamification');
  checkAndAwardStreakMilestones(student);

  await student.save();
  console.log(`Updated student attendanceStreak to: ${student.attendanceStreak}`);

  await mongoose.disconnect();
}

run().catch(console.error);
