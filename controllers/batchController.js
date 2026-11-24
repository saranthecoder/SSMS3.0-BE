const mongoose = require('mongoose');
const Batch = require('../models/Batch');
const Enrollment = require('../models/Enrollment');
const Task = require('../models/Task');
const Submission = require('../models/Submission');
const Grade = require('../models/Grade');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { ensureBatchCommonGroup } = require('../utils/batchCommonGroup');

// Auto-close expired batches by deadline
const autoCloseExpiredBatches = async () => {
  try {
    const now = new Date();
    await Batch.updateMany(
      {
        status: { $ne: 'Completed' },
        endDate: { $lte: now }
      },
      {
        $set: { status: 'Completed' }
      }
    );
  } catch (err) {
    console.error('Error auto-closing expired batches:', err.message);
  }
};

// @desc    Create a batch
// @route   POST /api/batches
// @access  Private/Admin
const createBatch = async (req, res) => {
  try {
    const { 
      batchName, panelName, panelSubheading, description, startDate, endDate, status, mentorId, 
      requiredPresentHours, maxValidHours, onsiteMinHours, onsiteMaxHours, wfhMinHours, wfhMaxHours,
      checkInTime, checkOutTime, autoCheckOutTime, autoCheckOutEnabled 
    } = req.body;

    const assignedMentorId = mentorId || (req.user && req.user.role === 'mentor' ? req.user._id : null);
    const effOnsiteMin = onsiteMinHours !== undefined ? Number(onsiteMinHours) : (requiredPresentHours !== undefined ? Number(requiredPresentHours) : 8);
    const effOnsiteMax = onsiteMaxHours !== undefined ? Number(onsiteMaxHours) : (maxValidHours !== undefined ? Number(maxValidHours) : 10);
    const effWfhMin = wfhMinHours !== undefined ? Number(wfhMinHours) : effOnsiteMin;
    const effWfhMax = wfhMaxHours !== undefined ? Number(wfhMaxHours) : effOnsiteMax;

    const batch = await Batch.create({
      batchName,
      panelName: panelName ? panelName.trim() : '',
      panelSubheading: panelSubheading ? panelSubheading.trim() : '',
      description,
      startDate: startDate || new Date(),
      endDate: endDate || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      status: status || 'Active',
      mentorId: assignedMentorId,
      requiredPresentHours: effOnsiteMin,
      maxValidHours: effOnsiteMax,
      onsiteMinHours: effOnsiteMin,
      onsiteMaxHours: effOnsiteMax,
      wfhMinHours: effWfhMin,
      wfhMaxHours: effWfhMax,
      checkInTime: checkInTime || '09:00',
      checkOutTime: checkOutTime || '17:00',
      autoCheckOutTime: autoCheckOutTime || '21:00',
      autoCheckOutEnabled: autoCheckOutEnabled !== undefined ? Boolean(autoCheckOutEnabled) : true
    });

    const populatedBatch = await Batch.findById(batch._id).populate('mentorId', 'name email phone profileImage equippedAvatar').lean();

    // Automatically create and sync official batch classroom group
    ensureBatchCommonGroup(batch._id).catch(err => console.warn('Auto batch group create error:', err.message));

    res.status(201).json(populatedBatch);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get all batches
// @route   GET /api/batches
// @access  Private
const getBatches = async (req, res) => {
  try {
    await autoCloseExpiredBatches();

    let query = {};
    if (req.user && req.user.role === 'mentor') {
      const uId = req.user._id;
      const uIdStr = uId ? uId.toString() : '';
      const uObjId = mongoose.Types.ObjectId.isValid(uId) ? new mongoose.Types.ObjectId(uId) : null;
      
      const orConditions = [];
      if (uObjId) {
        orConditions.push({ mentorId: uObjId }, { mentors: uObjId });
      }
      if (uIdStr) {
        orConditions.push({ mentorId: uIdStr }, { mentors: uIdStr });
      }
      query.$or = orConditions.length > 0 ? orConditions : [{ mentorId: uId }];
    }

    const batches = await Batch.find(query).populate('mentorId', 'name email phone profileImage equippedAvatar').lean();
    res.json(batches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single batch
// @route   GET /api/batches/:id
// @access  Private
const getBatchById = async (req, res) => {
  try {
    await autoCloseExpiredBatches();

    const batch = await Batch.findById(req.params.id).populate('mentorId', 'name email phone profileImage equippedAvatar').lean();

    if (batch) {
      res.json(batch);
    } else {
      res.status(404).json({ message: 'Batch not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update a batch
// @route   PUT /api/batches/:id
// @access  Private/Admin
const updateBatch = async (req, res) => {
  try {
    const updateData = { ...req.body };
    
    // If updating endDate to the past, auto-mark completed; if explicitly active with future date, update
    if (updateData.endDate && new Date(updateData.endDate) <= new Date() && updateData.status !== 'Upcoming') {
      updateData.status = 'Completed';
    }

    // Sync attendance hour limits
    if (updateData.onsiteMinHours !== undefined) {
      updateData.requiredPresentHours = Number(updateData.onsiteMinHours);
    } else if (updateData.requiredPresentHours !== undefined) {
      updateData.onsiteMinHours = Number(updateData.requiredPresentHours);
    }
    if (updateData.onsiteMaxHours !== undefined) {
      updateData.maxValidHours = Number(updateData.onsiteMaxHours);
    } else if (updateData.maxValidHours !== undefined) {
      updateData.onsiteMaxHours = Number(updateData.maxValidHours);
    }

    const batch = await Batch.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true
    }).populate('mentorId', 'name email phone');

    if (batch) {
      res.json(batch);
    } else {
      res.status(404).json({ message: 'Batch not found' });
    }
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Close a batch or update close batch date
// @route   PUT /api/batches/:id/close
// @access  Private/Admin
const closeBatch = async (req, res) => {
  try {
    const { closeDate, status = 'Completed' } = req.body;
    const updateData = { status };
    if (closeDate) {
      updateData.endDate = new Date(closeDate);
    } else if (status === 'Completed') {
      updateData.endDate = new Date();
    }

    const batch = await Batch.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true, runValidators: true }
    ).populate('mentorId', 'name email phone profileImage equippedAvatar');

    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }

    res.json(batch);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Delete a batch
// @route   DELETE /api/batches/:id
// @access  Private/Admin
const deleteBatch = async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.id);

    if (batch) {
      await batch.deleteOne();
      res.json({ message: 'Batch removed' });
    } else {
      res.status(404).json({ message: 'Batch not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get batch report data
// @route   GET /api/batches/:id/report
// @access  Private/Admin
const getBatchReport = async (req, res) => {
  try {
    const batchId = req.params.id;

    const roundToTwo = (val) => typeof val === 'number' ? Math.round((val + Number.EPSILON) * 100) / 100 : val;

    // 1. Get all students enrolled in this batch
    const enrollments = await Enrollment.find({ batchId, status: 'approved' }).populate('studentId').lean();
    if (!enrollments.length) {
      return res.json([]);
    }

    const students = enrollments.map(e => e.studentId).filter(s => s !== null);
    const studentIds = students.map(s => s._id);

    // 2. Get all tasks for this batch
    const tasks = await Task.find({ batchId }).sort({ createdAt: 1 }).lean();
    const taskIds = tasks.map(t => t._id);

    // 4. Get all mock drives for this batch
    const MockDrive = require('../models/MockDrive');
    const mockDrives = await MockDrive.find({ batchId }).sort({ date: 1 }).lean();
    const mockDriveIds = mockDrives.map(md => md._id);

    // 5. Get all submissions, mock drive scores and attendance records in parallel
    const MockDriveScore = require('../models/MockDriveScore');
    const batch = await Batch.findById(batchId).lean();

    const attQuery = { studentId: { $in: studentIds } };
    if (batch && batch.startDate) {
      const batchStartStr = new Date(batch.startDate).toISOString().split('T')[0];
      attQuery.dateStr = { $gte: batchStartStr };
    }

    const [submissions, mockDriveScores, attendanceRecords] = await Promise.all([
      Submission.find({ studentId: { $in: studentIds }, taskId: { $in: taskIds } }).lean(),
      MockDriveScore.find({ studentId: { $in: studentIds }, mockDriveId: { $in: mockDriveIds } }).lean(),
      Attendance.find(attQuery).sort({ dateStr: 1 }).lean()
    ]);

    const submissionIds = submissions.map(s => s._id);
    const grades = await Grade.find({ submissionId: { $in: submissionIds } }).lean();

    // Optimize aggregation using Hash Maps for O(1) lookups
    const gradeMap = {};
    grades.forEach(g => {
      if (g.submissionId) {
        gradeMap[g.submissionId.toString()] = g.marksObtained || 0;
      }
    });

    const studentTaskScores = {};
    submissions.forEach(sub => {
      if (sub.studentId) {
        const sId = sub.studentId.toString();
        const marks = gradeMap[sub._id.toString()] || 0;
        studentTaskScores[sId] = (studentTaskScores[sId] || 0) + marks;
      }
    });

    const studentMockScoresMap = {};
    mockDriveScores.forEach(score => {
      if (score.studentId) {
        const sId = score.studentId.toString();
        studentMockScoresMap[sId] = (studentMockScoresMap[sId] || 0) + (score.totalMarks || 0);
      }
    });

    // 6. Calculate ranks
    const studentScores = students.map(student => {
      const sId = student._id.toString();
      const totalTaskScore = roundToTwo(studentTaskScores[sId] || 0);
      const totalMockDriveScore = roundToTwo(studentMockScoresMap[sId] || 0);
      const streakScore = (student.leetcodeStreak || 0) * 10;
      const overallScore = roundToTwo(totalTaskScore + totalMockDriveScore + streakScore);

      return {
        studentId: sId,
        totalTaskScore,
        totalMockDriveScore,
        overallScore
      };
    });

    studentScores.sort((a, b) => b.overallScore - a.overallScore);
    const studentRanks = {};
    studentScores.forEach((s, idx) => {
      studentRanks[s.studentId] = idx + 1;
    });

    // 7. Determine all unique attendance dateStr values for the batch
    const uniqueDates = Array.from(new Set(attendanceRecords.map(r => r.dateStr))).sort();
    const totalSessions = uniqueDates.length;

    // ─── Build O(1) Fast Lookup Maps to eliminate quadratic nested iterations ───
    const studentSubmissionsMap = new Map();
    const submissionByStudentTaskMap = new Map();
    for (let i = 0; i < submissions.length; i++) {
      const s = submissions[i];
      if (!s.studentId) continue;
      const sId = s.studentId.toString();
      let list = studentSubmissionsMap.get(sId);
      if (!list) {
        list = [];
        studentSubmissionsMap.set(sId, list);
      }
      list.push(s);
      if (s.taskId) {
        submissionByStudentTaskMap.set(`${sId}_${s.taskId.toString()}`, s);
      }
    }

    const attendanceByStudentDateMap = new Map();
    for (let i = 0; i < attendanceRecords.length; i++) {
      const r = attendanceRecords[i];
      if (!r.studentId || !r.dateStr) continue;
      attendanceByStudentDateMap.set(`${r.studentId.toString()}_${r.dateStr}`, r);
    }

    const studentMockScoresMapById = new Map();
    const mockScoreByStudentDriveMap = new Map();
    for (let i = 0; i < mockDriveScores.length; i++) {
      const mds = mockDriveScores[i];
      if (!mds.studentId) continue;
      const sId = mds.studentId.toString();
      let list = studentMockScoresMapById.get(sId);
      if (!list) {
        list = [];
        studentMockScoresMapById.set(sId, list);
      }
      list.push(mds);
      if (mds.mockDriveId) {
        mockScoreByStudentDriveMap.set(`${sId}_${mds.mockDriveId.toString()}`, mds);
      }
    }

    const reqHours = batch && batch.requiredPresentHours !== undefined ? batch.requiredPresentHours : 8;
    const maxHours = batch && batch.maxValidHours !== undefined ? batch.maxValidHours : 10;

    // 8. Aggregate data per student using O(1) lookups
    const reportData = students.map(student => {
      const sId = student._id.toString();
      const totalTaskScore = roundToTwo(studentTaskScores[sId] || 0);
      const totalMockDriveScore = roundToTwo(studentMockScoresMap[sId] || 0);
      const streakScore = (student.leetcodeStreak || 0) * 10;
      const overallScore = roundToTwo(totalTaskScore + totalMockDriveScore + streakScore);

      const studentSubmissions = studentSubmissionsMap.get(sId) || [];
      const studentMockScores = studentMockScoresMapById.get(sId) || [];

      // Calculate attendance statistics with O(1) Map lookups
      let presentCount = 0;
      let absentCount = 0;
      let leaveCount = 0;
      let invalidCount = 0;
      let inProgressCount = 0;

      for (let i = 0; i < uniqueDates.length; i++) {
        const date = uniqueDates[i];
        const record = attendanceByStudentDateMap.get(`${sId}_${date}`);
        if (record) {
          if ((record.isLeave || record.status === 'Leave') && (record.leaveHours || 0) === 0) {
            leaveCount++;
          } else {
            const hours = (record.sessionDurationSeconds || 0) / 3600;
            const minRequired = reqHours - (record.leaveHours || 0);
            if (hours >= minRequired && hours <= maxHours) {
              presentCount++;
            } else if (hours > maxHours) {
              invalidCount++;
            } else if (record.isActive) {
              inProgressCount++;
            } else {
              absentCount++;
            }
          }
        } else {
          absentCount++;
        }
      }

      const denominator = totalSessions - leaveCount;
      const attendancePercentage = denominator > 0 ? Math.round((presentCount / denominator) * 100) : (totalSessions > 0 ? Math.round((presentCount / totalSessions) * 100) : 0);

      // Build basic flat report row
      const row = {
        'Student Name': student.name,
        'Roll Number': student.rollNumber || 'N/A',
        'Email': student.email,
        'Phone': student.phone || 'N/A',
        'Leetcode URL': student.leetcodeUrl || 'N/A',
        'Hackerrank URL': student.hackerrankUrl || 'N/A',
        'Leetcode Streak (Days)': student.leetcodeStreak || 0,
        'Leetcode Score': streakScore,
        
        // Attendance
        'Total Sessions': totalSessions,
        'Present Count': presentCount,
        'Absent Count': absentCount,
        'Leave Count': leaveCount,
        'Invalid Count': invalidCount,
        'In Progress Count': inProgressCount,
        'Attendance %': attendancePercentage,

        // Academic Summary
        'Completed Tasks': `${studentSubmissions.length} / ${tasks.length}`,
        'Attended Mock Drives': `${studentMockScores.length} / ${mockDrives.length}`,
        'Total Task Score': totalTaskScore,
        'Total Mock Drive Score': totalMockDriveScore,
        'Overall Score': overallScore,
        'Batch Rank': studentRanks[student._id.toString()] || 'N/A'
      };

      // Add individual Task Scores with O(1) lookup
      tasks.forEach(t => {
        const sub = submissionByStudentTaskMap.get(`${sId}_${t._id.toString()}`);
        if (sub) {
          const marks = gradeMap[sub._id.toString()];
          row[`Task: ${t.title} (Score)`] = (marks !== undefined) ? roundToTwo(marks) : 'Submitted (Not Graded)';
        } else {
          row[`Task: ${t.title} (Score)`] = 'Not Submitted';
        }
      });

      // Add individual Mock Drive details with O(1) lookup
      mockDrives.forEach(md => {
        const score = mockScoreByStudentDriveMap.get(`${sId}_${md._id.toString()}`);
        if (score) {
          row[`Mock Drive: ${md.title} (MCQ)`] = roundToTwo(score.mcq || 0);
          row[`Mock Drive: ${md.title} (Coding)`] = roundToTwo(score.coding || 0);
          row[`Mock Drive: ${md.title} (Tech HR)`] = roundToTwo(score.techHr || 0);
          row[`Mock Drive: ${md.title} (HR)`] = roundToTwo(score.hr || 0);
          row[`Mock Drive: ${md.title} (Total)`] = roundToTwo(score.totalMarks || 0);
          row[`Mock Drive: ${md.title} (Grade)`] = score.grade || 'Fail';
          row[`Mock Drive: ${md.title} (Status)`] = score.attended ? 'Present' : 'Absent';
        } else {
          row[`Mock Drive: ${md.title} (Total)`] = 'Absent';
        }
      });

      // Add individual Attendance Sessions with O(1) lookup
      uniqueDates.forEach((dateStr, index) => {
        const record = attendanceByStudentDateMap.get(`${sId}_${dateStr}`);
        let status = 'Absent';
        if (record) {
          if ((record.isLeave || record.status === 'Leave') && (record.leaveHours || 0) === 0) {
            status = 'Leave';
          } else {
            const hours = (record.sessionDurationSeconds || 0) / 3600;
            const minRequired = reqHours - (record.leaveHours || 0);
            if (hours >= minRequired && hours <= maxHours) {
              status = 'Present';
            } else if (hours > maxHours) {
              status = 'Invalid';
            } else if (record.isActive) {
              status = 'In Progress';
            } else {
              status = 'Absent';
            }
          }
        }

        let formattedDate = dateStr;
        try {
          const parts = dateStr.split('-');
          if (parts.length === 3) {
            formattedDate = `${parts[2]}/${parts[1]}/${parts[0]}`;
          }
        } catch (e) {}

        row[`Attendance Session ${index + 1} (${formattedDate})`] = status;
      });

      return row;
    });

    res.json(reportData);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Download Excel template for student bulk import
// @route   GET /api/batches/template/excel
// @access  Private/Admin
const downloadStudentTemplate = async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const sampleData = [
      { 'Name': 'ADHITHYA V', 'Register Number': '4MH23CB001', 'Password': 'Password@123' },
      { 'Name': 'AISHWARYA N K', 'Register Number': '4MH23CB002', 'Password': 'Password@124' },
      { 'Name': 'ANUSHA S K', 'Register Number': '4MH23CB003', 'Password': 'Password@125' }
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(sampleData);
    XLSX.utils.book_append_sheet(wb, ws, 'Student Template');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="students_import_template.xlsx"');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Fetch and parse data from a Google Sheet URL
// @route   POST /api/batches/fetch-google-sheet
// @access  Private/Admin
const fetchGoogleSheetData = async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ message: 'Google Sheet URL is required' });
    }

    let candidateUrls = [];
    
    // Always include the user-provided URL directly first
    candidateUrls.push(url.trim());

    let pubId = null;
    let stdId = null;

    const pubMatch = url.match(/\/spreadsheets\/d\/e\/([a-zA-Z0-9-_]+)/);
    if (pubMatch) {
      pubId = pubMatch[1];
    } else {
      const stdMatch = url.match(/\/spreadsheets\/d\/(?!e\/)([a-zA-Z0-9-_]+)/);
      if (stdMatch) {
        stdId = stdMatch[1];
      }
    }

    const gidMatch = url.match(/[?&]gid=([0-9]+)/) || url.match(/#gid=([0-9]+)/);
    const gid = gidMatch ? gidMatch[1] : '0';

    if (pubId) {
      candidateUrls.push(`https://docs.google.com/spreadsheets/d/e/${pubId}/pub?gid=${gid}&single=true&output=csv`);
    }
    if (stdId) {
      candidateUrls.push(`https://docs.google.com/spreadsheets/d/${stdId}/export?format=csv&gid=${gid}`);
      candidateUrls.push(`https://docs.google.com/spreadsheets/d/${stdId}/pub?output=csv&gid=${gid}`);
      candidateUrls.push(`https://docs.google.com/spreadsheets/d/${stdId}/gviz/tq?tqx=out:csv&gid=${gid}`);
    }

    const XLSX = require('xlsx');
    let csvBuffer = null;

    for (const targetUrl of candidateUrls) {
      try {
        const response = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/csv,text/plain,application/json,*/*'
          },
          redirect: 'follow'
        });

        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          const buffer = Buffer.from(await response.arrayBuffer());
          const textPreview = buffer.toString('utf8', 0, 300).trim().toLowerCase();

          if (!textPreview.startsWith('<!doctype') && !textPreview.startsWith('<html') && !contentType.includes('text/html')) {
            csvBuffer = buffer;
            break;
          }
        }
      } catch (err) {
        // Continue checking candidate URLs
      }
    }

    if (!csvBuffer) {
      return res.status(400).json({
        message: 'Google Sheets requires this sheet to be published. In Google Sheets, click File -> Share -> Publish to web, choose CSV, click Publish, and paste that link here. Or click File -> Download -> Microsoft Excel (.xlsx) and upload the file.'
      });
    }

    const wb = XLSX.read(csvBuffer, { type: 'buffer' });
    const wsName = wb.SheetNames[0];
    const ws = wb.Sheets[wsName];
    const rawData = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!Array.isArray(rawData) || rawData.length === 0) {
      return res.status(400).json({ message: 'No student records found in the Google Sheet' });
    }

    res.json({ success: true, count: rawData.length, data: rawData });
  } catch (error) {
    console.error('Google Sheet fetch error:', error.message);
    res.status(500).json({
      message: 'Failed to fetch Google Sheet. Please download as Excel (.xlsx) and use Choose Excel File.'
    });
  }
};

// @desc    Bulk upload students to batch
// @route   POST /api/batches/:id/bulk-upload-students
// @access  Private/Admin
const bulkUploadStudents = async (req, res) => {
  try {
    const batchId = req.params.id;
    const { students } = req.body;

    if (!Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ message: 'No student data provided' });
    }

    const batch = await Batch.findById(batchId);
    if (!batch) {
      return res.status(404).json({ message: 'Batch not found' });
    }

    let createdCount = 0;
    let enrolledCount = 0;
    const errors = [];

    // Pre-validate and gather search keys for batch querying
    const parsedRows = [];
    const rollNumbers = [];
    const emails = [];

    for (let i = 0; i < students.length; i++) {
      const s = students[i];
      const name = (s.name || s.Name || '').trim();
      const rollNumber = (s.rollNumber || s.registerNumber || s['Register Number'] || s['Roll Number'] || '').toString().trim();
      let email = (s.email || s.Email || '').toString().trim().toLowerCase();
      let password = (s.password || s.Password || '').toString().trim();

      if (!name || !rollNumber) {
        errors.push(`Row ${i + 1}: Missing Name or Register Number`);
        continue;
      }

      if (!password) {
        password = `${rollNumber}@123`;
      }

      if (!email) {
        email = `${rollNumber.toLowerCase().replace(/[^a-z0-9]/g, '')}@student.ssms.edu`;
      }

      parsedRows.push({ rowIndex: i + 1, name, rollNumber, email, password });
      rollNumbers.push(rollNumber);
      emails.push(email);
    }

    // 1 single batch query to find all matching users across rollNumbers and emails
    const existingUsers = await User.find({
      $or: [
        { rollNumber: { $in: rollNumbers } },
        { email: { $in: emails } }
      ]
    });

    const userByRoll = new Map();
    const userByEmail = new Map();
    existingUsers.forEach(u => {
      if (u.rollNumber) userByRoll.set(u.rollNumber.trim().toLowerCase(), u);
      if (u.email) userByEmail.set(u.email.trim().toLowerCase(), u);
    });

    // 1 single batch query to find all existing enrollments in this batch for the existing users
    const existingUserIds = existingUsers.map(u => u._id);
    const existingEnrollments = await Enrollment.find({
      batchId,
      studentId: { $in: existingUserIds }
    }).select('studentId').lean();
    const enrolledUserIds = new Set(existingEnrollments.map(e => e.studentId.toString()));

    // Process each student record
    for (const row of parsedRows) {
      try {
        let user = userByRoll.get(row.rollNumber.toLowerCase()) || userByEmail.get(row.email.toLowerCase());

        if (!user) {
          user = await User.create({
            name: row.name,
            rollNumber: row.rollNumber,
            email: row.email,
            password: row.password,
            role: 'student',
            isProfileComplete: false
          });
          userByRoll.set(row.rollNumber.toLowerCase(), user);
          userByEmail.set(row.email.toLowerCase(), user);
          createdCount++;
        } else {
          let updated = false;
          if (user.role !== 'student') {
            user.role = 'student';
            updated = true;
          }
          if (row.name && user.name !== row.name) {
            user.name = row.name;
            updated = true;
          }
          if (row.rollNumber && user.rollNumber !== row.rollNumber) {
            user.rollNumber = row.rollNumber;
            updated = true;
          }
          if (updated) {
            await user.save();
          }
        }

        // Enroll student if not already enrolled
        const sIdStr = user._id.toString();
        if (!enrolledUserIds.has(sIdStr)) {
          await Enrollment.create({
            studentId: user._id,
            batchId,
            status: 'approved'
          });
          enrolledUserIds.add(sIdStr);
          enrolledCount++;
        }
      } catch (err) {
        errors.push(`Row ${row.rowIndex} (${row.rollNumber}): ${err.message}`);
      }
    }

    // Sync batch common group with newly enrolled students
    ensureBatchCommonGroup(batchId).catch(err => console.warn('Auto batch group sync error:', err.message));

    res.json({
      message: 'Bulk student upload completed successfully',
      total: students.length,
      createdCount,
      enrolledCount,
      errors
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  createBatch,
  getBatches,
  getBatchById,
  updateBatch,
  closeBatch,
  autoCloseExpiredBatches,
  deleteBatch,
  getBatchReport,
  downloadStudentTemplate,
  fetchGoogleSheetData,
  bulkUploadStudents
};
