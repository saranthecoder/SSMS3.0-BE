const Leetcode = require('../models/Leetcode');
const LeetcodeSubmission = require('../models/LeetcodeSubmission');
const User = require('../models/User');

const normalizeUrl = (url) => {
  if (!url) return '';
  let cleaned = url.trim().toLowerCase();
  cleaned = cleaned.replace(/^(https?:\/\/)?(www\.)?/, '');
  if (cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
};

// @desc    Allocate a leetcode problem to a batch
// @route   POST /api/leetcode
// @access  Private/Admin
const allocateProblem = async (req, res) => {
  try {
    const { title, problemLink, batchId, scheduledAt } = req.body;
    
    // Check for duplicate links or titles in the same batch
    const existingProblems = await Leetcode.find({ batchId });
    if (problemLink) {
      const normalizedNewLink = normalizeUrl(problemLink);
      const hasDuplicateLink = existingProblems.some(p => normalizeUrl(p.problemLink) === normalizedNewLink);
      if (hasDuplicateLink) {
        return res.status(400).json({ message: 'This LeetCode problem link has already been assigned to this batch.' });
      }
    }
    if (title) {
      const hasDuplicateTitle = existingProblems.some(p => p.title.trim().toLowerCase() === title.trim().toLowerCase());
      if (hasDuplicateTitle) {
        return res.status(400).json({ message: 'A LeetCode problem with this title has already been assigned to this batch.' });
      }
    }

    // Set deadline to exactly 24 hours from scheduled release time (or from now)
    const baseTime = scheduledAt ? new Date(scheduledAt) : new Date();
    const deadline = new Date(baseTime.getTime() + 24 * 60 * 60 * 1000);

    const problem = await Leetcode.create({
      title,
      problemLink,
      batchId,
      deadline,
      scheduledAt: scheduledAt || null
    });

    res.status(201).json(problem);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get active problems for student's batches
// @route   GET /api/leetcode/active
// @access  Private (Student)
const getActiveProblems = async (req, res) => {
  try {
    const Enrollment = require('../models/Enrollment');
    const enrollments = await Enrollment.find({ studentId: req.user._id, status: 'approved' }).lean();
    const batchIds = enrollments.map(e => e.batchId);

    // Find active problems for the student's batches (including scheduled ones)
    const activeProblems = await Leetcode.find({
      batchId: { $in: batchIds },
      deadline: { $gt: new Date() }
    }).sort({ createdAt: -1 }).lean();

    // Also get user's submissions for these problems to know if they already submitted
    const problemIds = activeProblems.map(p => p._id);
    const submissions = await LeetcodeSubmission.find({
      studentId: req.user._id,
      problemId: { $in: problemIds }
    }).lean();

    const submittedProblemIds = submissions.map(s => s.problemId.toString());

    // Map to include status and lock/obfuscation metadata
    const result = activeProblems.map(p => {
      const isLocked = p.scheduledAt && new Date(p.scheduledAt) > new Date();
      return {
        ...p,
        isSubmitted: submittedProblemIds.includes(p._id.toString()),
        isLocked,
        problemLink: isLocked ? '#' : p.problemLink
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Submit a leetcode solution
// @route   POST /api/leetcode/:id/submit
// @access  Private (Student)
const submitSolution = async (req, res) => {
  try {
    const problemId = req.params.id;
    const { solutionLink } = req.body;

    const problem = await Leetcode.findById(problemId);
    if (!problem) {
      return res.status(404).json({ message: 'Problem not found' });
    }

    if (new Date() > new Date(problem.deadline)) {
      return res.status(400).json({ message: 'Deadline has passed for this problem' });
    }

    // Check if already submitted
    const existingSubmission = await LeetcodeSubmission.findOne({
      problemId,
      studentId: req.user._id
    });

    if (existingSubmission) {
      existingSubmission.solutionLink = solutionLink;
      await existingSubmission.save();
      return res.json(existingSubmission);
    }

    // Create new submission
    const submission = await LeetcodeSubmission.create({
      problemId,
      studentId: req.user._id,
      solutionLink
    });

    // Increment user streak with every problem solved
    const user = await User.findById(req.user._id);
    const now = new Date();
    
    user.leetcodeStreak = (user.leetcodeStreak || 0) + 1;
    user.lastLeetcodeSubmissionDate = now;

    // Compute exact total submissions from DB to prevent out-of-sync errors
    const totalSubmissions = await LeetcodeSubmission.countDocuments({ studentId: req.user._id });
    user.totalLeetcodeSubmissions = totalSubmissions;
    user.totalProblemsSolved = totalSubmissions;

    // Coding streak tracking
    const { isSameDay, isYesterday, awardCoinsWithCap, awardXPWithCap, checkAndAwardBadges, checkAndAwardStreakMilestones } = require('../utils/gamification');
    const GamificationEvent = require('../models/GamificationEvent');

    if (!isSameDay(user.lastSolvedDate || user.lastLeetcodeSubmissionDate, now)) {
      // New day solve — update streaks
      if (isYesterday(user.lastSolvedDate || user.lastLeetcodeSubmissionDate)) {
        user.codingStreak = (user.codingStreak || 0) + 1;
      } else if (!user.lastSolvedDate && !user.lastLeetcodeSubmissionDate) {
        user.codingStreak = 1;
      } else {
        user.codingStreak = 1; // Streak broken
      }
      if (user.codingStreak > (user.maxCodingStreak || 0)) {
        user.maxCodingStreak = user.codingStreak;
      }
    }
    user.lastSolvedDate = now;
    user.lastLeetcodeSubmissionDate = now;

    // Base reward: +40 coins, +100 XP (capped)
    const coinsGiven = awardCoinsWithCap(user, 40, 'LeetCode solution');
    const xpResult = awardXPWithCap(user, 100, 'LeetCode solution');

    // Check coding streak milestones
    checkAndAwardStreakMilestones(user);

    checkAndAwardBadges(user);
    await user.save();

    // Audit log
    await GamificationEvent.create({
      userId: user._id,
      eventType: 'coding_reward',
      coinsChange: coinsGiven,
      xpChange: xpResult.actual,
      reason: `Solved LeetCode problem`,
      metadata: { problemId, codingStreak: user.codingStreak }
    });

    res.status(201).json({
      submission,
      user: {
        leetcodeStreak: user.leetcodeStreak,
        totalLeetcodeSubmissions: user.totalLeetcodeSubmissions
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all past problems for a batch
// @route   GET /api/leetcode/batch/:batchId
// @access  Private
const getBatchProblems = async (req, res) => {
  try {
    let query = { batchId: req.params.batchId };
    const problems = await Leetcode.find(query).sort({ createdAt: -1 }).lean();
    
    if (req.user.role !== 'admin') {
      const processed = problems.map(p => {
        const isLocked = p.scheduledAt && new Date(p.scheduledAt) > new Date();
        return {
          ...p,
          isLocked,
          problemLink: isLocked ? '#' : p.problemLink
        };
      });
      return res.json(processed);
    }
    
    res.json(problems);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get complete leetcode history for student
// @route   GET /api/leetcode/history
// @access  Private (Student)
const getStudentLeetcodeHistory = async (req, res) => {
  try {
    const Enrollment = require('../models/Enrollment');
    const enrollments = await Enrollment.find({ studentId: req.user._id, status: 'approved' }).lean();
    const batchIds = enrollments.map(e => e.batchId);

    // Find all problems for the student's batches (including scheduled ones)
    const problems = await Leetcode.find({
      batchId: { $in: batchIds }
    }).sort({ createdAt: -1 }).lean();

    // Find all submissions by this student
    const problemIds = problems.map(p => p._id);
    const submissions = await LeetcodeSubmission.find({
      studentId: req.user._id,
      problemId: { $in: problemIds }
    }).lean();

    const submissionsMap = {};
    submissions.forEach(s => {
      submissionsMap[s.problemId.toString()] = s.solutionLink;
    });

    const result = problems.map(p => {
      const isLocked = p.scheduledAt && new Date(p.scheduledAt) > new Date();
      return {
        ...p,
        isSubmitted: !!submissionsMap[p._id.toString()],
        solutionLink: submissionsMap[p._id.toString()] || null,
        isLocked,
        problemLink: isLocked ? '#' : p.problemLink
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update a LeetCode problem
// @route   PUT /api/leetcode/:id
// @access  Private/Admin
const updateProblem = async (req, res) => {
  try {
    const { title, problemLink, scheduledAt } = req.body;
    
    const problem = await Leetcode.findById(req.params.id);
    if (!problem) {
      return res.status(404).json({ message: 'Problem not found' });
    }

    // Check for duplicates if title or problemLink are modified
    if (problemLink !== undefined || title !== undefined) {
      const existingProblems = await Leetcode.find({ batchId: problem.batchId, _id: { $ne: problem._id } });
      
      if (problemLink !== undefined && problemLink !== '') {
        const normalizedNewLink = normalizeUrl(problemLink);
        const hasDuplicateLink = existingProblems.some(p => normalizeUrl(p.problemLink) === normalizedNewLink);
        if (hasDuplicateLink) {
          return res.status(400).json({ message: 'This LeetCode problem link has already been assigned to this batch.' });
        }
      }
      
      if (title !== undefined && title !== '') {
        const hasDuplicateTitle = existingProblems.some(p => p.title.trim().toLowerCase() === title.trim().toLowerCase());
        if (hasDuplicateTitle) {
          return res.status(400).json({ message: 'A LeetCode problem with this title has already been assigned to this batch.' });
        }
      }
    }

    if (title !== undefined) problem.title = title;
    if (problemLink !== undefined) problem.problemLink = problemLink;
    
    if (scheduledAt !== undefined) {
      problem.scheduledAt = scheduledAt || null;
      // Re-calculate deadline based on scheduled time
      const baseTime = scheduledAt ? new Date(scheduledAt) : new Date();
      problem.deadline = new Date(baseTime.getTime() + 24 * 60 * 60 * 1000);
    }

    await problem.save();
    res.json(problem);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Delete a LeetCode problem
// @route   DELETE /api/leetcode/:id
// @access  Private/Admin
const deleteProblem = async (req, res) => {
  try {
    const problem = await Leetcode.findById(req.params.id);
    if (!problem) {
      return res.status(404).json({ message: 'Problem not found' });
    }
    await problem.deleteOne();
    res.json({ message: 'Problem removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  allocateProblem,
  getActiveProblems,
  submitSolution,
  getBatchProblems,
  getStudentLeetcodeHistory,
  updateProblem,
  deleteProblem
};
