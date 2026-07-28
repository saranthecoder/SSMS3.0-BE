const Submission = require('../models/Submission');
const Task = require('../models/Task');

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

    if (submissionExists) {
      if (submissionExists.status === 'resubmit') {
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
        submissionExists.submittedAt = Date.now();
        
        await submissionExists.save();
        return res.status(200).json(submissionExists);
      } else {
        return res.status(400).json({ message: 'Task already submitted. Cannot resubmit.' });
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
      submittedLinks: submittedLinks || []
    });

    res.status(201).json(submission);
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
    } else if (batchId) {
      const Task = require('../models/Task');
      const tasksInBatch = await Task.find({ batchId }).select('_id').lean();
      const taskIds = tasksInBatch.map(t => t._id);
      if (!query.taskId) {
        query.taskId = { $in: taskIds };
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
      .populate('taskId', 'title maxMarks')
      .populate('studentId', 'name email');

    if (submission) {
      // Check if student is trying to view someone else's submission
      if (req.user.role === 'student' && submission.studentId._id.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Not authorized to view this submission' });
      }
      res.json(submission);
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
