const getISTDateStr = (date = new Date()) => {
  const istTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const year = istTime.getFullYear();
  const month = String(istTime.getMonth() + 1).padStart(2, '0');
  const day = String(istTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getPreviousDayISTDateStr = (date = new Date()) => {
  const todayStr = getISTDateStr(date);
  const todayMidnightIST = new Date(`${todayStr}T00:00:00+05:30`);
  const prevMs = todayMidnightIST.getTime() - 12 * 60 * 60 * 1000;
  return getISTDateStr(new Date(prevMs));
};

const getISTDayStartUTC = (date = new Date()) => {
  const todayStr = getISTDateStr(date);
  return new Date(`${todayStr}T00:00:00+05:30`);
};

/**
 * Computes per-student check-in eligibility for:
 * 1) Completing all tasks from all previous classes (tasks released before today IST)
 * 2) Being Present yesterday (IST previous day Attendance status === 'Present')
 */
const evaluateBatchEligibility = ({
  studentIds = [],
  prevTaskIds = [],
  submissions = [],
  yesterdayAttendances = []
}) => {
  const normalizedPrevTaskIds = new Set(prevTaskIds.map(id => id.toString()));
  const totalPrevTasks = normalizedPrevTaskIds.size;

  const completedTasksByStudent = new Map();
  submissions.forEach(sub => {
    if (!sub || !sub.studentId || !sub.taskId) return;
    if (sub.status && !['submitted', 'graded'].includes(sub.status)) return;
    const tId = (sub.taskId._id || sub.taskId).toString();
    if (!normalizedPrevTaskIds.has(tId)) return;
    const sId = (sub.studentId._id || sub.studentId).toString();
    if (!completedTasksByStudent.has(sId)) {
      completedTasksByStudent.set(sId, new Set());
    }
    completedTasksByStudent.get(sId).add(tId);
  });

  const yesterdayByStudent = new Map();
  yesterdayAttendances.forEach(att => {
    if (!att || !att.studentId) return;
    const sId = (att.studentId._id || att.studentId).toString();
    yesterdayByStudent.set(sId, att.status || 'No Record');
  });

  const eligibilityByStudent = {};
  let completedAllPrevTasksCount = 0;
  let presentYesterdayCount = 0;
  let bothSatisfiedCount = 0;

  studentIds.forEach(rawId => {
    const sId = rawId.toString();
    const completedPrevTasksCount = completedTasksByStudent.get(sId)?.size || 0;
    const completedAllPrevTasks = totalPrevTasks === 0 ? true : completedPrevTasksCount >= totalPrevTasks;
    const yesterdayStatus = yesterdayByStudent.get(sId) || 'No Record';
    const presentYesterday = yesterdayStatus === 'Present';

    if (completedAllPrevTasks) completedAllPrevTasksCount += 1;
    if (presentYesterday) presentYesterdayCount += 1;
    if (completedAllPrevTasks && presentYesterday) bothSatisfiedCount += 1;

    eligibilityByStudent[sId] = {
      completedPrevTasksCount,
      totalPrevTasks,
      completedAllPrevTasks,
      presentYesterday,
      yesterdayStatus
    };
  });

  return {
    eligibilityByStudent,
    summary: {
      totalPrevTasks,
      completedAllPrevTasksCount,
      presentYesterdayCount,
      bothSatisfiedCount
    }
  };
};

/**
 * Selects student IDs matching active eligibility checkbox criteria.
 * When both checkboxes are checked, requires BOTH conditions to be satisfied.
 */
const selectEligibleStudentIds = (
  studentIds = [],
  eligibilityByStudent = {},
  { requireAllTasks = false, requirePresentYesterday = false } = {}
) => {
  if (!requireAllTasks && !requirePresentYesterday) return [];
  return studentIds
    .map(id => id.toString())
    .filter(sId => {
      const info = eligibilityByStudent[sId];
      if (!info) return false;
      if (requireAllTasks && !info.completedAllPrevTasks) return false;
      if (requirePresentYesterday && !info.presentYesterday) return false;
      return true;
    });
};

module.exports = {
  getISTDateStr,
  getPreviousDayISTDateStr,
  getISTDayStartUTC,
  evaluateBatchEligibility,
  selectEligibleStudentIds
};
