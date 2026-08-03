const MockDrive = require('../models/MockDrive');
const MockDriveScore = require('../models/MockDriveScore');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const xlsx = require('xlsx');

const https = require('https');
const http = require('http');

// Helper to convert any Google Sheet link format into CSV export URL
const convertGoogleSheetUrlToCsvUrl = (inputUrl) => {
  if (!inputUrl) return '';
  let url = inputUrl.trim();

  if (url.includes('output=csv') || url.includes('format=csv')) {
    return url;
  }

  // Case 1: Published Google Sheet: https://docs.google.com/spreadsheets/d/e/2PACX-.../pubhtml
  if (url.includes('/spreadsheets/d/e/')) {
    const match = url.match(/\/spreadsheets\/d\/e\/([a-zA-Z0-9-_]+)/);
    if (match && match[1]) {
      const pubId = match[1];
      let csvUrl = `https://docs.google.com/spreadsheets/d/e/${pubId}/pub?output=csv`;
      const gidMatch = url.match(/[?&]gid=(\d+)/) || url.match(/#gid=(\d+)/);
      if (gidMatch && gidMatch[1]) {
        csvUrl += `&gid=${gidMatch[1]}`;
      }
      return csvUrl;
    }
  }

  // Case 2: Standard Google Sheet: https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/...
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) {
    const sheetId = match[1];
    let csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
    const gidMatch = url.match(/[?&]gid=(\d+)/) || url.match(/#gid=(\d+)/);
    if (gidMatch && gidMatch[1]) {
      csvUrl += `&gid=${gidMatch[1]}`;
    }
    return csvUrl;
  }

  return url;
};

// Helper to fetch CSV data from a URL with redirect following
const fetchCsvFromUrl = (url, maxRedirects = 5) => {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects fetching Google Sheet'));

    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchCsvFromUrl(res.headers.location, maxRedirects - 1));
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch Google Sheet (HTTP ${res.statusCode}). Please ensure the sheet sharing permission is set to "Anyone with the link can view".`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', (err) => reject(err));
    }).on('error', (err) => reject(err));
  });
};

// Helper to parse row fields case-insensitively and flexibly
const parseExcelRow = (row) => {
  let studentName = '';
  let studentEmail = '';
  let rollNumber = '';
  let mcq = null;
  let aptitude = null;
  let coding = 0;
  let techHr = 0;
  let hr = 0;
  let totalMarks = null;
  let percentage = null;
  let grade = '';
  const roundScores = [];

  Object.keys(row).forEach(key => {
    const k = key.toLowerCase().trim();
    const value = row[key];
    if (value === undefined || value === null || String(value).trim() === '') return;

    if (k.includes('roll') || k.includes('usn') || k.includes('reg') || k.includes('student id')) {
      rollNumber = String(value).trim();
    } else if (k.includes('email')) {
      studentEmail = String(value).trim();
    } else if (k.includes('name')) {
      studentName = String(value).trim();
    } else if (k.includes('total') || k.includes('aggregate')) {
      totalMarks = Number(value) || 0;
    } else if (k.includes('percent') || k.includes('%')) {
      percentage = Number(value) || 0;
    } else if (k.includes('grade') || k.includes('status') || k.includes('result')) {
      grade = String(value).trim();
    } else {
      // Parse round numeric scores dynamically
      const numVal = Number(value);
      if (!isNaN(numVal) && !k.includes('sl') && !k.includes('s.no') && !k.includes('sno') && !k.includes('id')) {
        let roundMaxMarks = 0;
        const maxMatch = key.match(/\((\d+)\s*marks?\)/i) || key.match(/\((\d+)\)/);
        if (maxMatch && maxMatch[1]) {
          roundMaxMarks = Number(maxMatch[1]);
        }

        roundScores.push({
          name: key.trim(),
          score: numVal,
          maxMarks: roundMaxMarks
        });

        // Assign legacy fields for fallback
        if (k.includes('apt')) aptitude = numVal;
        else if (k.includes('mcq')) mcq = numVal;
        else if (k.includes('coding') || k.includes('code')) coding = numVal;
        else if (k.includes('tech hr') || k.includes('techhr') || k.includes('technical')) techHr = numVal;
        else if (k.includes('hr') && !k.includes('tech')) hr = numVal;
      }
    }
  });

  if (totalMarks === null) {
    if (roundScores.length > 0) {
      totalMarks = roundScores.reduce((sum, r) => sum + (Number(r.score) || 0), 0);
    } else {
      totalMarks = (aptitude || 0) + (mcq || 0) + coding + techHr + hr;
    }
  }

  if (!grade) {
    grade = totalMarks > 0 ? 'Pass' : 'Fail';
  }

  return { studentName, studentEmail, rollNumber, mcq, aptitude, coding, techHr, hr, roundScores, totalMarks, percentage, grade };
};

// @desc    Parse uploaded Excel sheet and match students in the batch
// @route   POST /api/mock-drives/parse-excel
// @access  Private/Admin/Mentor
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

    for (const sheetName of wb.SheetNames) {
      const tempWs = wb.Sheets[sheetName];
      const tempRawData = xlsx.utils.sheet_to_json(tempWs);
      if (tempRawData.length > 0) {
        const headers = Object.keys(tempRawData[0] || {}).map(h => h.toLowerCase().trim());
        const hasEmail = headers.some(h => h.includes('email'));
        const hasName = headers.some(h => h.includes('name'));
        const hasRoll = headers.some(h => h.includes('roll') || h.includes('usn') || h.includes('reg'));
        const hasScoreFields = headers.some(h => h.includes('apt') || h.includes('mcq') || h.includes('coding') || h.includes('total') || h.includes('round') || h.includes('mark'));

        if ((hasEmail || hasName || hasRoll) && hasScoreFields) {
          ws = tempWs;
          rawData = tempRawData;
          break;
        }
      }
    }

    if (!ws) {
      ws = wb.Sheets[wb.SheetNames[0]];
      rawData = xlsx.utils.sheet_to_json(ws);
    }

    if (rawData.length === 0) return res.status(400).json({ message: 'Excel file is empty' });

    // Extract dynamic max marks from spreadsheet headers
    const headers = Object.keys(rawData[0] || {});
    let parsedMaxMarks = 749;
    let roundMaxMarksSum = 0;

    for (const header of headers) {
      const hLower = header.toLowerCase();
      if (hLower.includes('total') || hLower.includes('aggregate')) {
        const match = header.match(/for\s+(\d+)/i) || header.match(/\((\d+)\s*marks?\)/i) || header.match(/\((\d+)\)/);
        if (match && match[1]) {
          parsedMaxMarks = Number(match[1]);
          break;
        }
      }
      const roundMatch = header.match(/\((\d+)\s*marks?\)/i) || header.match(/\((\d+)\)/);
      if (roundMatch && roundMatch[1]) {
        roundMaxMarksSum += Number(roundMatch[1]);
      }
    }

    if (roundMaxMarksSum > 0 && parsedMaxMarks === 749) {
      parsedMaxMarks = roundMaxMarksSum;
    }

    // 3. Process rows and match by Roll Number first
    const parsedRows = [];
    const matchedStudentIds = new Set();

    rawData.forEach((row, index) => {
      const parsedData = parseExcelRow(row);
      if (!parsedData.studentEmail && !parsedData.studentName && !parsedData.rollNumber) return;

      let matchedStudent = null;
      const cleanRoll = (parsedData.rollNumber || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const normalizedEmail = (parsedData.studentEmail || '').toLowerCase().trim();
      const rollFromEmail = normalizedEmail.split('@')[0].replace(/[^a-z0-9]/g, '');

      // Priority 1: Match by exact / cleaned rollNumber (USN)
      if (cleanRoll) {
        matchedStudent = students.find(s => s.rollNumber && s.rollNumber.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanRoll);
      }

      // Priority 2: Match by email prefix
      if (!matchedStudent && rollFromEmail) {
        matchedStudent = students.find(s => s.rollNumber && s.rollNumber.toLowerCase().replace(/[^a-z0-9]/g, '') === rollFromEmail);
      }

      // Priority 3: Match by student email
      if (!matchedStudent && normalizedEmail) {
        matchedStudent = students.find(s => s.email && s.email.toLowerCase().trim() === normalizedEmail);
      }

      // Priority 4: Match by studentName
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

// @desc    Parse Google Sheet link and match students in the batch
// @route   POST /api/mock-drives/parse-google-sheet
// @access  Private/Admin/Mentor
const parseMockDriveGoogleSheet = async (req, res) => {
  try {
    const { batchId, googleSheetUrl } = req.body;
    if (!batchId) return res.status(400).json({ message: 'Batch ID is required' });
    if (!googleSheetUrl) return res.status(400).json({ message: 'Google Sheet link is required' });

    const csvUrl = convertGoogleSheetUrlToCsvUrl(googleSheetUrl);
    if (!csvUrl) return res.status(400).json({ message: 'Invalid Google Sheet link' });

    const csvBuffer = await fetchCsvFromUrl(csvUrl);
    const wb = xlsx.read(csvBuffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rawData = xlsx.utils.sheet_to_json(ws);

    if (!rawData || rawData.length === 0) {
      return res.status(400).json({ message: 'Google Sheet appears to be empty or unreadable' });
    }

    const headers = Object.keys(rawData[0] || {});
    let parsedMaxMarks = 749;
    let roundMaxMarksSum = 0;

    for (const header of headers) {
      const hLower = header.toLowerCase();
      if (hLower.includes('total') || hLower.includes('aggregate')) {
        const match = header.match(/for\s+(\d+)/i) || header.match(/\((\d+)\s*marks?\)/i) || header.match(/\((\d+)\)/);
        if (match && match[1]) {
          parsedMaxMarks = Number(match[1]);
          break;
        }
      }
      const roundMatch = header.match(/\((\d+)\s*marks?\)/i) || header.match(/\((\d+)\)/);
      if (roundMatch && roundMatch[1]) {
        roundMaxMarksSum += Number(roundMatch[1]);
      }
    }

    if (roundMaxMarksSum > 0 && parsedMaxMarks === 749) {
      parsedMaxMarks = roundMaxMarksSum;
    }

    const enrollments = await Enrollment.find({ batchId, status: 'approved' }).populate('studentId', 'name email rollNumber');
    const students = enrollments.map(e => e.studentId).filter(s => s !== null);

    const parsedRows = [];
    const matchedStudentIds = new Set();

    rawData.forEach((row, index) => {
      const parsedData = parseExcelRow(row);
      if (!parsedData.studentEmail && !parsedData.studentName && !parsedData.rollNumber) return;

      let matchedStudent = null;
      const cleanRoll = (parsedData.rollNumber || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const normalizedEmail = (parsedData.studentEmail || '').toLowerCase().trim();
      const rollFromEmail = normalizedEmail.split('@')[0].replace(/[^a-z0-9]/g, '');

      if (cleanRoll) {
        matchedStudent = students.find(s => s.rollNumber && s.rollNumber.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanRoll);
      }
      if (!matchedStudent && rollFromEmail) {
        matchedStudent = students.find(s => s.rollNumber && s.rollNumber.toLowerCase().replace(/[^a-z0-9]/g, '') === rollFromEmail);
      }
      if (!matchedStudent && normalizedEmail) {
        matchedStudent = students.find(s => s.email && s.email.toLowerCase().trim() === normalizedEmail);
      }
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

    const unmatchedStudents = students.filter(s => !matchedStudentIds.has(s._id.toString())).map(s => ({
      _id: s._id,
      name: s.name,
      email: s.email,
      rollNumber: s.rollNumber
    }));

    res.json({
      message: 'Google Sheet parsed successfully',
      rows: parsedRows,
      unmatchedStudents,
      maxMarks: parsedMaxMarks
    });
  } catch (error) {
    console.error('Error parsing Google Sheet:', error);
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
  parseMockDriveGoogleSheet,
  saveMockDrive,
  getMockDrivesByBatch,
  getStudentMockDriveScores,
  deleteMockDrive,
  updateStudentScoreManually,
  getMockDriveScores,
  updateMockDrive
};
