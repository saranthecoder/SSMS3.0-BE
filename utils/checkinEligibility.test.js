const test = require('node:test');
const assert = require('node:assert');
const {
  getISTDateStr,
  getPreviousDayISTDateStr,
  evaluateBatchEligibility,
  selectEligibleStudentIds
} = require('./checkinEligibility');

test('getPreviousDayISTDateStr computes exact previous IST calendar day even right after IST midnight', () => {
  // 2026-11-27 00:05:00 IST == 2026-11-26 18:35:00 UTC
  const justAfterMidnightIST = new Date('2026-11-26T18:35:00.000Z');
  assert.strictEqual(getISTDateStr(justAfterMidnightIST), '2026-11-27');
  assert.strictEqual(getPreviousDayISTDateStr(justAfterMidnightIST), '2026-11-26');
});

test('evaluateBatchEligibility & selectEligibleStudentIds support single and combined AND checkboxes', () => {
  const sAllAndPresent = 'stu1';
  const sAllOnly = 'stu2';
  const sPresentOnly = 'stu3';
  const sNeither = 'stu4';

  const t1 = 'task1';
  const t2 = 'task2';

  const { eligibilityByStudent, summary } = evaluateBatchEligibility({
    studentIds: [sAllAndPresent, sAllOnly, sPresentOnly, sNeither],
    prevTaskIds: [t1, t2],
    submissions: [
      { studentId: sAllAndPresent, taskId: t1, status: 'graded' },
      { studentId: sAllAndPresent, taskId: t2, status: 'submitted' },
      { studentId: sAllOnly, taskId: t1, status: 'submitted' },
      { studentId: sAllOnly, taskId: t2, status: 'graded' },
      { studentId: sPresentOnly, taskId: t1, status: 'graded' },
      { studentId: sPresentOnly, taskId: t2, status: 'resubmit' }, // resubmit does NOT count as completed
      { studentId: sNeither, taskId: t1, status: 'submitted' }
    ],
    yesterdayAttendances: [
      { studentId: sAllAndPresent, status: 'Present' },
      { studentId: sAllOnly, status: 'Invalid' }, // Invalid does NOT count as Present
      { studentId: sPresentOnly, status: 'Present' },
      { studentId: sNeither, status: 'Absent' }
    ]
  });

  assert.deepStrictEqual(summary, {
    totalPrevTasks: 2,
    completedAllPrevTasksCount: 2,
    presentYesterdayCount: 2,
    bothSatisfiedCount: 1
  });

  const allIds = [sAllAndPresent, sAllOnly, sPresentOnly, sNeither];

  // Checkbox 1 only: completed all tasks of previous classes
  assert.deepStrictEqual(
    selectEligibleStudentIds(allIds, eligibilityByStudent, { requireAllTasks: true, requirePresentYesterday: false }),
    [sAllAndPresent, sAllOnly]
  );

  // Checkbox 2 only: present yesterday
  assert.deepStrictEqual(
    selectEligibleStudentIds(allIds, eligibilityByStudent, { requireAllTasks: false, requirePresentYesterday: true }),
    [sAllAndPresent, sPresentOnly]
  );

  // Both checkboxes clicked: must satisfy BOTH conditions
  assert.deepStrictEqual(
    selectEligibleStudentIds(allIds, eligibilityByStudent, { requireAllTasks: true, requirePresentYesterday: true }),
    [sAllAndPresent]
  );

  // Neither clicked: empty selection
  assert.deepStrictEqual(
    selectEligibleStudentIds(allIds, eligibilityByStudent, { requireAllTasks: false, requirePresentYesterday: false }),
    []
  );
});
