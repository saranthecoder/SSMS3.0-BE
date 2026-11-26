const Submission = require('../models/Submission');
const Grade = require('../models/Grade');
const Task = require('../models/Task');
const User = require('../models/User');
const GamificationEvent = require('../models/GamificationEvent');
const { awardCoinsWithCap, awardXPWithCap, checkAndAwardBadges } = require('../utils/gamification');
const socketHandlers = require('../sockets/socketHandlers');
const { invalidateStudentAnalyticsCache } = require('./analyticsController');

// @desc    Submit a task
// @route   POST /api/submissions
// @access  Private (Student)
const submitTask = async (req, res) => {
  try {
    const { taskId, githubLink, liveLink, remarks, submissionType, textContent, fileUrl, linkUrl, submittedLinks } = req.body;

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const submissionExists = await Submission.findOne({
      taskId,
      studentId: req.user._id
    });

    const submitTime = new Date();
    let isLate = false;
    let delayHours = 0;
    let latePenalty = 0;

    if (task.dueDate) {
      const dueMs = new Date(task.dueDate).getTime();
      const currentMs = submitTime.getTime();
      if (currentMs > dueMs) {
        isLate = true;
        const diffMs = currentMs - dueMs;
        delayHours = Math.ceil(diffMs / (1000 * 60 * 60));
        latePenalty = delayHours * 1; // 1 mark per hour delay
      }
    }

    // Calculate 10x coins & 15x XP per effective mark after deducting late penalty (1 mark per hour delay)
    const taskMarks = (task.maxMarks !== undefined && Number(task.maxMarks) > 0) ? Number(task.maxMarks) : 10;
    const effectiveMarks = Math.max(0, taskMarks - latePenalty);
    const coinsToAward = Math.round(effectiveMarks * 10);
    const xpToAward = Math.round(effectiveMarks * 15);
    const coinReason = latePenalty > 0
      ? `Task Submission: "${task.title}" (${effectiveMarks}/${taskMarks} marks after -${latePenalty} late penalty)`
      : `Task Submission: "${task.title}" (${taskMarks} marks)`;

    if (submissionExists) {
      if (submissionExists.status === 'resubmit') {
        let coinsGivenOnResubmit = 0;
        let xpGivenOnResubmit = 0;
        // If not previously awarded rewards for this task, award now
        if (!submissionExists.coinsAwarded && !submissionExists.xpAwarded && (coinsToAward > 0 || xpToAward > 0)) {
          const studentUser = await User.findById(req.user._id);
          if (studentUser) {
            if (coinsToAward > 0) {
              coinsGivenOnResubmit = awardCoinsWithCap(studentUser, coinsToAward, coinReason, true);
            }
            if (xpToAward > 0) {
              const xpRes = awardXPWithCap(studentUser, xpToAward, coinReason, true);
              xpGivenOnResubmit = xpRes.actual || 0;
            }
            checkAndAwardBadges(studentUser);
            await studentUser.save();

            await GamificationEvent.create({
              userId: studentUser._id,
              eventType: 'coins_earned',
              coinsChange: coinsGivenOnResubmit,
              xpChange: xpGivenOnResubmit,
              reason: coinReason,
              metadata: { taskId: task._id, taskTitle: task.title, maxMarks: taskMarks, effectiveMarks, latePenalty, coinsAwarded: coinsGivenOnResubmit, xpAwarded: xpGivenOnResubmit }
            });

            try {
              socketHandlers.emitToUser(studentUser._id.toString(), 'coins-received', {
                sender: { name: 'SSMS Tasks' },
                amount: coinsGivenOnResubmit,
                xpAmount: xpGivenOnResubmit,
                newCoins: studentUser.coins,
                reason: latePenalty > 0
                  ? `Earned +${coinsGivenOnResubmit} coins & +${xpGivenOnResubmit} XP for submitting "${task.title}" late (-${latePenalty} mark penalty).`
                  : `Earned +${coinsGivenOnResubmit} coins & +${xpGivenOnResubmit} XP for submitting "${task.title}"!`
              });
            } catch (sockErr) {
              console.warn('Real-time coins-received socket warning:', sockErr.message);
            }
          }
          submissionExists.coinsAwarded = coinsGivenOnResubmit;
          submissionExists.xpAwarded = xpGivenOnResubmit;
        }

        // Update existing submission
        submissionExists.submissionType = submissionType;
        submissionExists.textContent = textContent;
        if (fileUrl) submissionExists.fileUrl = fileUrl;
        submissionExists.linkUrl = linkUrl;
        submissionExists.githubLink = githubLink;
        submissionExists.liveLink = liveLink;
        submissionExists.remarks = remarks;
        submissionExists.submittedLinks = submittedLinks || [];
        submissionExists.status = 'submitted'; // Reset status back to submitted
        submissionExists.submittedAt = submitTime;
        submissionExists.isLate = isLate;
        submissionExists.delayHours = delayHours;
        submissionExists.latePenalty = latePenalty;
        
        await submissionExists.save();
        invalidateStudentAnalyticsCache(req.user._id);
        return res.status(200).json({
          ...submissionExists.toObject(),
          coinsAwarded: coinsGivenOnResubmit || submissionExists.coinsAwarded || 0,
          xpAwarded: xpGivenOnResubmit || submissionExists.xpAwarded || 0,
          effectiveMarks,
          latePenalty,
          taskMarks
        });
      } else {
        return res.status(400).json({ message: 'Task already submitted. Cannot resubmit.' });
      }
    }

    // Award 10x coins & 15x XP per effective mark into student's gamification balance
    let actualCoinsAwarded = 0;
    let actualXpAwarded = 0;
    if (coinsToAward > 0 || xpToAward > 0) {
      const studentUser = await User.findById(req.user._id);
      if (studentUser) {
        if (coinsToAward > 0) {
          actualCoinsAwarded = awardCoinsWithCap(studentUser, coinsToAward, coinReason, true);
        }
        if (xpToAward > 0) {
          const xpRes = awardXPWithCap(studentUser, xpToAward, coinReason, true);
          actualXpAwarded = xpRes.actual || 0;
        }
        checkAndAwardBadges(studentUser);
        await studentUser.save();

        await GamificationEvent.create({
          userId: studentUser._id,
          eventType: 'coins_earned',
          coinsChange: actualCoinsAwarded,
          xpChange: actualXpAwarded,
          reason: coinReason,
          metadata: {
            taskId: task._id,
            taskTitle: task.title,
            maxMarks: taskMarks,
            effectiveMarks,
            latePenalty,
            coinsAwarded: actualCoinsAwarded,
            xpAwarded: actualXpAwarded
          }
        });

        // Real-time socket notification to the student
        try {
          socketHandlers.emitToUser(studentUser._id.toString(), 'coins-received', {
            sender: { name: 'SSMS Tasks' },
            amount: actualCoinsAwarded,
            xpAmount: actualXpAwarded,
            newCoins: studentUser.coins,
            reason: latePenalty > 0
              ? `Earned +${actualCoinsAwarded} coins & +${actualXpAwarded} XP for submitting "${task.title}" late (-${latePenalty} mark penalty).`
              : `Earned +${actualCoinsAwarded} coins & +${actualXpAwarded} XP for submitting "${task.title}"!`
          });
        } catch (sockErr) {
          console.warn('Real-time coins-received socket warning:', sockErr.message);
        }
      }
    }

    const submission = await Submission.create({
      taskId,
      studentId: req.user._id,
      submissionType,
      textContent,
      fileUrl,
      linkUrl,
      githubLink,
      liveLink,
      remarks,
      submittedAt: submitTime,
      isLate,
      delayHours,
      latePenalty,
      submittedLinks: submittedLinks || [],
      coinsAwarded: actualCoinsAwarded,
      xpAwarded: actualXpAwarded
    });

    invalidateStudentAnalyticsCache(req.user._id);

    res.status(201).json({
      ...submission.toObject(),
      coinsAwarded: actualCoinsAwarded,
      xpAwarded: actualXpAwarded,
      effectiveMarks,
      latePenalty,
      taskMarks
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get all submissions (optionally filter by taskId or studentId)
// @route   GET /api/submissions
// @access  Private
const getSubmissions = async (req, res) => {
  try {
    const { taskId, studentId, batchId } = req.query;
    let query = {};

    if (taskId) query.taskId = taskId;
    if (studentId) query.studentId = studentId;
    
    // If user is a student, they can only see their own submissions
    if (req.user.role === 'student') {
      query.studentId = req.user._id;
    } else if (req.user.role === 'mentor') {
      const Batch = require('../models/Batch');
      const Task = require('../models/Task');
      const mentorBatches = await Batch.find({ mentorId: req.user._id }).select('_id').lean();
      const mentorBatchIds = mentorBatches.map(b => b._id);

      let taskQuery = { batchId: { $in: mentorBatchIds } };
      if (batchId) {
        taskQuery.batchId = batchId;
      }
      const tasksInBatch = await Task.find(taskQuery).select('_id').lean();
      const taskIds = tasksInBatch.map(t => t._id);
      
      if (query.taskId) {
        // keep taskId
      } else {
        query.taskId = { $in: taskIds };
      }
    } else if (batchId && batchId !== 'all') {
      const Task = require('../models/Task');
      const Enrollment = require('../models/Enrollment');
      
      const [tasksInBatch, batchEnrollments] = await Promise.all([
        Task.find({ batchId }).select('_id').lean(),
        Enrollment.find({ batchId, status: { $regex: /^approved$/i } }).select('studentId').lean()
      ]);
      
      const taskIds = tasksInBatch.map(t => t._id);
      const studentIds = batchEnrollments.map(e => e.studentId);
      
      if (!query.taskId) {
        query.taskId = { $in: taskIds };
      }
      if (!query.studentId) {
        query.studentId = { $in: studentIds };
      }
    }

    const submissions = await Submission.find(query)
      .select('-textContent')
      .populate('taskId', 'title maxMarks dueDate')
      .populate('studentId', 'name email profileImage');

    res.json(submissions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get submission by ID
// @route   GET /api/submissions/:id
// @access  Private
const getSubmissionById = async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id)
      .populate('taskId', 'title maxMarks dueDate category')
      .populate('studentId', 'name email');

    if (submission) {
      // Check if student is trying to view someone else's submission
      if (req.user.role === 'student' && submission.studentId._id.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Not authorized to view this submission' });
      }
      const grade = await Grade.findOne({ submissionId: submission._id })
        .populate('reviewedBy', 'name')
        .lean();
      res.json({
        ...submission.toObject(),
        grade: grade || null
      });
    } else {
      res.status(404).json({ message: 'Submission not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Request resubmission (change status to resubmit)
// @route   PUT /api/submissions/:id/resubmit
// @access  Private/Admin
const requestResubmit = async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);

    if (submission) {
      submission.status = 'resubmit';
      await submission.save();

      // Delete existing grade if any when requesting resubmission
      const Grade = require('../models/Grade');
      await Grade.deleteOne({ submissionId: submission._id });

      res.json(submission);
    } else {
      res.status(404).json({ message: 'Submission not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  submitTask,
  getSubmissions,
  getSubmissionById,
  requestResubmit
};
