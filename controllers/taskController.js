const Task = require('../models/Task');
const User = require('../models/User');
const Submission = require('../models/Submission');
const Enrollment = require('../models/Enrollment');
const socketHandlers = require('../sockets/socketHandlers');
const { invalidateStudentAnalyticsCache } = require('./analyticsController');

const parseToUTC = (dateInput) => {
  if (!dateInput) return null;
  if (dateInput instanceof Date) return dateInput;
  if (typeof dateInput === 'string') {
    // If it already has Z or timezone offset (+HH:MM / -HH:MM), parse directly
    if (dateInput.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(dateInput)) {
      return new Date(dateInput);
    }
    // If it's a naive local datetime string from Indian clients (e.g. YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss), treat as IST (+05:30)
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(dateInput)) {
      return new Date(`${dateInput}+05:30`);
    }
    // If it's just a date (YYYY-MM-DD), default to end of day in IST (23:59:59 IST = 18:29:59 UTC)
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      return new Date(`${dateInput}T23:59:59+05:30`);
    }
  }
  return new Date(dateInput);
};

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
      dueDate: parseToUTC(dueDate),
      maxMarks,
      batchId,
      createdBy: req.user._id,
      scheduledAt: parseToUTC(scheduledAt),
      requiredLinks: requiredLinks || []
    });

    // Invalidate student analytics cache immediately
    invalidateStudentAnalyticsCache();

    // Instant real-time task assignment notification to enrolled students
    try {
      const taskPayload = {
        taskId: task._id,
        title: task.title,
        dueDate: task.dueDate,
        maxMarks: task.maxMarks,
        category: task.category,
        batchId: task.batchId,
        createdBy: req.user?.name || 'Administrator',
        createdAt: task.createdAt
      };

      if (task.batchId) {
        socketHandlers.emitToBatch(task.batchId.toString(), 'new-task-assigned', taskPayload);
      } else {
        socketHandlers.emitToAll('new-task-assigned', taskPayload);
      }

      // Also directly emit to each active/approved student in the batch
      const enrollQuery = task.batchId ? { batchId: task.batchId, status: 'approved' } : { status: 'approved' };
      const enrollments = await Enrollment.find(enrollQuery).select('studentId').lean();
      enrollments.forEach(e => {
        if (e.studentId) {
          socketHandlers.emitToUser(e.studentId.toString(), 'new-task-assigned', taskPayload);
        }
      });
    } catch (notifErr) {
      console.warn('Real-time task notification error:', notifErr.message);
    }

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
      const isLocked = req.user.role === 'student' && task.scheduledAt && new Date(task.scheduledAt) > new Date();
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
    const updateData = { ...req.body };
    if (typeof updateData.description === 'string') {
      const strippedDesc = updateData.description.replace(/<[^>]*>/g, '').trim().toLowerCase();
      if (strippedDesc === 'locked until scheduled release') {
        delete updateData.description;
      }
    }
    if (updateData.dueDate !== undefined) {
      updateData.dueDate = parseToUTC(updateData.dueDate);
    }
    if (updateData.scheduledAt !== undefined) {
      updateData.scheduledAt = parseToUTC(updateData.scheduledAt);
    }

    const task = await Task.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true
    });

    if (task) {
      invalidateStudentAnalyticsCache();
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
      invalidateStudentAnalyticsCache();
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

// Helper: RFC-4180 style CSV parser handling quoted commas and newlines
const parseCSVText = (csvText) => {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field.trim());
        field = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(field.trim());
        if (row.some(c => c !== '')) rows.push(row);
        row = [];
        field = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(field.trim());
        if (row.some(c => c !== '')) rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some(c => c !== '')) rows.push(row);
  }
  return rows;
};

