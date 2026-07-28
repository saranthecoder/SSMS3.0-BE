const MockDrive = require('../models/MockDrive');
const MockDriveScore = require('../models/MockDriveScore');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const xlsx = require('xlsx');

// Helper to parse row fields case-insensitively and flexibly
const parseExcelRow = (row) => {
  let studentName = '';
  let studentEmail = '';
  let mcq = null;
  let aptitude = null;
  let coding = 0;
  let techHr = 0;
  let hr = 0;
  let totalMarks = 0;
  let percentage = 0;
  let grade = 'Fail';
  const roundScores = [];

  Object.keys(row).forEach(key => {
    const k = key.toLowerCase().trim();
    const value = row[key];

    if (k.includes('email')) {
      studentEmail = String(value).trim();
    } else if (k.includes('name')) {
      studentName = String(value).trim();
    } else if (k.includes('apt')) {
      aptitude = Number(value) || 0;
      roundScores.push({ name: key.trim(), score: aptitude });
    } else if (k.includes('mcq')) {
      mcq = Number(value) || 0;
      roundScores.push({ name: key.trim(), score: mcq });
    } else if (k.includes('coding')) {
      coding = Number(value) || 0;
      roundScores.push({ name: key.trim(), score: coding });
    } else if (k.includes('tech hr') || k.includes('techhr') || k.includes('technical')) {
      techHr = Number(value) || 0;
      roundScores.push({ name: key.trim(), score: techHr });
    } else if (k.includes('hr') && !k.includes('tech')) {
      hr = Number(value) || 0;
      roundScores.push({ name: key.trim(), score: hr });
    } else if (k.includes('total')) {
      totalMarks = Number(value) || 0;
    } else if (k.includes('percent')) {
      percentage = Number(value) || 0;
    } else if (k.includes('grade')) {
      grade = String(value).trim();
    } else if (!isNaN(Number(value)) && !k.includes('sl') && !k.includes('roll') && !k.includes('reg') && !k.includes('s.no') && !k.includes('sno') && !k.includes('status')) {
      roundScores.push({ name: key.trim(), score: Number(value) || 0 });
    }
  });

  return { studentName, studentEmail, mcq, aptitude, coding, techHr, hr, roundScores, totalMarks, percentage, grade };
};

