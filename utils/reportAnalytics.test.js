const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_WEIGHTS,
  resolvePeriodDates,
  calculateAttendanceMetrics,
  calculateWorkingHoursMetrics,
  calculateTaskAndGradeMetrics,
  calculateLeetcodeMetrics,
  calculateNormalizedScore
} = require('../services/reportAnalyticsService');

test('resolvePeriodDates handles weekly, monthly, and cumulative periods accurately', () => {
  const weekly = resolvePeriodDates({
    reportType: 'weekly',
    startDate: '2026-11-16',
    endDate: '2026-11-22'
  });
  assert.equal(weekly.startDate, '2026-11-16');
  assert.equal(weekly.endDate, '2026-11-22');
  assert.ok(weekly.periodKey.includes('2026-11-16_2026-11-22'));

  const monthly = resolvePeriodDates({
    reportType: 'monthly',
    month: '2026-11'
  });
  assert.equal(monthly.startDate, '2026-11-01');
  assert.equal(monthly.endDate, '2026-11-30');
  assert.equal(monthly.periodKey, '2026-11');

  const cumulative = resolvePeriodDates({
    reportType: 'cumulative',
    joiningDate: '2026-10-01',
    endDate: '2026-11-25'
  });
  assert.equal(cumulative.startDate, '2026-10-01');
  assert.equal(cumulative.endDate, '2026-11-25');
  assert.equal(cumulative.periodKey, 'cumulative_2026-11-25');
});

test('calculateAttendanceMetrics excludes holidays and approved leaves from eligible denominator', () => {
  const scheduled = new Set(['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']);
  const attendanceRecords = [
    { dateStr: '2026-11-18', status: 'Present', onsiteDurationSeconds: 7200, wfhDurationSeconds: 10800 },
    { dateStr: '2026-11-19', status: 'Present', onsiteDurationSeconds: 7200, wfhDurationSeconds: 10800 },
    { dateStr: '2026-11-20', status: 'Absent', onsiteDurationSeconds: 0, wfhDurationSeconds: 0 },
    // Beyond endDate: must be excluded
    { dateStr: '2026-11-25', status: 'Present', onsiteDurationSeconds: 7200, wfhDurationSeconds: 10800 }
  ];
  const approvedLeaves = [
    { leaveType: 'full_day', startDate: '2026-11-21', endDate: '2026-11-21' }
  ];

  const res = calculateAttendanceMetrics({
    attendanceRecords,
    scheduledDatesSet: scheduled,
    approvedLeaves,
    effectiveStart: '2026-11-18',
    effectiveEnd: '2026-11-22'
  });

  assert.equal(res.totalScheduledDays, 4);
  assert.equal(res.leaveDays, 1);
  assert.equal(res.eligibleTrainingDays, 3);
  assert.equal(res.presentDays, 2);
  assert.equal(res.absentDays, 1);
  assert.equal(res.attendancePercentage, 66.7);
  assert.equal(res.consecutiveStreak, 2);
});

test('calculateWorkingHoursMetrics separates On-Site and WFH and excludes Invalid sessions', () => {
  const attendanceRecords = [
    { dateStr: '2026-11-20', status: 'Present', onsiteDurationSeconds: 7200, wfhDurationSeconds: 10800 }, // 2h OS, 3h WFH
    { dateStr: '2026-11-21', status: 'Present', onsiteDurationSeconds: 14400, wfhDurationSeconds: 0 }, // 4h OS
    { dateStr: '2026-11-22', status: 'Invalid', onsiteDurationSeconds: 43200, wfhDurationSeconds: 0 } // 12h Invalid
  ];

  const res = calculateWorkingHoursMetrics({
    attendanceRecords,
    effectiveStart: '2026-11-20',
    effectiveEnd: '2026-11-22'
  });

  assert.equal(res.onsite.days, 2);
  assert.equal(res.onsite.totalHours, 6);
  assert.equal(res.wfh.days, 1);
  assert.equal(res.wfh.totalHours, 3);
  assert.equal(res.total.workingDays, 2);
  assert.equal(res.total.totalHours, 9);
  assert.equal(res.invalidSessionsExcluded, 1);
});

