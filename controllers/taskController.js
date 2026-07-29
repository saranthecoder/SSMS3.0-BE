const Task = require('../models/Task');
const User = require('../models/User');
const Submission = require('../models/Submission');

// @desc    Create a task
// @route   POST /api/tasks
// @access  Private/Admin
const createTask = async (req, res) => {
  try {
    const { title, description, dueDate, maxMarks, batchId, taskType, fileUrl, linkUrl, category, scheduledAt, requiredLinks } = req.body;

    const task = await Task.create({
      title,
      description,
      taskType: taskType || 'text',
      fileUrl,
      linkUrl,
      category: category || 'General',
      dueDate,
      maxMarks,
      batchId,
      createdBy: req.user._id,
      scheduledAt: scheduledAt || null,
      requiredLinks: requiredLinks || []
    });

    res.status(201).json(task);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get all tasks (optionally filter by batchId)
// @route   GET /api/tasks
// @access  Private
const getTasks = async (req, res) => {
  try {
    const { batchId } = req.query;
    let query = {};

    if (batchId && batchId !== 'all') {
      query.batchId = batchId;
    } else if (req.user.role === 'mentor') {
      const Batch = require('../models/Batch');
      const mentorBatches = await Batch.find({ 
        $or: [{ mentorId: req.user._id }, { mentors: req.user._id }] 
      }).select('_id').lean();
      const mentorBatchIds = mentorBatches.map(b => b._id);
      query.$or = [
        { batchId: { $in: mentorBatchIds } },
        { createdBy: req.user._id }
      ];
    } else if (req.user.role === 'student') {
      const Enrollment = require('../models/Enrollment');
      const enrollments = await Enrollment.find({ studentId: req.user._id, status: 'approved' }).select('batchId').lean();
      const myBatchIds = enrollments.map(e => e.batchId);
      query.batchId = { $in: myBatchIds };
    }

    const tasks = await Task.find(query).populate('batchId', 'batchName').sort({ createdAt: -1 }).lean();

    if (req.user.role === 'student') {
      const processedTasks = tasks.map(task => {
        const isLocked = task.scheduledAt && new Date(task.scheduledAt) > new Date();
        if (isLocked) {
          return {
            _id: task._id,
            title: task.title,
            dueDate: task.dueDate,
            maxMarks: task.maxMarks,
            batchId: task.batchId,
            taskType: task.taskType,
            scheduledAt: task.scheduledAt,
            isLocked: true,
            description: "Locked until scheduled release",
            category: task.category,
            fileUrl: null,
            linkUrl: null,
            requiredLinks: []
          };
        }
        return { ...task, isLocked: false };
      });
      return res.json(processedTasks);
    }

    res.json(tasks);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get task by ID
// @route   GET /api/tasks/:id
// @access  Private
const getTaskById = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id).populate('batchId', 'batchName').lean();

    if (task) {
      const isLocked = req.user.role !== 'admin' && task.scheduledAt && new Date(task.scheduledAt) > new Date();
      if (isLocked) {
        return res.json({
          _id: task._id,
          title: task.title,
          dueDate: task.dueDate,
          maxMarks: task.maxMarks,
          batchId: task.batchId,
          taskType: task.taskType,
          scheduledAt: task.scheduledAt,
          isLocked: true,
          description: "Locked until scheduled release",
          category: task.category,
          fileUrl: null,
          linkUrl: null,
          requiredLinks: []
        });
      }
      res.json(task);
    } else {
      res.status(404).json({ message: 'Task not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update a task
// @route   PUT /api/tasks/:id
// @access  Private/Admin
const updateTask = async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });

    if (task) {
      res.json(task);
    } else {
      res.status(404).json({ message: 'Task not found' });
    }
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Delete a task
// @route   DELETE /api/tasks/:id
// @access  Private/Admin
const deleteTask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);

    if (task) {
      await task.deleteOne();
      res.json({ message: 'Task removed' });
    } else {
      res.status(404).json({ message: 'Task not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get batch tracker data
// @route   GET /api/tasks/tracker/:batchId
// @access  Private/Admin
const getBatchTrackerData = async (req, res) => {
  try {
    const { batchId } = req.params;
    
    const Enrollment = require('../models/Enrollment');
    
    if (req.user.role === 'student') {
      const isEnrolled = await Enrollment.findOne({ studentId: req.user._id, batchId, status: 'approved' });
      if (!isEnrolled) {
        return res.status(403).json({ message: 'Not authorized to view tracker for this batch.' });
      }
    } else if (req.user.role === 'mentor') {
      const Batch = require('../models/Batch');
      const isMentorBatch = await Batch.findOne({ _id: batchId, mentorId: req.user._id });
      if (!isMentorBatch) {
        return res.status(403).json({ message: 'Not authorized to view tracker for this batch.' });
      }
    }
    
    const Leetcode = require('../models/Leetcode');
    
    // Concurrently load batch enrollments, tasks and leetcode problem definitions
    let taskQuery = { batchId };
    let leetcodeQuery = { batchId };
    if (req.user.role === 'student') {
      const scheduleFilter = [
        { scheduledAt: { $exists: false } },
        { scheduledAt: null },
        { scheduledAt: { $lte: new Date() } }
      ];
      taskQuery.$or = scheduleFilter;
      leetcodeQuery.$or = scheduleFilter;
    }

    const [enrollments, tasks, leetcodeProblems] = await Promise.all([
      Enrollment.find({ batchId, status: 'approved' }).populate('studentId', 'name rollNumber email').select('studentId').lean(),
      Task.find(taskQuery).sort({ dueDate: 1 }).select('title category dueDate').lean(),
      Leetcode.find(leetcodeQuery).sort({ deadline: 1 }).select('title deadline createdAt').lean()
    ]);
    
    const students = enrollments.map(e => e.studentId).filter(s => s !== null);
    const studentIds = students.map(s => s._id);
    const taskIds = tasks.map(t => t._id);
    const problemIds = leetcodeProblems.map(p => p._id);
    
    const LeetcodeSubmission = require('../models/LeetcodeSubmission');
    
    // Concurrently load submissions and LeetCode submissions with projection
    const [submissions, leetcodeSubmissions] = await Promise.all([
      Submission.find({
        taskId: { $in: taskIds },
        studentId: { $in: studentIds }
      }).select('taskId studentId status').lean(),
      LeetcodeSubmission.find({
        problemId: { $in: problemIds },
        studentId: { $in: studentIds }
      }).select('problemId studentId').lean()
    ]);
    
    res.json({ students, tasks, submissions, leetcodeProblems, leetcodeSubmissions });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Toggle task submission
// @route   POST /api/tasks/tracker/toggle
// @access  Private/Admin
const toggleTaskSubmission = async (req, res) => {
  try {
    const { taskId, studentId, completed } = req.body;
    
    if (completed) {
      const existing = await Submission.findOne({ taskId, studentId });
      if (!existing) {
        await Submission.create({
          taskId,
          studentId,
          submissionType: 'text',
          textContent: 'Marked completed by Admin',
          status: 'graded'
        });
      }
    } else {
      await Submission.findOneAndDelete({ taskId, studentId });
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createTask,
  getTasks,
  getTaskById,
  updateTask,
  deleteTask,
  getBatchTrackerData,
  toggleTaskSubmission
};
