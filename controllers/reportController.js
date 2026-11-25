const os = require('os');
const mongoose = require('mongoose');
const StudentReport = require('../models/StudentReport');
const ReportConfig = require('../models/ReportConfig');
const ReportJob = require('../models/ReportJob');
const Batch = require('../models/Batch');
const JobLock = require('../models/JobLock');
const socketHandlers = require('../sockets/socketHandlers');
const {
  DEFAULT_WEIGHTS,
  resolvePeriodDates,
  computeBatchPerformanceReports
} = require('../services/reportAnalyticsService');

const INSTANCE_ID = `${os.hostname()}_${process.pid}`;

const verifyBatchAuthorization = async (user, batchId) => {
  if (!batchId || !mongoose.Types.ObjectId.isValid(batchId)) {
    return { ok: false, status: 400, message: 'Invalid batchId' };
  }
  const batch = await Batch.findById(batchId).select('batchName startDate mentorId mentors').lean();
  if (!batch) {
    return { ok: false, status: 404, message: 'Batch not found' };
  }
  if (user.role === 'admin') {
    return { ok: true, batch };
  }
  if (user.role === 'mentor') {
    const uid = user._id.toString();
    const isLead = batch.mentorId && batch.mentorId.toString() === uid;
    const isCoMentor = Array.isArray(batch.mentors) && batch.mentors.some(m => m && m.toString() === uid);
    if (isLead || isCoMentor) {
      return { ok: true, batch };
    }
  }
  return { ok: false, status: 403, message: 'Not authorized to access reports for this batch' };
};

const getEffectiveWeights = async (batchId) => {
  const batchConfig = batchId
    ? await ReportConfig.findOne({ scope: 'batch', batchId }).lean()
    : null;
  if (batchConfig?.weights) return batchConfig.weights;
  const globalConfig = await ReportConfig.findOne({ scope: 'global' }).lean();
  return globalConfig?.weights || DEFAULT_WEIGHTS;
};

