const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const connString = process.env.MONGODB_URI || 'mongodb://localhost:27017/lms';

mongoose.connect(connString)
  .then(async () => {
    console.log('Connected to MongoDB. Running optimized in-memory gamification event sync...');

    const User = require('../models/User');
    const Grade = require('../models/Grade');
    const Submission = require('../models/Submission');
    const Task = require('../models/Task');
    const MockDriveScore = require('../models/MockDriveScore');
    const GamificationEvent = require('../models/GamificationEvent');

    // 1. Preload all existing events to build a deduplication set
    console.log('Loading existing gamification events...');
    const existingEvents = await GamificationEvent.find({}, 'userId eventType reason').lean();
    const existingSet = new Set(
      existingEvents.map(e => `${e.userId.toString()}_${e.eventType}_${(e.reason || '').toLowerCase().trim()}`)
    );
    console.log(`Loaded ${existingEvents.length} existing events.`);

    // 2. Preload submissions, tasks, and users in bulk
    console.log('Preloading users, submissions, and tasks in-memory...');
    const users = await User.find({}, 'name').lean();
    const submissions = await Submission.find({}).lean();
    const tasks = await Task.find({}).lean();
    const grades = await Grade.find({}).lean();
    const mockScores = await MockDriveScore.find({ attended: true }).lean();

    const userMap = new Map(users.map(u => [u._id.toString(), u]));
    const submissionMap = new Map(submissions.map(s => [s._id.toString(), s]));
    const taskMap = new Map(tasks.map(t => [t._id.toString(), t]));

    console.log(`Preload complete: ${users.length} users, ${submissions.length} submissions, ${tasks.length} tasks, ${grades.length} grades.`);

    const eventsToCreate = [];

    // 3. Process Grade records in memory
    for (const grade of grades) {
      const submission = submissionMap.get(grade.submissionId?.toString());
      if (!submission) continue;

      const task = taskMap.get(submission.taskId?.toString());
      const studentId = submission.studentId?.toString();
      if (!studentId) continue;

      const taskTitle = task?.title || 'Task';
      const reason = `Grade: ${((grade.marksObtained / (task?.maxMarks || 100)) * 100).toFixed(0)}% for "${taskTitle}"`;
      
      const sig = `${studentId}_coins_earned_${reason.toLowerCase().trim()}`;
      if (!existingSet.has(sig)) {
        const maxMarks = task?.maxMarks || 100;
        const percentage = maxMarks > 0 ? (grade.marksObtained / maxMarks) * 100 : 0;
        const isProject = task?.category === 'Project';
        let baseXP = 150;
        let baseCoins = 60;

        if (isProject) {
          const titleLower = taskTitle.toLowerCase();
          if (titleLower.includes('final') || titleLower.includes('capstone')) {
            baseXP = 5000;
            baseCoins = 2500;
          } else if (titleLower.includes('large') || maxMarks >= 100) {
            baseXP = 1500;
            baseCoins = 700;
          } else {
            baseXP = 500;
            baseCoins = 250;
          }
        }

        let multiplier = 0.10;
        if (percentage >= 90) {
          multiplier = 1.0;
        } else if (percentage >= 70) {
          multiplier = 0.70;
          } else if (percentage >= 50) {
            multiplier = 0.50;
          }

        const coinsReward = Math.round(baseCoins * multiplier);
        const pointsReward = Math.round(baseXP * multiplier);

        eventsToCreate.push({
          userId: studentId,
          eventType: 'coins_earned',
          coinsChange: coinsReward,
          xpChange: pointsReward,
          reason: reason,
          createdAt: grade.createdAt || new Date(),
          updatedAt: grade.updatedAt || new Date()
        });

        // Add to existingSet in case of multiple same events
        existingSet.add(sig);
      }
    }

    // 4. Process MockDriveScore records in memory
    for (const score of mockScores) {
      const studentId = score.studentId?.toString();
      if (!studentId) continue;

      const totalMarks = Number(score.totalMarks);
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

      const reason = `Mock drive grade: ${letterGrade}`;
      const sig = `${studentId}_coins_earned_${reason.toLowerCase().trim()}`;
      if (!existingSet.has(sig)) {
        let coinsReward = 100;
        let pointsReward = 300;

        if (letterGrade === 'S+') {
          coinsReward = 1200;
          pointsReward = 2500;
        } else if (letterGrade === 'S') {
          coinsReward = 1000;
          pointsReward = 2200;
        } else if (letterGrade === 'A+') {
          coinsReward = 850;
          pointsReward = 1900;
        } else if (letterGrade === 'A') {
          coinsReward = 700;
          pointsReward = 1700;
        } else if (letterGrade === 'B') {
          coinsReward = 500;
          pointsReward = 1300;
        } else if (letterGrade === 'C') {
          coinsReward = 350;
          pointsReward = 900;
        } else if (letterGrade === 'D') {
          coinsReward = 200;
          pointsReward = 600;
        }

        eventsToCreate.push({
          userId: studentId,
          eventType: 'coins_earned',
          coinsChange: coinsReward,
          xpChange: pointsReward,
          reason: reason,
          createdAt: score.createdAt || new Date(),
          updatedAt: score.updatedAt || new Date()
        });

        existingSet.add(sig);
      }
    }

    // 5. Bulk insert events
    console.log(`Preparing to insert ${eventsToCreate.length} new gamification events...`);
    if (eventsToCreate.length > 0) {
      await GamificationEvent.insertMany(eventsToCreate);
      console.log('Bulk insert finished!');
    } else {
      console.log('No new events to sync.');
    }

    mongoose.connection.close();
  })
  .catch(err => {
    console.error('Connection error:', err);
  });
