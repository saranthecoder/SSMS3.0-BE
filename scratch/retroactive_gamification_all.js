// Run: node scratch/retroactive_gamification_all.js
// Recalculates and updates ALL students' coins, XP, levels, and badges based on historical logs from the past month.

require('dotenv').config();
const mongoose = require('mongoose');

// Fallback register models to prevent MissingSchemaError
const User = mongoose.models.User || mongoose.model('User', require('../models/User').schema);
const Attendance = mongoose.models.Attendance || mongoose.model('Attendance', require('../models/Attendance').schema);
const LeetcodeSubmission = mongoose.models.LeetcodeSubmission || mongoose.model('LeetcodeSubmission', require('../models/LeetcodeSubmission').schema);
const MockDriveScore = mongoose.models.MockDriveScore || mongoose.model('MockDriveScore', require('../models/MockDriveScore').schema);
const Submission = mongoose.models.Submission || mongoose.model('Submission', require('../models/Submission').schema);
const Grade = mongoose.models.Grade || mongoose.model('Grade', require('../models/Grade').schema);
const Task = mongoose.models.Task || mongoose.model('Task', require('../models/Task').schema);

const { calculateLevel, getLeagueForLevel, CODING_STREAK_MILESTONES, ATTENDANCE_MILESTONES } = require('../utils/gamification');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lms');
  console.log('Connected to Database');

  const students = await User.find({ role: 'student' });
  console.log(`Found ${students.length} students to update.`);

  for (const user of students) {
    console.log(`\n----------------------------------------------`);
    console.log(`Processing student: ${user.name} (${user.rollNumber || 'No Roll'})`);
    console.log(`Initial Stats -> Coins: ${user.coins || 0}, XP: ${user.points || 0}, Level: ${user.level || 1}`);

    let totalCoins = 0;
    let totalXP = 0;
    const earnedBadges = [...(user.badges || [])];
    const treasureChests = [];

    // 1. Recalculate LeetCode solves (40 coins & 100 XP per solve)
    const leetcodeCount = await LeetcodeSubmission.countDocuments({ studentId: user._id });
    const leetcodeCoins = leetcodeCount * 40;
    const leetcodeXP = leetcodeCount * 100;
    totalCoins += leetcodeCoins;
    totalXP += leetcodeXP;
    console.log(`- LeetCode Solves: ${leetcodeCount} -> Earned ${leetcodeCoins} coins, ${leetcodeXP} XP`);

    // 2. Recalculate Coding Streak Milestones
    const codingStreak = user.codingStreak || 0;
    const claimedCodingMilestones = [];
    for (const m of CODING_STREAK_MILESTONES) {
      if (codingStreak >= m.days) {
        totalCoins += m.coins;
        totalXP += m.xp;
        claimedCodingMilestones.push(m.days);
        if (m.badge && !earnedBadges.some(b => b.name === m.badge.name)) {
          earnedBadges.push({ ...m.badge, unlockedAt: new Date() });
        }
        if (m.days >= 14) {
          const chestType = m.days >= 60 ? 'Legendary' : m.days >= 30 ? 'Gold' : 'Silver';
          // Check if chest already exists in inventory to avoid duplicating
          const hasChest = (user.treasureChests || []).some(c => c.type === chestType && !c.opened);
          if (!hasChest) {
            treasureChests.push({ type: chestType, earnedAt: new Date(), opened: false });
          }
        }
      }
    }
    if (claimedCodingMilestones.length > 0) {
      console.log(`- Coding Milestones: Claimed [${claimedCodingMilestones.join(', ')}]`);
    }

    // 3. Recalculate Mock Drives
    const mockScores = await MockDriveScore.find({ studentId: user._id }).lean();
    let mockCoins = 0;
    let mockXP = 0;
    for (const score of mockScores) {
      if (!score.attended) {
        mockCoins += 100;
        mockXP += 300;
        continue;
      }

      const totalMarks = Number(score.totalMarks || 0);
      let letterGrade = (score.grade || '').toString().trim().toUpperCase();

      if (!isNaN(totalMarks) && totalMarks > 0) {
        if (totalMarks >= 950) letterGrade = 'S+';
        else if (totalMarks >= 900) letterGrade = 'S';
        else if (totalMarks >= 850) letterGrade = 'A+';
        else if (totalMarks >= 800) letterGrade = 'A';
        else if (totalMarks >= 700) letterGrade = 'B';
        else if (totalMarks >= 600) letterGrade = 'C';
        else if (totalMarks >= 500) letterGrade = 'D';
        else letterGrade = 'PARTICIPATION';
      }

      let coins = 100;
      let xp = 300;

      if (letterGrade === 'S+') {
        coins = 1200; xp = 2500;
      } else if (letterGrade === 'S') {
        coins = 1000; xp = 2200;
      } else if (letterGrade === 'A+') {
        coins = 850; xp = 1900;
      } else if (letterGrade === 'A') {
        coins = 700; xp = 1700;
      } else if (letterGrade === 'B') {
        coins = 500; xp = 1300;
      } else if (letterGrade === 'C') {
        coins = 350; xp = 900;
      } else if (letterGrade === 'D') {
        coins = 200; xp = 600;
      }

      mockCoins += coins;
      mockXP += xp;
    }
    totalCoins += mockCoins;
    totalXP += mockXP;
    if (mockScores.length > 0) {
      console.log(`- Mock Drives: ${mockScores.length} attended -> Earned ${mockCoins} coins, ${mockXP} XP`);
    }

    // 4. Recalculate Tasks / Assignment Grades
    const submissions = await Submission.find({ studentId: user._id, status: 'graded' }).populate('taskId').lean();
    let taskCoins = 0;
    let taskXP = 0;
    for (const sub of submissions) {
      const grade = await Grade.findOne({ submissionId: sub._id }).lean();
      if (!grade) continue;

      const maxMarks = sub.taskId?.maxMarks || 100;
      const percentage = maxMarks > 0 ? (grade.marksObtained / maxMarks) * 100 : 0;
      const isProject = sub.taskId?.category === 'Project';

      let baseXP = 150;
      let baseCoins = 60;

      if (isProject) {
        const titleLower = (sub.taskId?.title || '').toLowerCase();
        if (titleLower.includes('final') || titleLower.includes('capstone')) {
          baseCoins = 2500; baseXP = 5000;
        } else if (titleLower.includes('large') || maxMarks >= 100) {
          baseCoins = 700; baseXP = 1500;
        } else {
          baseCoins = 250; baseXP = 500;
        }
      }

      let multiplier = 0.10;
      if (percentage >= 90) multiplier = 1.0;
      else if (percentage >= 70) multiplier = 0.70;
      else if (percentage >= 50) multiplier = 0.50;

      taskCoins += Math.round(baseCoins * multiplier);
      taskXP += Math.round(baseXP * multiplier);
    }
    totalCoins += taskCoins;
    totalXP += taskXP;
    if (submissions.length > 0) {
      console.log(`- Task Submissions Graded: ${submissions.length} -> Earned ${taskCoins} coins, ${taskXP} XP`);
    }

    // 5. Recalculate Attendance days and streak milestones
    const attendanceLogs = await Attendance.find({ studentId: user._id }).lean();
    const attendanceCoins = attendanceLogs.length * 10;
    const attendanceXP = attendanceLogs.length * 20;
    totalCoins += attendanceCoins;
    totalXP += attendanceXP;

    const attendanceStreak = user.attendanceStreak || 0;
    const claimedAttendanceMilestones = [];
    for (const m of ATTENDANCE_MILESTONES) {
      if (attendanceStreak >= m.days) {
        totalCoins += m.coins;
        totalXP += m.xp;
        claimedAttendanceMilestones.push(m.days);
        if (m.badge && !earnedBadges.some(b => b.name === m.badge.name)) {
          earnedBadges.push({ ...m.badge, rarity: m.badge.rarity || 'Common', unlockedAt: new Date() });
        }
      }
    }
    console.log(`- Attendance: ${attendanceLogs.length} days -> Earned ${attendanceCoins} coins, ${attendanceXP} XP`);
    if (claimedAttendanceMilestones.length > 0) {
      console.log(`- Attendance Milestones: Claimed [${claimedAttendanceMilestones.join(', ')}]`);
    }

    // Recalculate levels and leagues
    const levelStats = calculateLevel(totalXP);
    const league = getLeagueForLevel(levelStats.level);

    // Apply updates to user document
    user.coins = totalCoins;
    user.points = totalXP;
    user.level = levelStats.level;
    user.league = league.name;
    user.badges = earnedBadges;
    user.claimedCodingMilestones = claimedCodingMilestones;
    user.claimedAttendanceMilestones = claimedAttendanceMilestones;

    // Add chests to inventory if not already present
    for (const chest of treasureChests) {
      user.treasureChests.push(chest);
    }

    await user.save();
    console.log(`Success -> Coins: ${user.coins} 🪙, XP: ${user.points} ⚡, Level: ${user.level} (${user.league})`);
  }

  console.log('\n==============================================');
  console.log('🎉 Retroactive calculations completed for all students successfully!');
  await mongoose.disconnect();
}

run().catch(console.error);