// @desc    Fetch and parse a public/shared Google Sheet CSV for bulk task allocation
// @route   POST /api/tasks/parse-gsheet
// @access  Private (Mentor/Admin)
const parseGoogleSheet = async (req, res) => {
  try {
    const { sheetUrl } = req.body;
    if (!sheetUrl || typeof sheetUrl !== 'string') {
      return res.status(400).json({ message: 'Google Sheet URL is required.' });
    }

    const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!match || !match[1]) {
      return res.status(400).json({ message: 'Invalid Google Sheet URL. Expected format: https://docs.google.com/spreadsheets/d/<ID>/...' });
    }

    const sheetId = match[1];
    const gidMatch = sheetUrl.match(/[?&#]gid=(\d+)/);
    const gidParam = gidMatch ? `&gid=${gidMatch[1]}` : '';
    const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gidParam}`;

    const response = await fetch(exportUrl, { redirect: 'follow' });
    if (!response.ok) {
      return res.status(400).json({
        message: 'Could not fetch Google Sheet. Make sure link sharing is set to "Anyone with the link can view".'
      });
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    if (contentType.includes('text/html') || text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
      return res.status(400).json({
        message: 'Google Sheet returned a login/HTML page. Please set sharing to "Anyone with the link can view".'
      });
    }

    const matrix = parseCSVText(text);
    if (matrix.length < 2) {
      return res.status(400).json({ message: 'The Google Sheet appears empty or has no data rows.' });
    }

    const headers = matrix[0];
    const rows = matrix.slice(1).map(cols => {
      const obj = {};
      headers.forEach((h, idx) => {
        if (h) obj[h] = cols[idx] !== undefined ? cols[idx] : '';
      });
      return obj;
    });

    res.json({ headers, rows, totalRows: rows.length });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Failed to parse Google Sheet.' });
  }
};

// @desc    Bulk create and schedule multiple tasks for a batch
// @route   POST /api/tasks/bulk
// @access  Private (Mentor/Admin)
const bulkCreateTasks = async (req, res) => {
  try {
    const { batchId, tasks: taskItems } = req.body;
    if (!batchId) {
      return res.status(400).json({ message: 'batchId is required.' });
    }
    if (!Array.isArray(taskItems) || taskItems.length === 0) {
      return res.status(400).json({ message: 'At least one task is required for bulk scheduling.' });
    }
    if (taskItems.length > 500) {
      return res.status(400).json({ message: 'Maximum 500 tasks can be scheduled in a single batch.' });
    }

    const Batch = require('../models/Batch');
    const batch = await Batch.findById(batchId).select('mentorId mentors batchName').lean();
    if (!batch) {
      return res.status(404).json({ message: 'Batch not found.' });
    }

    if (req.user.role === 'mentor') {
      const uid = req.user._id.toString();
      const isLead = batch.mentorId && batch.mentorId.toString() === uid;
      const isCo = Array.isArray(batch.mentors) && batch.mentors.some(m => m && m.toString() === uid);
      if (!isLead && !isCo) {
        return res.status(403).json({ message: 'Not authorized to allocate tasks to this batch.' });
      }
    }

    const validCategories = ['CW', 'HW', 'General', 'Project'];
    const validTypes = ['text', 'file', 'link'];

    const docs = [];
    const errors = [];

    taskItems.forEach((item, index) => {
      const title = (item.title || '').toString().trim().slice(0, 100);
      if (!title) {
        errors.push(`Row ${index + 1}: Title is required.`);
        return;
      }

      const parsedDue = parseToUTC(item.dueDate);
      if (!parsedDue || isNaN(parsedDue.getTime())) {
        errors.push(`Row ${index + 1} ("${title}"): Invalid deadline / dueDate.`);
        return;
      }

      const parsedSched = item.scheduledAt ? parseToUTC(item.scheduledAt) : null;
      if (item.scheduledAt && (!parsedSched || isNaN(parsedSched.getTime()))) {
        errors.push(`Row ${index + 1} ("${title}"): Invalid scheduledAt date.`);
        return;
      }

      const rawCat = (item.category || 'General').toString().trim();
      const matchedCat = validCategories.find(c => c.toLowerCase() === rawCat.toLowerCase()) || 'General';

      const rawType = (item.taskType || 'text').toString().trim().toLowerCase();
      const matchedType = validTypes.includes(rawType) ? rawType : (item.linkUrl ? 'link' : 'text');

      let reqLinks = [];
      if (Array.isArray(item.requiredLinks)) {
        reqLinks = item.requiredLinks
          .filter(rl => rl && (rl.label || typeof rl === 'string'))
          .map(rl => typeof rl === 'string'
            ? { label: rl.trim(), isMandatory: true }
            : { label: String(rl.label).trim(), isMandatory: rl.isMandatory !== false }
          );
      } else if (typeof item.requiredLinks === 'string' && item.requiredLinks.trim()) {
        reqLinks = item.requiredLinks
          .split(/[,;|]/)
          .map(s => s.trim())
          .filter(Boolean)
          .map(label => ({ label, isMandatory: true }));
      }

      docs.push({
        title,
        description: (item.description || '').toString().trim(),
        taskType: matchedType,
        category: matchedCat,
        fileUrl: item.fileUrl || '',
        linkUrl: item.linkUrl || '',
        dueDate: parsedDue,
        maxMarks: Number(item.maxMarks) > 0 ? Number(item.maxMarks) : 100,
        batchId,
        createdBy: req.user._id,
        scheduledAt: parsedSched,
        requiredLinks: reqLinks
      });
    });

    if (errors.length > 0 && docs.length === 0) {
      return res.status(400).json({ message: errors[0], errors });
    }

    const createdTasks = await Task.insertMany(docs);
    invalidateStudentAnalyticsCache();

    // Notify students immediately ONLY for tasks that are already unlocked (not future-scheduled)
    const now = new Date();
    const immediateTasks = createdTasks.filter(t => !t.scheduledAt || new Date(t.scheduledAt) <= now);
    if (immediateTasks.length > 0) {
      try {
        const enrollments = await Enrollment.find({ batchId, status: 'approved' }).select('studentId').lean();
        const firstTask = immediateTasks[0];
        const taskPayload = {
          taskId: firstTask._id,
          title: immediateTasks.length > 1 ? `${immediateTasks.length} New Tasks Assigned` : firstTask.title,
          dueDate: firstTask.dueDate,
          maxMarks: firstTask.maxMarks,
          category: firstTask.category,
          batchId,
          createdBy: req.user?.name || 'Mentor',
          createdAt: firstTask.createdAt
        };
        socketHandlers.emitToBatch(batchId.toString(), 'new-task-assigned', taskPayload);
        enrollments.forEach(e => {
          if (e.studentId) socketHandlers.emitToUser(e.studentId.toString(), 'new-task-assigned', taskPayload);
        });
      } catch (sockErr) {}
    }

    res.status(201).json({
      success: true,
      createdCount: createdTasks.length,
      skippedCount: errors.length,
      errors,
      tasks: createdTasks
    });
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
  toggleTaskSubmission,
  parseGoogleSheet,
  bulkCreateTasks
};