test('calculateTaskAndGradeMetrics enforces endDate cutoff and labels missing grades as Not Evaluated', () => {
  const tasks = [
    { _id: 't1', title: 'Task 1', category: 'HW', createdAt: new Date('2026-11-10T06:00:00Z'), dueDate: new Date('2026-11-15T18:00:00Z'), maxMarks: 100 },
    { _id: 't2', title: 'Task 2', category: 'CW', createdAt: new Date('2026-11-11T06:00:00Z'), dueDate: new Date('2026-11-14T18:00:00Z'), maxMarks: 50 },
    { _id: 't3', title: 'Future Task', category: 'HW', createdAt: new Date('2026-11-28T06:00:00Z'), dueDate: new Date('2026-11-30T18:00:00Z'), maxMarks: 100 }
  ];

  const subMap = new Map([
    ['t1', { _id: 's1', taskId: 't1', status: 'submitted', submittedAt: new Date('2026-11-12T10:00:00Z'), isLate: false }]
  ]);
  const gradeMap = new Map(); // No grade yet for s1

  const res = calculateTaskAndGradeMetrics({
    tasks,
    submissionByTaskId: subMap,
    gradeBySubmissionId: gradeMap,
    effectiveStart: '2026-11-01',
    effectiveEnd: '2026-11-20'
  });

  assert.equal(res.tasks.assigned, 2); // Future Task excluded
  assert.equal(res.tasks.completed, 1);
  assert.equal(res.tasks.overdue, 1);
  assert.equal(res.tasks.completionPercentage, 50);
  assert.equal(res.tasks.details[0].grade, 'Not Evaluated');
  assert.equal(res.grades.evaluatedAvailable, false);
});

test('calculateLeetcodeMetrics deduplicates problemIds and computes longest streak', () => {
  const assignedProblems = [
    { _id: 'p1', title: 'Two Sum', createdAt: new Date('2026-11-10T05:00:00Z'), deadline: new Date('2026-11-12T18:00:00Z') },
    { _id: 'p2', title: 'Add Two Numbers', createdAt: new Date('2026-11-11T05:00:00Z'), deadline: new Date('2026-11-13T18:00:00Z') }
  ];
  const studentSubmissions = [
    { problemId: 'p1', solutionLink: 'https://lc/1', createdAt: new Date('2026-11-10T10:00:00Z') },
    { problemId: 'p1', solutionLink: 'https://lc/1b', createdAt: new Date('2026-11-10T11:00:00Z') }, // duplicate
    { problemId: 'p2', solutionLink: 'https://lc/2', createdAt: new Date('2026-11-11T10:00:00Z') }
  ];

  const res = calculateLeetcodeMetrics({
    assignedProblems,
    studentSubmissions,
    effectiveStart: '2026-11-01',
    effectiveEnd: '2026-11-20'
  });

  assert.equal(res.totalAssigned, 2);
  assert.equal(res.totalSolved, 2);
  assert.equal(res.longestStreak, 2);
  assert.equal(res.difficultyBreakdown.available, false);
});

test('calculateNormalizedScore excludes unavailable modules and re-normalizes weights', () => {
  const score = calculateNormalizedScore({
    attendancePct: 100,
    hasAttendanceData: true,
    taskCompletionPct: 80,
    hasTaskData: true,
    gradePct: 0,
    hasGradeData: false, // Missing grades must NOT penalize student
    leetcodeSolved: 0,
    leetcodeAssigned: 0,
    hasLeetcodeData: false,
    workingConsistencyPct: 100,
    hasWorkingData: true,
    weights: DEFAULT_WEIGHTS
  });

  // Active weights: attendance (20) + taskCompletion (25) + workingConsistency (15) = 60
  assert.equal(score.activeWeightSum, 60);
  // Expected: (100*20 + 80*25 + 100*15) / 60 = 5500 / 60 = 91.7
  assert.equal(score.overallScore, 91.7);
});

test('150-student batch calculation throughput benchmark completes under 150ms', () => {
  const t0 = Date.now();
  const scheduled = new Set(['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    _id: `t_${i}`,
    title: `Task ${i}`,
    category: 'HW',
    createdAt: new Date('2026-11-18T05:00:00Z'),
    dueDate: new Date('2026-11-22T18:00:00Z'),
    maxMarks: 100
  }));

  for (let s = 0; s < 150; s++) {
    const att = [
      { dateStr: '2026-11-18', status: 'Present', onsiteDurationSeconds: 7200, wfhDurationSeconds: 10800 },
      { dateStr: '2026-11-19', status: 'Present', onsiteDurationSeconds: 7200, wfhDurationSeconds: 10800 }
    ];
    calculateAttendanceMetrics({ attendanceRecords: att, scheduledDatesSet: scheduled, effectiveStart: '2026-11-18', effectiveEnd: '2026-11-22' });
    calculateWorkingHoursMetrics({ attendanceRecords: att, effectiveStart: '2026-11-18', effectiveEnd: '2026-11-22' });
    calculateTaskAndGradeMetrics({ tasks, submissionByTaskId: new Map(), gradeBySubmissionId: new Map(), effectiveStart: '2026-11-18', effectiveEnd: '2026-11-22' });
  }

  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 150, `Expected 150-student batch calculation < 150ms, took ${elapsed}ms`);
});
