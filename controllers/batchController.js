const Batch = require('../models/Batch');
const Enrollment = require('../models/Enrollment');
const Task = require('../models/Task');
const Submission = require('../models/Submission');
const Grade = require('../models/Grade');
const Attendance = require('../models/Attendance');
const User = require('../models/User');

// @desc    Create a batch
// @route   POST /api/batches
// @access  Private/Admin
const createBatch = async (req, res) => {
  try {
    const { batchName, panelName, panelSubheading, description, startDate, endDate, status, mentorId, requiredPresentHours, maxValidHours, checkInTime, checkOutTime, autoCheckOutTime, autoCheckOutEnabled } = req.body;

    const assignedMentorId = mentorId || (req.user && req.user.role === 'mentor' ? req.user._id : null);

    const batch = await Batch.create({
      batchName,
      panelName: panelName ? panelName.trim() : '',
      panelSubheading: panelSubheading ? panelSubheading.trim() : '',
      description,
      startDate: startDate || new Date(),
      endDate: endDate || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      status: status || 'Active',
      mentorId: assignedMentorId,
      requiredPresentHours: requiredPresentHours !== undefined ? Number(requiredPresentHours) : 8,
      maxValidHours: maxValidHours !== undefined ? Number(maxValidHours) : 10,
      checkInTime: checkInTime || '09:00',
      checkOutTime: checkOutTime || '17:00',
      autoCheckOutTime: autoCheckOutTime || '21:00',
      autoCheckOutEnabled: autoCheckOutEnabled !== undefined ? Boolean(autoCheckOutEnabled) : true
    });

    const populatedBatch = await Batch.findById(batch._id).populate('mentorId', 'name email phone profileImage equippedAvatar').lean();
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
    let query = {};
    if (req.user && req.user.role === 'mentor') {
      query.mentorId = req.user._id;
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
    const batch = await Batch.findByIdAndUpdate(req.params.id, req.body, {
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
    const Batch = require('../models/Batch');
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

    // 8. Aggregate data per student
    const reportData = students.map(student => {
      const sId = student._id.toString();
      const totalTaskScore = roundToTwo(studentTaskScores[sId] || 0);
      const totalMockDriveScore = roundToTwo(studentMockScoresMap[sId] || 0);
      const streakScore = (student.leetcodeStreak || 0) * 10;
      const overallScore = roundToTwo(totalTaskScore + totalMockDriveScore + streakScore);

      const studentSubmissions = submissions.filter(s => s.studentId && s.studentId.toString() === sId);

      // Calculate attendance statistics
      const studentAttendance = attendanceRecords.filter(r => r.studentId && r.studentId.toString() === sId);
      let presentCount = 0;
      let absentCount = 0;
      let leaveCount = 0;
      let invalidCount = 0;
      let inProgressCount = 0;

      uniqueDates.forEach(date => {
        const record = studentAttendance.find(r => r.dateStr === date);
        if (record) {
          if ((record.isLeave || record.status === 'Leave') && (record.leaveHours || 0) === 0) {
            leaveCount++;
          } else {
            const hours = (record.sessionDurationSeconds || 0) / 3600;
            const minRequired = 8 - (record.leaveHours || 0);
            if (hours >= minRequired && hours <= 10) {
              presentCount++;
            } else if (hours > 10) {
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
      });

      const denominator = totalSessions - leaveCount;
      const attendancePercentage = denominator > 0 ? Math.round((presentCount / denominator) * 100) : (totalSessions > 0 ? Math.round((presentCount / totalSessions) * 100) : 0);

      // Get mock drive scores array for count and individual values
      const studentMockScores = mockDriveScores.filter(mds => mds.studentId && mds.studentId.toString() === sId);

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

      // Add individual Task Scores
      tasks.forEach(t => {
        const sub = studentSubmissions.find(s => s.taskId && s.taskId.toString() === t._id.toString());
        if (sub) {
          const marks = gradeMap[sub._id.toString()];
          row[`Task: ${t.title} (Score)`] = (marks !== undefined) ? roundToTwo(marks) : 'Submitted (Not Graded)';
        } else {
          row[`Task: ${t.title} (Score)`] = 'Not Submitted';
        }
      });

      // Add individual Mock Drive details
      mockDrives.forEach(md => {
        const score = studentMockScores.find(mds => mds.mockDriveId && mds.mockDriveId.toString() === md._id.toString());
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

      // Add individual Attendance Sessions
      uniqueDates.forEach((dateStr, index) => {
        const record = studentAttendance.find(r => r.dateStr === dateStr);
        let status = 'Absent';
        if (record) {
          if ((record.isLeave || record.status === 'Leave') && (record.leaveHours || 0) === 0) {
            status = 'Leave';
          } else {
            const hours = (record.sessionDurationSeconds || 0) / 3600;
            const minRequired = 8 - (record.leaveHours || 0);
            if (hours >= minRequired && hours <= 10) {
              status = 'Present';
            } else if (hours > 10) {
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

    const sheetIdMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) {
      return res.status(400).json({ message: 'Invalid Google Sheet URL format' });
    }
    const spreadsheetId = sheetIdMatch[1];

    const gidMatch = url.match(/[?&]gid=([0-9]+)/) || url.match(/#gid=([0-9]+)/);
    const gid = gidMatch ? gidMatch[1] : null;

    let csvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;
    if (gid) {
      csvUrl += `&gid=${gid}`;
    }

    const axios = require('axios');
    const XLSX = require('xlsx');

    const response = await axios.get(csvUrl, { responseType: 'arraybuffer' });
    const wb = XLSX.read(response.data, { type: 'buffer' });
    const wsName = wb.SheetNames[0];
    const ws = wb.Sheets[wsName];
    const rawData = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!Array.isArray(rawData) || rawData.length === 0) {
      return res.status(400).json({ message: 'No records found in the Google Sheet' });
    }

    res.json({ success: true, count: rawData.length, data: rawData });
  } catch (error) {
    console.error('Google Sheet fetch error:', error.message);
    res.status(500).json({
      message: 'Failed to fetch Google Sheet. Make sure the sheet link is set to "Anyone with the link can view".'
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
        email = `${rollNumber.toLowerCase().replace(/[^a-z0-9]/g, '')}@student.ssms`;
      }

      try {
        let user = await User.findOne({
          $or: [
            { rollNumber: { $regex: new RegExp(`^${rollNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
            { email: email }
          ]
        });

        if (!user) {
          user = await User.create({
            name,
            rollNumber,
            email,
            password,
            role: 'student',
            isProfileComplete: false
          });
          createdCount++;
        } else {
          if (user.role !== 'student') {
            user.role = 'student';
          }
          if (name) user.name = name;
          if (rollNumber) user.rollNumber = rollNumber;
          await user.save();
        }

        // Enroll student if not already enrolled
        const existingEnrollment = await Enrollment.findOne({ studentId: user._id, batchId });
        if (!existingEnrollment) {
          await Enrollment.create({
            studentId: user._id,
            batchId,
            status: 'approved'
          });
          enrolledCount++;
        }
      } catch (err) {
        errors.push(`Row ${i + 1} (${rollNumber}): ${err.message}`);
      }
    }

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
  deleteBatch,
  getBatchReport,
  downloadStudentTemplate,
  fetchGoogleSheetData,
  bulkUploadStudents
};