// @desc    Get released performance reports for logged-in student
// @route   GET /api/reports/my
// @access  Private (Student)
const getMyReports = async (req, res) => {
  try {
    const { reportType, page = 1, limit = 20 } = req.query;
    const query = {
      studentId: req.user._id,
      status: 'released'
    };
    if (reportType && ['weekly', 'monthly', 'cumulative'].includes(reportType)) {
      query.reportType = reportType;
    }

    const skip = (Math.max(1, Number(page)) - 1) * Math.min(50, Number(limit));
    const [reports, total] = await Promise.all([
      StudentReport.find(query)
        .populate('batchId', 'batchName')
        .populate('releasedBy', 'name role')
        .sort({ endDate: -1, releasedAt: -1 })
        .skip(skip)
        .limit(Math.min(50, Number(limit)))
        .lean(),
      StudentReport.countDocuments(query)
    ]);

    res.json({
      reports,
      total,
      page: Number(page),
      pages: Math.ceil(total / Math.min(50, Number(limit)))
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc    Get single performance report by ID (role-enforced)
// @route   GET /api/reports/:id
// @access  Private (Student/Mentor/Admin)
const getReportById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid report ID' });
    }

    const report = await StudentReport.findById(req.params.id)
      .populate('studentId', 'name email rollNumber')
      .populate('batchId', 'batchName mentorId mentors')
      .populate('generatedBy', 'name role')
      .populate('releasedBy', 'name role');

    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }

    if (req.user.role === 'student') {
      if (report.studentId._id.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Access denied: You can only view your own reports' });
      }
      if (report.status !== 'released') {
        return res.status(403).json({ message: 'This report has not been released yet' });
      }
      // Track student view timestamp
      if (!report.viewedByStudentAt) {
        report.viewedByStudentAt = new Date();
      }
      report.viewCount = (report.viewCount || 0) + 1;
      await report.save();
    } else if (req.user.role === 'mentor') {
      const auth = await verifyBatchAuthorization(req.user, report.batchId._id || report.batchId);
      if (!auth.ok) {
        return res.status(auth.status).json({ message: auth.message });
      }
    }

    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc    Generate Weekly / Monthly / Cumulative reports for a batch (or selected students)
// @route   POST /api/reports/generate
// @access  Private (Mentor/Admin)
const generateReports = async (req, res) => {
  const {
    batchId,
    reportType = 'weekly',
    startDate,
    endDate,
    month,
    weekStart,
    studentIds,
    regenerate = false
  } = req.body;

  if (!['weekly', 'monthly', 'cumulative'].includes(reportType)) {
    return res.status(400).json({ message: 'Invalid reportType. Must be weekly, monthly, or cumulative.' });
  }

  const auth = await verifyBatchAuthorization(req.user, batchId);
  if (!auth.ok) {
    return res.status(auth.status).json({ message: auth.message });
  }

  const batchStartStr = auth.batch.startDate
    ? new Date(auth.batch.startDate).toISOString().split('T')[0]
    : undefined;

  const period = resolvePeriodDates({
    reportType,
    startDate,
    endDate,
    month,
    weekStart,
    joiningDate: batchStartStr
  });

  const lockName = `report_gen_${batchId}_${reportType}_${period.periodKey}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 120000); // 2 min distributed lease

  let lockAcquired = false;
  try {
    const lock = await JobLock.findOneAndUpdate(
      {
        jobName: lockName,
        $or: [{ expiresAt: { $lt: now } }, { lockedBy: INSTANCE_ID }]
      },
      { $set: { lockedBy: INSTANCE_ID, lockedAt: now, expiresAt } },
      { upsert: true, returnDocument: 'after' }
    ).catch(() => null);

    if (!lock) {
      return res.status(409).json({ message: 'Report generation for this batch & period is already in progress on another worker.' });
    }
    lockAcquired = true;

    const weights = await getEffectiveWeights(batchId);
    const { studentReports, batchSummary } = await computeBatchPerformanceReports({
      batchId,
      reportType,
      startDate: period.startDate,
      endDate: period.endDate,
      weights,
      studentIdsFilter: Array.isArray(studentIds) && studentIds.length > 0 ? studentIds : null
    });

    const job = await ReportJob.create({
      jobKey: lockName,
      batchId,
      reportType,
      periodKey: period.periodKey,
      startDate: period.startDate,
      endDate: period.endDate,
      status: 'processing',
      totalStudents: studentReports.length,
      processedStudents: 0,
      requestedBy: req.user._id,
      instanceId: INSTANCE_ID,
      startedAt: new Date()
    });

    const createdReports = [];
    const CHUNK_SIZE = 25;

    for (let i = 0; i < studentReports.length; i += CHUNK_SIZE) {
      const chunk = studentReports.slice(i, i + CHUNK_SIZE);
      for (const sr of chunk) {
        const latest = await StudentReport.findOne({
          studentId: sr.student._id,
          batchId,
          reportType,
          periodKey: period.periodKey
        }).sort({ version: -1 });

        if (latest && !regenerate) {
          // Avoid duplicate generation; reuse existing unless regenerate is requested
          createdReports.push(latest);
          continue;
        }

        const nextVersion = latest ? latest.version + 1 : 1;
        const doc = await StudentReport.create({
          studentId: sr.student._id,
          batchId,
          reportType,
          periodKey: period.periodKey,
          startDate: sr.effectiveStart,
          endDate: sr.effectiveEnd,
          joiningDate: sr.joiningDate,
          status: 'generated',
          version: nextVersion,
          dataSnapshot: sr.snapshot,
          scoringWeights: weights,
          dataCompleteness: sr.dataCompleteness,
          mentorFeedback: latest?.mentorFeedback || {},
          generatedBy: req.user._id,
          generatedAt: new Date()
        });
        createdReports.push(doc);
      }

      job.processedStudents = Math.min(studentReports.length, i + chunk.length);
      await job.save();
    }

    job.status = 'completed';
    job.completedAt = new Date();
    await job.save();

    res.status(201).json({
      success: true,
      jobId: job._id,
      period,
      batchSummary,
      count: createdReports.length,
      reports: createdReports
    });
  } catch (err) {
    console.error('Error generating performance reports:', err);
    res.status(500).json({ message: err.message });
  } finally {
    if (lockAcquired) {
      await JobLock.deleteOne({ jobName: lockName, lockedBy: INSTANCE_ID }).catch(() => {});
    }
  }
};

// @desc    Get batch reports & batch analytics comparison
// @route   GET /api/reports/batch/:batchId
// @access  Private (Mentor/Admin)
const getBatchReports = async (req, res) => {
  try {
    const { batchId } = req.params;
    const { reportType, periodKey, status, page = 1, limit = 200 } = req.query;

    const auth = await verifyBatchAuthorization(req.user, batchId);
    if (!auth.ok) {
      return res.status(auth.status).json({ message: auth.message });
    }

    const match = { batchId: new mongoose.Types.ObjectId(batchId) };
    if (reportType && ['weekly', 'monthly', 'cumulative'].includes(reportType)) {
      match.reportType = reportType;
    }
    if (periodKey) {
      match.periodKey = periodKey;
    }
    if (status && ['draft', 'generated', 'in_review', 'released', 'revoked'].includes(status)) {
      match.status = status;
    }

    const skip = (Math.max(1, Number(page)) - 1) * Math.min(200, Number(limit));

    // Fetch latest version per student for the matched period
    const reports = await StudentReport.find(match)
      .populate('studentId', 'name email rollNumber')
      .populate('releasedBy', 'name role')
      .sort({ endDate: -1, version: -1, generatedAt: -1 })
      .skip(skip)
      .limit(Math.min(200, Number(limit)))
      .lean();

    // Deduplicate to keep latest version per (studentId, reportType, periodKey)
    const latestMap = new Map();
    reports.forEach(r => {
      const k = `${r.studentId?._id || r.studentId}_${r.reportType}_${r.periodKey}`;
      if (!latestMap.has(k)) latestMap.set(k, r);
    });
    const uniqueReports = Array.from(latestMap.values());

    // Compute batch analytics from the loaded reports
    const n = uniqueReports.length;
    const avg = (arr) => n > 0 ? Number((arr.reduce((a, b) => a + b, 0) / n).toFixed(1)) : 0;
    const graded = uniqueReports.filter(r => r.dataSnapshot?.grades?.evaluatedAvailable);

    const batchAnalytics = {
      totalReports: n,
      releasedCount: uniqueReports.filter(r => r.status === 'released').length,
      pendingReleaseCount: uniqueReports.filter(r => r.status !== 'released' && r.status !== 'revoked').length,
      viewedCount: uniqueReports.filter(r => Boolean(r.viewedByStudentAt)).length,
      avgAttendancePct: avg(uniqueReports.map(r => r.dataSnapshot?.attendance?.attendancePercentage || 0)),
      avgTaskCompletionPct: avg(uniqueReports.map(r => r.dataSnapshot?.tasks?.completionPercentage || 0)),
      avgGradePct: graded.length > 0
        ? Number((graded.reduce((s, r) => s + (r.dataSnapshot?.grades?.averagePercentage || 0), 0) / graded.length).toFixed(1))
        : null,
      avgWorkingHours: avg(uniqueReports.map(r => r.dataSnapshot?.workingHours?.total?.totalHours || 0)),
      avgOnsiteHours: avg(uniqueReports.map(r => r.dataSnapshot?.workingHours?.onsite?.totalHours || 0)),
      avgWfhHours: avg(uniqueReports.map(r => r.dataSnapshot?.workingHours?.wfh?.totalHours || 0)),
      avgLeetcodeSolved: avg(uniqueReports.map(r => r.dataSnapshot?.leetcode?.totalSolved || 0)),
      avgConsistencyScore: avg(uniqueReports.map(r => r.dataSnapshot?.consistency?.overallScore || 0)),
      topPerformers: [...uniqueReports]
        .sort((a, b) => (b.dataSnapshot?.consistency?.overallScore || 0) - (a.dataSnapshot?.consistency?.overallScore || 0))
        .slice(0, 5)
        .map(r => ({
          reportId: r._id,
          name: r.studentId?.name,
          rollNumber: r.studentId?.rollNumber,
          score: r.dataSnapshot?.consistency?.overallScore || 0
        })),
      studentsNeedingAttention: uniqueReports
        .filter(r =>
          (r.dataSnapshot?.attendance?.attendancePercentage || 0) < 75 ||
          (r.dataSnapshot?.tasks?.overdue || 0) > 0 ||
          r.dataSnapshot?.grades?.trendLabel === 'Declining'
        )
        .map(r => ({
          reportId: r._id,
          name: r.studentId?.name,
          rollNumber: r.studentId?.rollNumber,
          attendancePct: r.dataSnapshot?.attendance?.attendancePercentage || 0,
          overdueTasks: r.dataSnapshot?.tasks?.overdue || 0,
          gradeTrend: r.dataSnapshot?.grades?.trendLabel || 'N/A'
        }))
    };

    res.json({
      batch: auth.batch,
      reports: uniqueReports,
      batchAnalytics
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc    Update mentor feedback on a report
// @route   PUT /api/reports/:id/feedback
// @access  Private (Mentor/Admin)
const updateReportFeedback = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid report ID' });
    }

    const report = await StudentReport.findById(req.params.id);
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }

    const auth = await verifyBatchAuthorization(req.user, report.batchId);
    if (!auth.ok) {
      return res.status(auth.status).json({ message: auth.message });
    }

    const allowedFields = [
      'overallObservation',
      'strengths',
      'areasForImprovement',
      'academicFeedback',
      'codingFeedback',
      'attendanceFeedback',
      'workDisciplineFeedback',
      'nextMonthGoals',
      'recommendedPractice',
      'suggestedRoadmap'
    ];

    const updatedFeedback = { ...(report.mentorFeedback || {}) };
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updatedFeedback[field] = String(req.body[field]);
      }
    });
    updatedFeedback.editedBy = req.user._id;
    updatedFeedback.editedAt = new Date();

    report.mentorFeedback = updatedFeedback;
    if (report.status === 'generated' || report.status === 'draft') {
      report.status = 'in_review';
    } else if (report.status === 'released') {
      report.feedbackAuditLog.push({
        editedBy: req.user._id,
        editedAt: new Date(),
        version: report.version,
        summary: req.body.auditSummary || 'Post-release mentor feedback updated'
      });
    }

    await report.save();
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc    Idempotent release of individual, selected, or batch reports to students
// @route   POST /api/reports/release
// @access  Private (Mentor/Admin)
const releaseReports = async (req, res) => {
  try {
    const { reportIds, batchId, reportType, periodKey } = req.body;

    let query = {};
    if (Array.isArray(reportIds) && reportIds.length > 0) {
      query = { _id: { $in: reportIds } };
    } else if (batchId) {
      const auth = await verifyBatchAuthorization(req.user, batchId);
      if (!auth.ok) return res.status(auth.status).json({ message: auth.message });
      query = { batchId, status: { $in: ['draft', 'generated', 'in_review'] } };
      if (reportType) query.reportType = reportType;
      if (periodKey) query.periodKey = periodKey;
    } else {
      return res.status(400).json({ message: 'Provide reportIds or batchId to release reports.' });
    }

    const targets = await StudentReport.find(query);
    let releasedCount = 0;

    for (const rep of targets) {
      if (req.user.role === 'mentor') {
        const auth = await verifyBatchAuthorization(req.user, rep.batchId);
        if (!auth.ok) continue;
      }

      if (rep.status === 'revoked') continue;

      const wasAlreadyReleased = rep.status === 'released';
      rep.status = 'released';
      if (!rep.releasedAt) rep.releasedAt = new Date();
      rep.releasedBy = req.user._id;

      // Prevent duplicate release notifications
      if (!rep.notificationSent) {
        rep.notificationSent = true;
        try {
          socketHandlers.emitToUser(rep.studentId.toString(), 'report-released', {
            reportId: rep._id,
            reportType: rep.reportType,
            periodKey: rep.periodKey,
            startDate: rep.startDate,
            endDate: rep.endDate
          });
        } catch (sockErr) {}
      }

      await rep.save();
      if (!wasAlreadyReleased) releasedCount++;
    }

    res.json({
      success: true,
      releasedCount,
      totalMatched: targets.length,
      message: `${releasedCount} report(s) released to students.`
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc    Revoke a released report (Admin only)
// @route   POST /api/reports/:id/revoke
// @access  Private (Admin)
const revokeReport = async (req, res) => {
  try {
    const report = await StudentReport.findById(req.params.id);
    if (!report) return res.status(404).json({ message: 'Report not found' });

    report.status = 'revoked';
    report.revokedBy = req.user._id;
    report.revokedAt = new Date();
    report.revokeReason = req.body.reason || 'Revoked by administrator';
    await report.save();

    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc    Get report generation job progress
// @route   GET /api/reports/jobs/:jobId
// @access  Private (Mentor/Admin)
const getReportJobStatus = async (req, res) => {
  try {
    const job = await ReportJob.findById(req.params.jobId).lean();
    if (!job) return res.status(404).json({ message: 'Report job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc    Get/Update scoring weights config (Admin)
// @route   GET/PUT /api/reports/config
// @access  Private (Admin)
const getReportConfig = async (req, res) => {
  try {
    const { batchId } = req.query;
    const weights = await getEffectiveWeights(batchId || null);
    res.json({ weights, batchId: batchId || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const updateReportConfig = async (req, res) => {
  try {
    const { batchId, weights } = req.body;
    if (!weights || typeof weights !== 'object') {
      return res.status(400).json({ message: 'weights object is required' });
    }

    const scope = batchId ? 'batch' : 'global';
    const doc = await ReportConfig.findOneAndUpdate(
      { scope, batchId: batchId || null },
      {
        $set: {
          weights: {
            attendance: Number(weights.attendance ?? 20),
            taskCompletion: Number(weights.taskCompletion ?? 25),
            grades: Number(weights.grades ?? 25),
            leetcode: Number(weights.leetcode ?? 15),
            workingConsistency: Number(weights.workingConsistency ?? 15)
          },
          updatedBy: req.user._id
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    res.json({ success: true, config: doc });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// @desc    Cross-batch admin overview & mentor audit
// @route   GET /api/reports/admin/overview
// @access  Private (Admin)
const getAdminReportsOverview = async (req, res) => {
  try {
    const [batches, allReports, recentJobs] = await Promise.all([
      Batch.find({ status: 'Active' }).populate('mentorId', 'name email').lean(),
      StudentReport.find()
        .populate('batchId', 'batchName')
        .populate('releasedBy', 'name role')
        .select('batchId reportType periodKey status generatedAt releasedAt viewedByStudentAt dataSnapshot.consistency.overallScore dataSnapshot.attendance.attendancePercentage dataSnapshot.tasks.completionPercentage dataSnapshot.grades.averagePercentage')
        .sort({ generatedAt: -1 })
        .limit(1000)
        .lean(),
      ReportJob.find().sort({ createdAt: -1 }).limit(20).populate('batchId', 'batchName').populate('requestedBy', 'name').lean()
    ]);

    const batchComparison = batches.map(b => {
      const bId = String(b._id);
      const bReports = allReports.filter(r => String(r.batchId?._id || r.batchId) === bId);
      const n = bReports.length;
      const avg = (fn) => n > 0 ? Number((bReports.reduce((s, r) => s + (fn(r) || 0), 0) / n).toFixed(1)) : 0;
      return {
        batchId: b._id,
        batchName: b.batchName,
        mentorName: b.mentorId?.name || 'Unassigned',
        totalReports: n,
        releasedCount: bReports.filter(r => r.status === 'released').length,
        unreleasedCount: bReports.filter(r => r.status !== 'released' && r.status !== 'revoked').length,
        revokedCount: bReports.filter(r => r.status === 'revoked').length,
        avgConsistencyScore: avg(r => r.dataSnapshot?.consistency?.overallScore),
        avgAttendancePct: avg(r => r.dataSnapshot?.attendance?.attendancePercentage),
        avgTaskPct: avg(r => r.dataSnapshot?.tasks?.completionPercentage)
      };
    });

    res.json({
      batchComparison,
      recentJobs,
      totalReports: allReports.length,
      releasedTotal: allReports.filter(r => r.status === 'released').length,
      unreleasedTotal: allReports.filter(r => r.status !== 'released' && r.status !== 'revoked').length
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getMyReports,
  getReportById,
  generateReports,
  getBatchReports,
  updateReportFeedback,
  releaseReports,
  revokeReport,
  getReportJobStatus,
  getReportConfig,
  updateReportConfig,
  getAdminReportsOverview
};
