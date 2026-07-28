// Run: node scratch/retroactive_gamification.js
// Recalculates and updates Chethan B's coins, XP, and level based on historical logs.

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const LeetcodeSubmission = require('../models/LeetcodeSubmission');
const MockDriveScore = require('../models/MockDriveScore');
const Submission = require('../models/Submission');
const Grade = require('../models/Grade');
const Task = require('../models/Task');

const { calculateLevel, getLeagueForLevel, CODING_STREAK_MILESTONES, ATTENDANCE_MILESTONES } = require('../utils/gamification');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/lms');
  console.log('Connected to DB');

  const user = await User.findOne({ name: /Chethan/i });
  if (!user) {
    console.log('Chethan not found');
    await mongoose.disconnect();
    return;
  }

  console.log(`Initial stats for ${user.name}:`);
  console.log(`Coins: ${user.coins}`);
  console.log(`Points (XP): ${user.points}`);
  console.log(`Level: ${user.level}`);
  console.log(`Coding Streak: ${user.codingStreak}`);

  let totalCoins = 0;
  let totalXP = 0;
  const earnedBadges = [...(user.badges || [])];
  const treasureChests = [];

  // 1. Recalculate LeetCode solves
  const leetcodeCount = await LeetcodeSubmission.countDocuments({ studentId: user._id });
  const leetcodeCoins = leetcodeCount * 40;
  const leetcodeXP = leetcodeCount * 100;
  totalCoins += leetcodeCoins;
  totalXP += leetcodeXP;
  console.log(`LeetCode Submissions: ${leetcodeCount} Solved -> Earned ${leetcodeCoins} coins, ${leetcodeXP} XP`);

  // 2. Recalculate Coding Streak Milestones
  const codingStreak = user.codingStreak || 34; // default to 34 if 0
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
        treasureChests.push({ type: chestType, earnedAt: new Date(), opened: false });
      }
    }
  }
  console.log(`Coding Streak Milestones: Claimed [${claimedCodingMilestones.join(', ')}] -> Added milestone rewards`);

  // 3. Recalculate Mock Drives
  const mockScores = await MockDriveScore.find({ studentId: user._id, attended: true }).lean();
  let mockCoins = 0;
  let mockXP = 0;
  for (const score of mockScores) {
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
  console.log(`Mock Drives: ${mockScores.length} attended -> Earned ${mockCoins} coins, ${mockXP} XP`);

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
  console.log(`Task Submissions Graded: ${submissions.length} -> Earned ${taskCoins} coins, ${taskXP} XP`);

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
  console.log(`Attendance logs: ${attendanceLogs.length} days -> Earned ${attendanceCoins} coins, ${attendanceXP} XP`);
  console.log(`Attendance Milestones: Claimed [${claimedAttendanceMilestones.join(', ')}] -> Added milestone rewards`);

  // Recalculate levels and leagues
  const levelStats = calculateLevel(totalXP);
  const league = getLeagueForLevel(levelStats.level);

  // Apply to user document
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

  console.log('\n--- UPDATE COMPLETED SUCCESSFULLY ---');
  console.log(`New stats for ${user.name}:`);
  console.log(`Coins: ${user.coins} 🪙`);
  console.log(`Points (XP): ${user.points} XP`);
  console.log(`Level: ${user.level} (League: ${user.league})`);
  console.log(`Badges Count: ${user.badges.length}`);
  console.log(`Chests in Inventory: ${user.treasureChests.filter(c => !c.opened).length} unopened`);

  await mongoose.disconnect();
}

run().catch(console.error);
