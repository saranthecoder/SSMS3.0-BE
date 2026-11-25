const Grade = require('../models/Grade');
const Submission = require('../models/Submission');
const socketHandlers = require('../sockets/socketHandlers');
const { invalidateStudentAnalyticsCache } = require('./analyticsController');

// @desc    Add grade to a submission
// @route   POST /api/grades
// @access  Private/Admin
const addGrade = async (req, res) => {
  try {
    const { submissionId, marksObtained, feedback } = req.body;

    const [submission, gradeExists] = await Promise.all([
      Submission.findById(submissionId).populate('taskId'),
      Grade.findOne({ submissionId }).select('_id').lean()
    ]);

    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }
    if (gradeExists) {
      return res.status(400).json({ message: 'Submission already graded. Use update instead.' });
    }

    const rawMarks = Number(marksObtained);
    let latePenalty = submission.latePenalty || 0;
    let delayHours = submission.delayHours || 0;

    // Check if submission was late and calculate delay if not already stored
    if (!latePenalty && submission.taskId?.dueDate && submission.submittedAt) {
      const dueMs = new Date(submission.taskId.dueDate).getTime();
      const submitMs = new Date(submission.submittedAt).getTime();
      if (submitMs > dueMs) {
        delayHours = Math.ceil((submitMs - dueMs) / (1000 * 60 * 60));
        latePenalty = delayHours * 1;
      }
    }

    // Auto grading penalty: deduct 1 mark per hour delay
    const finalMarks = latePenalty > 0 ? Math.max(0, rawMarks - latePenalty) : rawMarks;

    let finalFeedback = feedback || '';
    if (latePenalty > 0 && !finalFeedback.includes('Late Penalty')) {
      finalFeedback += `\n[Auto-Grading Late Penalty: -${latePenalty} mark(s) for ${delayHours} hr(s) delay. Original: ${rawMarks}, Final: ${finalMarks}]`;
    }

    const User = require('../models/User');
    const [grade, studentUser] = await Promise.all([
      Grade.create({
        submissionId,
        marksObtained: finalMarks,
        rawMarks,
        latePenalty,
        delayHours,
        feedback: finalFeedback,
        reviewedBy: req.user._id
      }),
      submission.studentId ? User.findById(submission.studentId) : Promise.resolve(null)
    ]);

    submission.status = 'graded';
    const savePromises = [];

    // Gamification rewards for student (respecting 10x marks coins rule and avoiding duplicate awards)
    if (studentUser) {
      const maxMarks = submission.taskId?.maxMarks || 100;
      const percentage = maxMarks > 0 ? (marksObtained / maxMarks) * 100 : 0;
      
      const isProject = submission.taskId?.category === 'Project';
      let baseXP = 150;
      let baseCoins = maxMarks * 10;

      if (isProject) {
        const titleLower = (submission.taskId?.title || '').toLowerCase();
        if (titleLower.includes('final') || titleLower.includes('capstone')) {
          baseXP = 5000;
          baseCoins = Math.max(2500, maxMarks * 10);
        } else if (titleLower.includes('large') || maxMarks >= 100) {
          baseXP = 1500;
          baseCoins = Math.max(700, maxMarks * 10);
        } else {
          baseXP = 500;
          baseCoins = Math.max(250, maxMarks * 10);
        }
      }

      let multiplier = 0.10; // Below 50%
      if (percentage >= 90) {
        multiplier = 1.0;
      } else if (percentage >= 70) {
        multiplier = 0.70;
      } else if (percentage >= 50) {
        multiplier = 0.50;
      }

      const targetCoins = isProject
        ? Math.round(baseCoins * multiplier)
        : Math.round(marksObtained * 10);
      const alreadyAwarded = submission.coinsAwarded || 0;
      const coinsReward = Math.max(0, targetCoins - alreadyAwarded);
      const pointsReward = Math.round(baseXP * multiplier);
      
      const { awardCoinsWithCap, awardXPWithCap, checkAndAwardBadges } = require('../utils/gamification');
      const actualCoins = coinsReward > 0
        ? awardCoinsWithCap(studentUser, coinsReward, `Grade: ${percentage.toFixed(0)}%`, true)
        : 0;
      const actualXP = awardXPWithCap(studentUser, pointsReward, `Grade: ${percentage.toFixed(0)}%`, isProject);
      checkAndAwardBadges(studentUser);
      
      if (actualCoins > 0) {
        submission.coinsAwarded = alreadyAwarded + actualCoins;
      }

      savePromises.push(studentUser.save());

      if (actualCoins > 0 || (actualXP.actual || 0) > 0) {
        const GamificationEvent = require('../models/GamificationEvent');
        savePromises.push(GamificationEvent.create({
          userId: studentUser._id,
          eventType: 'coins_earned',
          coinsChange: actualCoins,
          xpChange: actualXP.actual || 0,
          reason: `Grade: ${percentage.toFixed(0)}% for "${submission.taskId?.title || 'Task'}"`
        }));
      }
    }

    savePromises.push(submission.save());
    await Promise.all(savePromises);

    // Invalidate student analytics cache immediately
    if (submission.studentId) {
      invalidateStudentAnalyticsCache(submission.studentId);
      // Real-time socket notification to the student
      try {
        socketHandlers.emitToUser(submission.studentId.toString(), 'task-graded', {
          gradeId: grade._id,
          submissionId: submission._id,
          title: submission.taskId?.title || 'Task',
          marksObtained: grade.marksObtained,
          maxMarks: submission.taskId?.maxMarks || 100,
          reviewedAt: grade.reviewedAt || new Date()
        });
      } catch (sockErr) {
        console.warn('Real-time task-graded socket warning:', sockErr.message);
      }
    }

    res.status(201).json(grade);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Update a grade
// @route   PUT /api/grades/:id
// @access  Private/Admin
const updateGrade = async (req, res) => {
  try {
    const grade = await Grade.findById(req.params.id);

    if (grade) {
      if (req.body.marksObtained !== undefined) {
        const rawMarks = Number(req.body.marksObtained);
        const latePenalty = grade.latePenalty || 0;
        grade.rawMarks = rawMarks;
        grade.marksObtained = latePenalty > 0 ? Math.max(0, rawMarks - latePenalty) : rawMarks;
      }
      grade.feedback = req.body.feedback !== undefined ? req.body.feedback : grade.feedback;
      grade.reviewedBy = req.user._id;
      grade.reviewedAt = Date.now();

      const updatedGrade = await grade.save();

      // Ensure the associated submission status is also updated to 'graded'
      const Submission = require('../models/Submission');
      const sub = await Submission.findByIdAndUpdate(grade.submissionId, { status: 'graded' }).populate('taskId');
      if (sub?.studentId) {
        invalidateStudentAnalyticsCache(sub.studentId);
        try {
          socketHandlers.emitToUser(sub.studentId.toString(), 'task-graded', {
            gradeId: updatedGrade._id,
            submissionId: sub._id,
            title: sub.taskId?.title || 'Task',
            marksObtained: updatedGrade.marksObtained,
            reviewedAt: updatedGrade.reviewedAt
          });
        } catch (sockErr) {
          console.warn('Real-time task-graded socket warning:', sockErr.message);
        }
      }

      res.json(updatedGrade);
    } else {
      res.status(404).json({ message: 'Grade not found' });
    }
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get student's grades
// @route   GET /api/grades/student/:studentId
// @access  Private
const getStudentGrades = async (req, res) => {
  try {
    const studentId = req.params.studentId;

    // Students can only access their own grades
    if (req.user.role === 'student' && req.user._id.toString() !== studentId) {
      return res.status(403).json({ message: 'Not authorized to view these grades' });
    }

    // Find all submissions for the student
    const submissions = await Submission.find({ studentId });
    const submissionIds = submissions.map(sub => sub._id);

    // Find all grades corresponding to these submissions
    const grades = await Grade.find({ submissionId: { $in: submissionIds } })
      .populate({
        path: 'submissionId',
        populate: {
          path: 'taskId',
          select: 'title maxMarks'
        }
      })
      .populate('reviewedBy', 'name');

    res.json(grades);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get grade by submission ID
// @route   GET /api/grades/submission/:submissionId
// @access  Private
const getGradeBySubmission = async (req, res) => {
  try {
    const grade = await Grade.findOne({ submissionId: req.params.submissionId });
    if (grade) {
      res.json(grade);
    } else {
      res.status(404).json({ message: 'Grade not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Auto evaluate pending submissions (supports single submissionId or sector batch submissionIds)
// @route   POST /api/grades/auto-evaluate
// @access  Private/Admin
const autoEvaluateSubmissions = async (req, res) => {
  try {
    // 1. Find pending submissions (single, sector array, or all)
    const query = { status: 'submitted' };
    if (Array.isArray(req.body.submissionIds) && req.body.submissionIds.length > 0) {
      query._id = { $in: req.body.submissionIds.slice(0, 100) };
    } else if (req.body.submissionId) {
      query._id = req.body.submissionId;
    }
    const pendingSubmissions = await Submission.find(query).populate('taskId');
    
    if (pendingSubmissions.length === 0) {
      return res.status(200).json({ message: 'No pending submissions to evaluate', count: 0, sectorSize: 0 });
    }

    // Batch-check existing grades to avoid N+1 queries
    const subIds = pendingSubmissions.map(s => s._id);
    const existingGrades = await Grade.find({ submissionId: { $in: subIds } }).select('submissionId').lean();
    const gradedIdSet = new Set(existingGrades.map(g => g.submissionId.toString()));

    // Batch-load all involved student users once
    const User = require('../models/User');
    const GamificationEvent = require('../models/GamificationEvent');
    const { awardCoinsWithCap, awardXPWithCap, checkAndAwardBadges } = require('../utils/gamification');

    const studentIds = [...new Set(pendingSubmissions.map(s => s.studentId?.toString()).filter(Boolean))];
    const studentDocs = await User.find({ _id: { $in: studentIds } });
    const studentMap = new Map(studentDocs.map(u => [u._id.toString(), u]));
    const touchedStudents = new Set();

    const gradesToCreate = [];
    const submissionOps = [];
    const gamificationEvents = [];
    let evaluatedCount = 0;

    // 2. Compute grades & rewards for this sector
    for (const submission of pendingSubmissions) {
      const task = submission.taskId;
      if (!task) continue;
      if (gradedIdSet.has(submission._id.toString())) continue;

      const submissionDate = new Date(submission.submittedAt || submission.createdAt);
      const dueDate = new Date(task.dueDate);
      if (dueDate.getHours() === 0 && dueDate.getMinutes() === 0 && dueDate.getSeconds() === 0) {
        dueDate.setHours(23, 59, 59, 999);
      }

      let marksObtained = task.maxMarks;
      let feedback = 'Full marks. Submitted on time.';

      if (submissionDate > dueDate) {
        const delayMs = submissionDate - dueDate;
        const delayHours = Math.floor(delayMs / (1000 * 60 * 60));
        if (delayHours > 0) {
          marksObtained = Math.max(0, task.maxMarks - delayHours);
          feedback = `Submitted late by ${delayHours} hour(s). Marks reduced accordingly.`;
        }
      }

      gradesToCreate.push({
        submissionId: submission._id,
        marksObtained,
        feedback,
        reviewedBy: req.user._id
      });

      let newCoinsAwarded = submission.coinsAwarded || 0;

      // 3. Award Gamification Rewards in memory (saved once per student)
      try {
        const studentUser = submission.studentId ? studentMap.get(submission.studentId.toString()) : null;
        if (studentUser) {
          const maxMarks = task.maxMarks || 100;
          const percentage = maxMarks > 0 ? (marksObtained / maxMarks) * 100 : 0;

          const isProject = task.category === 'Project';
          let baseXP = 150;
          let baseCoins = maxMarks * 10;

          if (isProject) {
            const titleLower = (task.title || '').toLowerCase();
            if (titleLower.includes('final') || titleLower.includes('capstone')) {
              baseXP = 5000;
              baseCoins = Math.max(2500, maxMarks * 10);
            } else if (titleLower.includes('large') || maxMarks >= 100) {
              baseXP = 1500;
              baseCoins = Math.max(700, maxMarks * 10);
            } else {
              baseXP = 500;
              baseCoins = Math.max(250, maxMarks * 10);
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

          const targetCoins = isProject
            ? Math.round(baseCoins * multiplier)
            : Math.round(marksObtained * 10);
          const alreadyAwarded = submission.coinsAwarded || 0;
          const coinsReward = Math.max(0, targetCoins - alreadyAwarded);
          const pointsReward = Math.round(baseXP * multiplier);

          const actualCoins = coinsReward > 0
            ? awardCoinsWithCap(studentUser, coinsReward, `Auto-Grade: ${percentage.toFixed(0)}%`, true)
            : 0;
          const actualXP = awardXPWithCap(studentUser, pointsReward, `Auto-Grade: ${percentage.toFixed(0)}%`, isProject);
          checkAndAwardBadges(studentUser);
          touchedStudents.add(studentUser._id.toString());

          if (actualCoins > 0) {
            newCoinsAwarded = alreadyAwarded + actualCoins;
          }

          if (actualCoins > 0 || (actualXP.actual || 0) > 0) {
            gamificationEvents.push({
              userId: studentUser._id,
              eventType: 'coins_earned',
              coinsChange: actualCoins,
              xpChange: actualXP.actual || 0,
              reason: `Auto-Grade: ${percentage.toFixed(0)}% for "${task.title || 'Task'}"`
            });
          }
        }
      } catch (rewErr) {
        console.error('Error awarding auto-eval coins:', rewErr);
      }

      submissionOps.push({
        updateOne: {
          filter: { _id: submission._id },
          update: { $set: { status: 'graded', coinsAwarded: newCoinsAwarded } }
        }
      });

      evaluatedCount++;
    }

    // 4. Persist sector in bulk
    if (gradesToCreate.length > 0) {
      await Grade.insertMany(gradesToCreate, { ordered: false });
    }
    if (submissionOps.length > 0) {
      await Submission.bulkWrite(submissionOps);
    }
    if (touchedStudents.size > 0) {
      await Promise.all(
        [...touchedStudents].map(id => studentMap.get(id)?.save().catch(err => console.error('Error saving student rewards:', err)))
      );
    }
    if (gamificationEvents.length > 0) {
      await GamificationEvent.insertMany(gamificationEvents, { ordered: false }).catch(() => {});
    }

    res.status(200).json({
      message: `Successfully auto-evaluated ${evaluatedCount} submissions`,
      count: evaluatedCount,
      sectorSize: pendingSubmissions.length
    });

  } catch (error) {
    console.error('Error in autoEvaluateSubmissions:', error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  addGrade,
  updateGrade,
  getStudentGrades,
  getGradeBySubmission,
  autoEvaluateSubmissions
};