// @desc    Parse uploaded Excel sheet and match students in the batch
// @route   POST /api/mock-drives/parse-excel
// @access  Private/Admin
const parseMockDriveExcel = async (req, res) => {
  try {
    const { batchId } = req.body;
    if (!batchId) return res.status(400).json({ message: 'Batch ID is required' });
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    // 1. Fetch all enrolled students in the batch
    const enrollments = await Enrollment.find({ batchId, status: 'approved' }).populate('studentId', 'name email rollNumber');
    const students = enrollments.map(e => e.studentId).filter(s => s !== null);

    // 2. Read spreadsheet
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    
    let ws = null;
    let rawData = [];

    // Search all sheets to find the correct worksheet containing student scores (e.g. MockTest3)
    for (const sheetName of wb.SheetNames) {
      const tempWs = wb.Sheets[sheetName];
      const tempRawData = xlsx.utils.sheet_to_json(tempWs);
      if (tempRawData.length > 0) {
        const headers = Object.keys(tempRawData[0] || {}).map(h => h.toLowerCase().trim());
        const hasEmail = headers.some(h => h.includes('email'));
        const hasName = headers.some(h => h.includes('name'));
        const hasScoreFields = headers.some(h => h.includes('apt') || h.includes('mcq') || h.includes('coding') || h.includes('total'));

        if ((hasEmail || hasName) && hasScoreFields) {
          ws = tempWs;
          rawData = tempRawData;
          break;
        }
      }
    }

    // Fallback to the first worksheet if no sheet satisfies the auto-detect signature
    if (!ws) {
      ws = wb.Sheets[wb.SheetNames[0]];
      rawData = xlsx.utils.sheet_to_json(ws);
    }

    if (rawData.length === 0) return res.status(400).json({ message: 'Excel file is empty' });

    // Extract dynamic max marks from spreadsheet headers
    const headers = Object.keys(rawData[0] || {});
    let parsedMaxMarks = 749; // default fallback
    for (const header of headers) {
      if (header.toLowerCase().includes('total') && header.includes('for')) {
        const match = header.match(/for\s+(\d+)/i);
        if (match && match[1]) {
          parsedMaxMarks = Number(match[1]);
          break;
        }
      }
    }

    // 3. Process rows and try matching automatically
    const parsedRows = [];
    const matchedStudentIds = new Set();

    rawData.forEach((row, index) => {
      const parsedData = parseExcelRow(row);
      if (!parsedData.studentEmail && !parsedData.studentName) return; // skip junk rows

      let matchedStudent = null;
      const normalizedEmail = parsedData.studentEmail.toLowerCase();
      const rollPrefix = normalizedEmail.split('@')[0].trim();

      // Attempt matching:
      // a. Match by exact email
      matchedStudent = students.find(s => s.email.toLowerCase() === normalizedEmail);

      // b. Match by roll number prefix
      if (!matchedStudent && rollPrefix) {
        matchedStudent = students.find(s => s.rollNumber && s.rollNumber.toLowerCase() === rollPrefix);
      }

      // c. Match by studentName (normalized spaces and case)
      if (!matchedStudent && parsedData.studentName) {
        const normalizeName = (val) => val ? val.toLowerCase().replace(/\s+/g, ' ').trim() : '';
        const normSearch = normalizeName(parsedData.studentName);
        matchedStudent = students.find(s => normalizeName(s.name) === normSearch);
      }

      if (matchedStudent) {
        matchedStudentIds.add(matchedStudent._id.toString());
      }

      parsedRows.push({
        id: index,
        rowData: parsedData,
        matchedStudent: matchedStudent ? {
          _id: matchedStudent._id,
          name: matchedStudent.name,
          email: matchedStudent.email,
          rollNumber: matchedStudent.rollNumber
        } : null
      });
    });

    // Find students in the database batch who were NOT matched automatically
    const unmatchedStudents = students.filter(s => !matchedStudentIds.has(s._id.toString())).map(s => ({
      _id: s._id,
      name: s.name,
      email: s.email,
      rollNumber: s.rollNumber
    }));

    res.json({
      message: 'Excel parsed successfully',
      rows: parsedRows,
      unmatchedStudents,
      maxMarks: parsedMaxMarks
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Confirm and save mock drive scores (auto-grading unmatched students to 0)
// @route   POST /api/mock-drives
// @access  Private/Admin
const saveMockDrive = async (req, res) => {
  try {
    const { title, batchId, maxMarks = 749, scores } = req.body;
    if (!title) return res.status(400).json({ message: 'Title is required' });
    if (!batchId) return res.status(400).json({ message: 'Batch ID is required' });
    if (!scores || !Array.isArray(scores)) return res.status(400).json({ message: 'Scores list is required' });

    // 1. Create Mock Drive entry
    const mockDrive = await MockDrive.create({
      title,
      batchId,
      maxMarks,
      createdBy: req.user._id
    });

    // 2. Fetch all approved students in the batch
    const enrollments = await Enrollment.find({ batchId, status: 'approved' });
    const batchStudentIds = enrollments.map(e => e.studentId.toString());

    // 3. Map student scores
    const savedScores = [];
    const matchedStudentIds = new Set();

    // First, save students present in the uploaded sheet
    for (const item of scores) {
      if (item.studentId) {
        const studentIdStr = item.studentId.toString();
        matchedStudentIds.add(studentIdStr);

        const scoreRecord = await MockDriveScore.create({
          mockDriveId: mockDrive._id,
          studentId: item.studentId,
          aptitude: item.rowData.aptitude,
          mcq: item.rowData.mcq,
          coding: item.rowData.coding,
          techHr: item.rowData.techHr,
          hr: item.rowData.hr,
          roundScores: item.rowData.roundScores || [],
          totalMarks: item.rowData.totalMarks,
          percentage: item.rowData.percentage,
          grade: item.rowData.grade,
          attended: true
        });
        savedScores.push(scoreRecord);

        // Gamification rewards for mock drive results
        try {
          const User = require('../models/User');
          const studentUser = await User.findById(item.studentId);
          if (studentUser) {
            const totalMarks = Number(item.rowData.totalMarks);
            let letterGrade = (item.rowData.grade || '').toString().trim().toUpperCase();

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
            
            const { awardCoinsWithCap, awardXPWithCap, checkAndAwardBadges } = require('../utils/gamification');
            const actualCoins = awardCoinsWithCap(studentUser, coinsReward, `Mock drive grade: ${letterGrade}`, true);
            const actualXP = awardXPWithCap(studentUser, pointsReward, `Mock drive grade: ${letterGrade}`, true);
            checkAndAwardBadges(studentUser);

            await studentUser.save();

            // Create GamificationEvent record for user reward history
            const GamificationEvent = require('../models/GamificationEvent');
            await GamificationEvent.create({
              userId: studentUser._id,
              eventType: 'coins_earned',
              coinsChange: actualCoins,
              xpChange: actualXP.actual || 0,
              reason: `Mock drive grade: ${letterGrade}`
            });
          }
        } catch (rewErr) {
          console.error('Error awarding mock drive coins:', rewErr);
        }
      }
    }

    // Second, grade any absent students (not matched in the sheet) to 0 marks
    for (const studentId of batchStudentIds) {
      if (!matchedStudentIds.has(studentId)) {
        const scoreRecord = await MockDriveScore.create({
          mockDriveId: mockDrive._id,
          studentId: studentId,
          aptitude: null,
          mcq: null,
          coding: 0,
          techHr: 0,
          hr: 0,
          totalMarks: 0,
          percentage: 0,
          grade: 'Fail',
          attended: false // absent
        });
        savedScores.push(scoreRecord);
      }
    }

    res.status(201).json({
      message: 'Mock drive and score reports saved successfully',
      mockDrive,
      totalStudentsGraded: savedScores.length
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all mock drives for a batch (or all batches if batchId is 'all')
// @route   GET /api/mock-drives/batch/:batchId
// @access  Private
const getMockDrivesByBatch = async (req, res) => {
  try {
    const filter = req.params.batchId && req.params.batchId !== 'all' ? { batchId: req.params.batchId } : {};
    const mockDrives = await MockDrive.find(filter)
      .populate('createdBy', 'name')
      .sort('-date');
    res.json(mockDrives);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get student's mock drive scores
// @route   GET /api/mock-drives/student/:studentId
// @access  Private
const getStudentMockDriveScores = async (req, res) => {
  try {
    const studentId = req.params.studentId;
    if (req.user.role === 'student' && req.user._id.toString() !== studentId) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const scores = await MockDriveScore.find({ studentId })
      .populate('mockDriveId', 'title maxMarks date')
      .sort('-createdAt');
      
    res.json(scores);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete mock drive and its score reports
// @route   DELETE /api/mock-drives/:id
// @access  Private/Admin
const deleteMockDrive = async (req, res) => {
  try {
    const mockDrive = await MockDrive.findById(req.params.id);
    if (!mockDrive) return res.status(404).json({ message: 'Mock drive not found' });

    // Remove score records
    await MockDriveScore.deleteMany({ mockDriveId: req.params.id });
    
    // Remove the mock drive itself
    await mockDrive.deleteOne();

    res.json({ message: 'Mock drive and score reports deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Manually update score for a student
// @route   PUT /api/mock-drives/:id/score
// @access  Private/Admin
const updateStudentScoreManually = async (req, res) => {
  try {
    const { studentId, aptitude, mcq, coding, techHr, hr, totalMarks, percentage, grade, attended } = req.body;
    const mockDriveId = req.params.id;

    let scoreRecord = await MockDriveScore.findOne({ mockDriveId, studentId });
    if (!scoreRecord) {
      scoreRecord = new MockDriveScore({ mockDriveId, studentId });
    }

    scoreRecord.aptitude = aptitude !== undefined ? aptitude : scoreRecord.aptitude;
    scoreRecord.mcq = mcq !== undefined ? mcq : scoreRecord.mcq;
    scoreRecord.coding = coding !== undefined ? coding : scoreRecord.coding;
    scoreRecord.techHr = techHr !== undefined ? techHr : scoreRecord.techHr;
    scoreRecord.hr = hr !== undefined ? hr : scoreRecord.hr;
    scoreRecord.totalMarks = totalMarks !== undefined ? totalMarks : scoreRecord.totalMarks;
    scoreRecord.percentage = percentage !== undefined ? percentage : scoreRecord.percentage;
    scoreRecord.grade = grade !== undefined ? grade : scoreRecord.grade;
    scoreRecord.attended = attended !== undefined ? attended : scoreRecord.attended;

    await scoreRecord.save();
    res.json({ message: 'Score record updated successfully', scoreRecord });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all scores for a mock drive (admin details)
// @route   GET /api/mock-drives/:id/scores
// @access  Private/Admin
const getMockDriveScores = async (req, res) => {
  try {
    const scores = await MockDriveScore.find({ mockDriveId: req.params.id })
      .populate('studentId', 'name email rollNumber')
      .sort('studentId');
    res.json(scores);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update mock drive metadata (title, maxMarks, date)
// @route   PUT /api/mock-drives/:id
// @access  Private/Admin
const updateMockDrive = async (req, res) => {
  try {
    const { title, maxMarks, date } = req.body;
    const mockDrive = await MockDrive.findById(req.params.id);
    if (!mockDrive) return res.status(404).json({ message: 'Mock drive not found' });

    mockDrive.title = title !== undefined ? title : mockDrive.title;
    mockDrive.maxMarks = maxMarks !== undefined ? Number(maxMarks) : mockDrive.maxMarks;
    mockDrive.date = date !== undefined ? date : mockDrive.date;

    await mockDrive.save();
    res.json({ message: 'Mock drive updated successfully', mockDrive });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  parseMockDriveExcel,
  saveMockDrive,
  getMockDrivesByBatch,
  getStudentMockDriveScores,
  deleteMockDrive,
  updateStudentScoreManually,
  getMockDriveScores,
  updateMockDrive
};
