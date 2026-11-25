const mongoose = require('mongoose');

const DEFAULT_WEIGHTS = {
  attendance: 20,
  taskCompletion: 25,
  grades: 25,
  leetcode: 15,
  workingConsistency: 15
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const toISTDateStr = (date = new Date()) => {
  const ist = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const day = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const endOfDayDate = (dateStr) => new Date(`${dateStr}T23:59:59.999+05:30`);
const startOfDayDate = (dateStr) => new Date(`${dateStr}T00:00:00.000+05:30`);

/**
 * Resolves startDate, endDate, and periodKey for weekly, monthly, or cumulative reports.
 */
const resolvePeriodDates = ({ reportType, startDate, endDate, month, weekStart, joiningDate }) => {
  const todayStr = toISTDateStr();

  if (reportType === 'weekly') {
    let sStr = startDate || weekStart;
    if (!sStr) {
      // Default: current week Monday -> Sunday (capped at today or Sunday)
      const now = new Date(`${todayStr}T12:00:00+05:30`);
      const day = now.getDay(); // 0=Sun, 1=Mon
      const diffToMon = day === 0 ? -6 : 1 - day;
      const mon = new Date(now);
      mon.setDate(now.getDate() + diffToMon);
      sStr = toISTDateStr(mon);
    }
    let eStr = endDate;
    if (!eStr) {
      const sDate = new Date(`${sStr}T12:00:00+05:30`);
      const sun = new Date(sDate);
      sun.setDate(sDate.getDate() + 6);
      eStr = toISTDateStr(sun);
    }
    // ISO week key
    const d = new Date(`${sStr}T12:00:00+05:30`);
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil((((d - jan1) / 86400000) + jan1.getDay() + 1) / 7);
    const periodKey = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}_${sStr}_${eStr}`;
    return { startDate: sStr, endDate: eStr, periodKey };
  }

  if (reportType === 'monthly') {
    const targetMonth = month || todayStr.slice(0, 7); // YYYY-MM
    const [yr, mo] = targetMonth.split('-').map(Number);
    const sStr = startDate || `${yr}-${String(mo).padStart(2, '0')}-01`;
    const lastDay = new Date(yr, mo, 0).getDate();
    const eStr = endDate || `${yr}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { startDate: sStr, endDate: eStr, periodKey: targetMonth };
  }

  // cumulative
  const sStr = startDate || joiningDate || todayStr;
  const eStr = endDate || todayStr;
  return {
    startDate: sStr,
    endDate: eStr,
    periodKey: `cumulative_${eStr}`
  };
};

/**
 * Computes attendance metrics excluding non-scheduled days/holidays.
 */
const calculateAttendanceMetrics = ({
  attendanceRecords = [],
  scheduledDatesSet = new Set(),
  approvedLeaves = [],
  effectiveStart,
  effectiveEnd
}) => {
  const validLogs = attendanceRecords.filter(
    a => a.dateStr && a.dateStr >= effectiveStart && a.dateStr <= effectiveEnd
  );
  const logByDate = new Map();
  validLogs.forEach(l => logByDate.set(l.dateStr, l));

  // Eligible dates: union of scheduled workload dates and dates with actual attendance logs
  const eligibleDatesSet = new Set();
  scheduledDatesSet.forEach(d => {
    if (d >= effectiveStart && d <= effectiveEnd) eligibleDatesSet.add(d);
  });
  validLogs.forEach(l => eligibleDatesSet.add(l.dateStr));

  // Map approved full-day/multi-day leaves within period
  const leaveDatesSet = new Set();
  approvedLeaves.forEach(lv => {
    if (lv.leaveType === 'hours') return;
    const s = lv.startDate;
    const e = lv.endDate || lv.startDate;
    eligibleDatesSet.forEach(d => {
      if (d >= s && d <= e) leaveDatesSet.add(d);
    });
  });

  const sortedEligibleDates = Array.from(eligibleDatesSet).sort();
  let presentDays = 0;
  let absentDays = 0;
  let leaveDays = 0;
  let invalidDays = 0;
  let inProgressDays = 0;
  let lateCheckIns = 0;

  let currentStreak = 0;
  let longestStreak = 0;
  const calendar = [];
  const weeklyMap = new Map();
  const monthlyMap = new Map();

  sortedEligibleDates.forEach(d => {
    const log = logByDate.get(d);
    let dayStatus = 'Absent';

    if (log) {
      dayStatus = log.status || 'Absent';
      if (log.checkInTime) {
        // Check if check-in was after 10:30 AM IST
        const ist = new Date(new Date(log.checkInTime).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        if (ist.getHours() > 10 || (ist.getHours() === 10 && ist.getMinutes() > 30)) {
          lateCheckIns++;
        }
      }
    } else if (leaveDatesSet.has(d)) {
      dayStatus = 'Leave';
    }

    if (dayStatus === 'Present') {
      presentDays++;
      currentStreak++;
      if (currentStreak > longestStreak) longestStreak = currentStreak;
    } else if (dayStatus === 'Leave') {
      leaveDays++;
    } else if (dayStatus === 'Invalid') {
      invalidDays++;
      currentStreak = 0;
    } else if (dayStatus === 'In Progress') {
      inProgressDays++;
    } else {
      absentDays++;
      currentStreak = 0;
    }

    calendar.push({
      date: d,
      status: dayStatus,
      onsiteHours: Number(((log?.onsiteDurationSeconds || 0) / 3600).toFixed(2)),
      wfhHours: Number(((log?.wfhDurationSeconds || 0) / 3600).toFixed(2))
    });

    // Weekly grouping
    const dt = new Date(`${d}T12:00:00+05:30`);
    const dayOfWeek = dt.getDay();
    const diffMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const mon = new Date(dt);
    mon.setDate(dt.getDate() + diffMon);
    const weekKey = toISTDateStr(mon);
    if (!weeklyMap.has(weekKey)) weeklyMap.set(weekKey, { weekStart: weekKey, present: 0, total: 0 });
    const wObj = weeklyMap.get(weekKey);
    wObj.total++;
    if (dayStatus === 'Present') wObj.present++;

    // Monthly grouping
    const monthKey = d.slice(0, 7);
    if (!monthlyMap.has(monthKey)) monthlyMap.set(monthKey, { month: monthKey, present: 0, total: 0 });
    const mObj = monthlyMap.get(monthKey);
    mObj.total++;
    if (dayStatus === 'Present') mObj.present++;
  });

  // Eligible training days exclude approved full-day leaves from denominator if >0 non-leave days
  const nonLeaveDays = sortedEligibleDates.length - leaveDays;
  const eligibleTrainingDays = nonLeaveDays > 0 ? nonLeaveDays : sortedEligibleDates.length;
  const attendancePercentage = eligibleTrainingDays > 0
    ? Number(((presentDays / eligibleTrainingDays) * 100).toFixed(1))
    : 0;

  return {
    totalScheduledDays: sortedEligibleDates.length,
    eligibleTrainingDays,
    presentDays,
    absentDays,
    leaveDays,
    invalidDays,
    inProgressDays,
    lateCheckIns,
    attendancePercentage,
    consecutiveStreak: longestStreak,
    currentStreak,
    weeklyTrend: Array.from(weeklyMap.values()).map(w => ({
      ...w,
      percentage: w.total > 0 ? Number(((w.present / w.total) * 100).toFixed(1)) : 0
    })),
    monthlyTrend: Array.from(monthlyMap.values()).map(m => ({
      ...m,
      percentage: m.total > 0 ? Number(((m.present / m.total) * 100).toFixed(1)) : 0
    })),
    calendar
  };
};

/**
 * Computes On-Site, WFH, and Combined Working Hours from valid work sessions.
 * Excludes Invalid (>maxValidHours) sessions from productive totals and flags them separately.
 */
const calculateWorkingHoursMetrics = ({ attendanceRecords = [], effectiveStart, effectiveEnd }) => {
  const logs = attendanceRecords.filter(
    a => a.dateStr && a.dateStr >= effectiveStart && a.dateStr <= effectiveEnd
  );

  let onsiteSeconds = 0;
  let wfhSeconds = 0;
  let onsiteDays = 0;
  let wfhDays = 0;
  let combinedWorkingDays = 0;
  let invalidSessionsCount = 0;

  const dailyTrend = [];
  const weeklyMap = new Map();
  const monthlyMap = new Map();

  logs.sort((a, b) => a.dateStr.localeCompare(b.dateStr)).forEach(log => {
    if (log.status === 'Invalid') {
      invalidSessionsCount++;
      return; // Do not count invalid/suspicious sessions in productive working hours
    }

    let os = log.onsiteDurationSeconds || 0;
    let wfh = log.wfhDurationSeconds || 0;
    const total = log.sessionDurationSeconds || (os + wfh);

    if (os === 0 && wfh === 0 && total > 0) {
      if (log.accessType === 'wfh') wfh = total;
      else os = total;
    }

    if (os > 0) onsiteDays++;
    if (wfh > 0) wfhDays++;
    if (os > 0 || wfh > 0) combinedWorkingDays++;

    onsiteSeconds += os;
    wfhSeconds += wfh;

    const osH = Number((os / 3600).toFixed(2));
    const wfhH = Number((wfh / 3600).toFixed(2));
    const totH = Number(((os + wfh) / 3600).toFixed(2));

    dailyTrend.push({
      date: log.dateStr,
      onsiteHours: osH,
      wfhHours: wfhH,
      totalHours: totH
    });

    const dt = new Date(`${log.dateStr}T12:00:00+05:30`);
    const dayOfWeek = dt.getDay();
    const diffMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const mon = new Date(dt);
    mon.setDate(dt.getDate() + diffMon);
    const weekKey = toISTDateStr(mon);
    if (!weeklyMap.has(weekKey)) weeklyMap.set(weekKey, { weekStart: weekKey, onsiteHours: 0, wfhHours: 0, totalHours: 0 });
    const wObj = weeklyMap.get(weekKey);
    wObj.onsiteHours = Number((wObj.onsiteHours + osH).toFixed(2));
    wObj.wfhHours = Number((wObj.wfhHours + wfhH).toFixed(2));
    wObj.totalHours = Number((wObj.totalHours + totH).toFixed(2));

    const monthKey = log.dateStr.slice(0, 7);
    if (!monthlyMap.has(monthKey)) monthlyMap.set(monthKey, { month: monthKey, onsiteHours: 0, wfhHours: 0, totalHours: 0 });
    const mObj = monthlyMap.get(monthKey);
    mObj.onsiteHours = Number((mObj.onsiteHours + osH).toFixed(2));
    mObj.wfhHours = Number((mObj.wfhHours + wfhH).toFixed(2));
    mObj.totalHours = Number((mObj.totalHours + totH).toFixed(2));
  });

  const totalOnsiteHours = Number((onsiteSeconds / 3600).toFixed(2));
  const totalWfhHours = Number((wfhSeconds / 3600).toFixed(2));
  const totalWorkingHours = Number((totalOnsiteHours + totalWfhHours).toFixed(2));

  // Consistency: percentage of working days meeting >= 4h combined
  const consistentDays = dailyTrend.filter(d => d.totalHours >= 4).length;
  const workingConsistencyPct = combinedWorkingDays > 0
    ? Number(((consistentDays / combinedWorkingDays) * 100).toFixed(1))
    : 0;

  return {
    onsite: {
      days: onsiteDays,
      totalHours: totalOnsiteHours,
      avgHoursPerDay: onsiteDays > 0 ? Number((totalOnsiteHours / onsiteDays).toFixed(2)) : 0
    },
    wfh: {
      days: wfhDays,
      totalHours: totalWfhHours,
      avgHoursPerDay: wfhDays > 0 ? Number((totalWfhHours / wfhDays).toFixed(2)) : 0
    },
    total: {
      workingDays: combinedWorkingDays,
      totalHours: totalWorkingHours,
      avgDailyHours: combinedWorkingDays > 0 ? Number((totalWorkingHours / combinedWorkingDays).toFixed(2)) : 0
    },
    invalidSessionsExcluded: invalidSessionsCount,
    workingConsistencyPct,
    dailyTrend,
    weeklyTrend: Array.from(weeklyMap.values()),
    monthlyTrend: Array.from(monthlyMap.values())
  };
};

/**
 * Computes Task & Grade metrics for tasks assigned in [effectiveStart, effectiveEnd].
 */
const calculateTaskAndGradeMetrics = ({
  tasks = [],
  submissionByTaskId = new Map(),
  gradeBySubmissionId = new Map(),
  effectiveStart,
  effectiveEnd
}) => {
  const startDt = startOfDayDate(effectiveStart);
  const endDt = endOfDayDate(effectiveEnd);

  const periodTasks = tasks.filter(t => {
    const assignDate = new Date(t.scheduledAt || t.createdAt);
    return assignDate >= startDt && assignDate <= endDt;
  });

  let completed = 0;
  let pending = 0;
  let overdue = 0;
  let onTime = 0;
  let late = 0;
  let totalCompletionMs = 0;
  let completionTimeCount = 0;

  const categoryStats = {};
  const taskDetails = [];
  const gradeEntries = [];

  periodTasks.forEach(t => {
    const tId = String(t._id);
    const assignDate = new Date(t.scheduledAt || t.createdAt);
    const dueDate = new Date(t.dueDate);
    const sub = submissionByTaskId.get(tId);
    const subSubmittedAt = sub?.submittedAt ? new Date(sub.submittedAt) : null;
    const isSubmittedBeforeEnd = sub && subSubmittedAt && subSubmittedAt <= endDt;

    const cat = t.category || 'General';
    if (!categoryStats[cat]) {
      categoryStats[cat] = { category: cat, assigned: 0, completed: 0, graded: 0, totalPct: 0 };
    }
    categoryStats[cat].assigned++;

    let completionStatus = 'Pending';
    let onTimeStatus = 'Pending';
    let gradeDisplay = 'Not Evaluated';
    let gradeFeedback = '';
    let gradePct = null;

    if (isSubmittedBeforeEnd) {
      completed++;
      categoryStats[cat].completed++;
      const wasLate = Boolean(sub.isLate) || (subSubmittedAt > dueDate);
      if (wasLate) {
        late++;
        onTimeStatus = 'Late';
      } else {
        onTime++;
        onTimeStatus = 'On Time';
      }
      completionStatus = sub.status === 'graded' ? 'Graded' : 'Submitted';

      const compMs = Math.max(0, subSubmittedAt.getTime() - assignDate.getTime());
      totalCompletionMs += compMs;
      completionTimeCount++;

      const grade = gradeBySubmissionId.get(String(sub._id));
      const reviewedBeforeEnd = grade && (!grade.reviewedAt || new Date(grade.reviewedAt) <= endDt);
      if (reviewedBeforeEnd) {
        const maxM = t.maxMarks || 100;
        const pct = maxM > 0 ? Number(((grade.marksObtained / maxM) * 100).toFixed(1)) : 0;
        gradeDisplay = `${grade.marksObtained}/${maxM} (${pct}%)`;
        gradeFeedback = grade.feedback || '';
        gradePct = pct;

        categoryStats[cat].graded++;
        categoryStats[cat].totalPct += pct;

        gradeEntries.push({
          taskId: tId,
          taskTitle: t.title,
          category: cat,
          marksObtained: grade.marksObtained,
          maxMarks: maxM,
          percentage: pct,
          reviewedAt: grade.reviewedAt || grade.createdAt,
          feedback: gradeFeedback
        });
      }
    } else {
      if (dueDate < endDt) {
        overdue++;
        completionStatus = 'Overdue';
        onTimeStatus = 'Overdue';
      } else {
        pending++;
      }
    }

    taskDetails.push({
      taskId: tId,
      title: t.title,
      category: cat,
      assignedDate: toISTDateStr(assignDate),
      deadline: toISTDateStr(dueDate),
      submissionDate: isSubmittedBeforeEnd ? toISTDateStr(subSubmittedAt) : null,
      completionStatus,
      grade: gradeDisplay,
      gradePct,
      feedback: gradeFeedback,
      onTimeStatus
    });
  });

  const assigned = periodTasks.length;
  const completionPercentage = assigned > 0 ? Number(((completed / assigned) * 100).toFixed(1)) : 0;
  const avgCompletionHours = completionTimeCount > 0
    ? Number(((totalCompletionMs / completionTimeCount) / 3600000).toFixed(1))
    : 0;

  // Grade analysis
  gradeEntries.sort((a, b) => new Date(a.reviewedAt) - new Date(b.reviewedAt));
  const totalAssessments = gradeEntries.length;
  const avgGradePct = totalAssessments > 0
    ? Number((gradeEntries.reduce((s, g) => s + g.percentage, 0) / totalAssessments).toFixed(1))
    : null;
  const avgScore = totalAssessments > 0
    ? Number((gradeEntries.reduce((s, g) => s + g.marksObtained, 0) / totalAssessments).toFixed(1))
    : null;
  const highestScore = totalAssessments > 0 ? Math.max(...gradeEntries.map(g => g.percentage)) : null;
  const lowestScore = totalAssessments > 0 ? Math.min(...gradeEntries.map(g => g.percentage)) : null;

  const gradeDistribution = {
    '90-100%': gradeEntries.filter(g => g.percentage >= 90).length,
    '75-89%': gradeEntries.filter(g => g.percentage >= 75 && g.percentage < 90).length,
    '50-74%': gradeEntries.filter(g => g.percentage >= 50 && g.percentage < 75).length,
    '<50%': gradeEntries.filter(g => g.percentage < 50).length
  };

  let gradeTrendLabel = 'Insufficient Data';
  if (totalAssessments >= 2) {
    const firstHalf = gradeEntries.slice(0, Math.floor(totalAssessments / 2));
    const secondHalf = gradeEntries.slice(Math.floor(totalAssessments / 2));
    const avg1 = firstHalf.reduce((s, g) => s + g.percentage, 0) / firstHalf.length;
    const avg2 = secondHalf.reduce((s, g) => s + g.percentage, 0) / secondHalf.length;
    if (avg2 - avg1 >= 5) gradeTrendLabel = 'Improving';
    else if (avg1 - avg2 >= 5) gradeTrendLabel = 'Declining';
    else gradeTrendLabel = 'Consistent';
  } else if (totalAssessments === 1) {
    gradeTrendLabel = 'Single Assessment';
  }

  const categoryPerformance = Object.values(categoryStats).map(c => ({
    category: c.category,
    assigned: c.assigned,
    completed: c.completed,
    completionPct: c.assigned > 0 ? Number(((c.completed / c.assigned) * 100).toFixed(1)) : 0,
    avgGradePct: c.graded > 0 ? Number((c.totalPct / c.graded).toFixed(1)) : null
  }));

  return {
    tasks: {
      assigned,
      completed,
      pending,
      overdue,
      onTime,
      late,
      completionPercentage,
      avgCompletionHours,
      categoryPerformance,
      details: taskDetails
    },
    grades: {
      totalAssessments,
      averageScore: avgScore,
      averagePercentage: avgGradePct,
      highestPercentage: highestScore,
      lowestPercentage: lowestScore,
      distribution: gradeDistribution,
      trendLabel: gradeTrendLabel,
      trendSeries: gradeEntries.map(g => ({
        title: g.taskTitle,
        date: toISTDateStr(g.reviewedAt),
        percentage: g.percentage,
        marksObtained: g.marksObtained,
        maxMarks: g.maxMarks
      })),
      evaluatedAvailable: totalAssessments > 0
    }
  };
};

/**
 * Computes LeetCode metrics (unique solved problems, streaks, activity charts).
 */
const calculateLeetcodeMetrics = ({
  assignedProblems = [],
  studentSubmissions = [],
  effectiveStart,
  effectiveEnd
}) => {
  const startDt = startOfDayDate(effectiveStart);
  const endDt = endOfDayDate(effectiveEnd);

  const problemMap = new Map();
  const periodProblems = assignedProblems.filter(p => {
    problemMap.set(String(p._id), p);
    const dt = new Date(p.scheduledAt || p.createdAt);
    return dt >= startDt && dt <= endDt;
  });

  // Deduplicate by problemId within [startDt, endDt]
  const uniqueSolvedMap = new Map();
  studentSubmissions.forEach(sub => {
    const solvedAt = new Date(sub.createdAt);
    if (solvedAt >= startDt && solvedAt <= endDt) {
      const pId = String(sub.problemId);
      if (!uniqueSolvedMap.has(pId)) {
        uniqueSolvedMap.set(pId, sub);
      }
    }
  });

  const dailyMap = new Map();
  const weeklyMap = new Map();
  const monthlyMap = new Map();
  const recentSolved = [];
  let onTimeSolved = 0;
  let lateSolved = 0;

  uniqueSolvedMap.forEach((sub, pId) => {
    const prob = problemMap.get(pId);
    const solvedAt = new Date(sub.createdAt);
    const dStr = toISTDateStr(solvedAt);

    if (prob && prob.deadline) {
      if (solvedAt <= new Date(prob.deadline)) onTimeSolved++;
      else lateSolved++;
    }

    dailyMap.set(dStr, (dailyMap.get(dStr) || 0) + 1);

    const dt = new Date(`${dStr}T12:00:00+05:30`);
    const dow = dt.getDay();
    const mon = new Date(dt);
    mon.setDate(dt.getDate() + (dow === 0 ? -6 : 1 - dow));
    const wKey = toISTDateStr(mon);
    weeklyMap.set(wKey, (weeklyMap.get(wKey) || 0) + 1);

    const mKey = dStr.slice(0, 7);
    monthlyMap.set(mKey, (monthlyMap.get(mKey) || 0) + 1);

    recentSolved.push({
      problemId: pId,
      title: prob?.title || 'LeetCode Problem',
      problemLink: prob?.problemLink || '',
      solutionLink: sub.solutionLink,
      solvedAt: dStr
    });
  });

  // Longest solving streak across active days
  const activeDays = Array.from(dailyMap.keys()).sort();
  let longestStreak = 0;
  let currStreak = 0;
  let prevDay = null;

  activeDays.forEach(dStr => {
    const curr = new Date(`${dStr}T12:00:00+05:30`);
    if (prevDay && Math.round((curr - prevDay) / 86400000) === 1) {
      currStreak++;
    } else {
      currStreak = 1;
    }
    if (currStreak > longestStreak) longestStreak = currStreak;
    prevDay = curr;
  });

  recentSolved.sort((a, b) => b.solvedAt.localeCompare(a.solvedAt));

  return {
    totalAssigned: periodProblems.length,
    totalSolved: uniqueSolvedMap.size,
    onTimeSolved,
    lateSolved,
    activeProblemSolvingDays: activeDays.length,
    longestStreak,
    dailyActivity: activeDays.map(d => ({ date: d, count: dailyMap.get(d) })),
    weeklyActivity: Array.from(weeklyMap.entries()).sort().map(([weekStart, count]) => ({ weekStart, count })),
    monthlyActivity: Array.from(monthlyMap.entries()).sort().map(([month, count]) => ({ month, count })),
    recentSolvedProblems: recentSolved.slice(0, 20),
    difficultyBreakdown: {
      available: false,
      note: 'Difficulty and topic tags are not stored in the current LeetCode schema.'
    }
  };
};

/**
 * Transparent normalized consistency score: excludes modules with no data and re-normalizes remaining weights.
 */
const calculateNormalizedScore = ({
  attendancePct,
  hasAttendanceData,
  taskCompletionPct,
  hasTaskData,
  gradePct,
  hasGradeData,
  leetcodeSolved,
  leetcodeAssigned,
  hasLeetcodeData,
  workingConsistencyPct,
  hasWorkingData,
  weights = DEFAULT_WEIGHTS
}) => {
  const components = [
    {
      key: 'attendance',
      label: 'Attendance',
      weight: weights.attendance ?? 20,
      available: hasAttendanceData,
      score: hasAttendanceData ? Math.min(100, attendancePct) : 0
    },
    {
      key: 'taskCompletion',
      label: 'Task Completion',
      weight: weights.taskCompletion ?? 25,
      available: hasTaskData,
      score: hasTaskData ? Math.min(100, taskCompletionPct) : 0
    },
    {
      key: 'grades',
      label: 'Assessments & Grades',
      weight: weights.grades ?? 25,
      available: hasGradeData,
      score: hasGradeData ? Math.min(100, gradePct) : 0
    },
    {
      key: 'leetcode',
      label: 'LeetCode Activity',
      weight: weights.leetcode ?? 15,
      available: hasLeetcodeData,
      score: hasLeetcodeData
        ? Math.min(100, leetcodeAssigned > 0 ? (leetcodeSolved / leetcodeAssigned) * 100 : (leetcodeSolved > 0 ? 100 : 0))
        : 0
    },
    {
      key: 'workingConsistency',
      label: 'Working Consistency',
      weight: weights.workingConsistency ?? 15,
      available: hasWorkingData,
      score: hasWorkingData ? Math.min(100, workingConsistencyPct) : 0
    }
  ];

  const activeWeightSum = components.filter(c => c.available).reduce((s, c) => s + c.weight, 0);

  let rawWeightedSum = 0;
  const breakdown = components.map(c => {
    const normalizedWeight = (c.available && activeWeightSum > 0)
      ? Number(((c.weight / activeWeightSum) * 100).toFixed(1))
      : 0;
    const weightedContribution = (c.available && activeWeightSum > 0)
      ? Number(((c.score * c.weight) / activeWeightSum).toFixed(1))
      : 0;
    if (c.available && activeWeightSum > 0) {
      rawWeightedSum += (c.score * c.weight) / activeWeightSum;
    }
    return {
      ...c,
      normalizedWeight,
      weightedContribution
    };
  });

  return {
    overallScore: Number(rawWeightedSum.toFixed(1)),
    activeWeightSum,
    breakdown
  };
};

/**
 * Derives neutral, data-driven strengths & improvement areas from real metrics.
 */
const deriveInsights = ({ attendance, tasks, grades, workingHours, leetcode }) => {
  const strengths = [];
  const improvementAreas = [];

  if (attendance.eligibleTrainingDays > 0) {
    if (attendance.attendancePercentage >= 85) {
      strengths.push(`Strong attendance consistency (${attendance.attendancePercentage}% across ${attendance.eligibleTrainingDays} eligible days).`);
    } else if (attendance.attendancePercentage < 75) {
      improvementAreas.push(`Attendance is below 75% (${attendance.attendancePercentage}%). Increasing regular check-ins is recommended.`);
    }
  }

  if (tasks.assigned > 0) {
    if (tasks.completionPercentage >= 85) {
      strengths.push(`High task completion rate (${tasks.completed}/${tasks.assigned} tasks completed, ${tasks.completionPercentage}%).`);
    } else if (tasks.completionPercentage < 70) {
      improvementAreas.push(`Task completion is at ${tasks.completionPercentage}% with ${tasks.pending + tasks.overdue} pending/overdue tasks.`);
    }
    if (tasks.overdue > 0) {
      improvementAreas.push(`${tasks.overdue} assigned task(s) are past their deadline.`);
    }
  }

  if (grades.evaluatedAvailable) {
    if (grades.averagePercentage >= 80) {
      strengths.push(`Strong assessment performance averaging ${grades.averagePercentage}% across ${grades.totalAssessments} graded assessment(s).`);
    } else if (grades.averagePercentage < 60) {
      improvementAreas.push(`Assessment average is ${grades.averagePercentage}%; targeted revision on graded topics is recommended.`);
    }
    if (grades.trendLabel === 'Improving') {
      strengths.push('Upward assessment score trend observed across recent evaluations.');
    } else if (grades.trendLabel === 'Declining') {
      improvementAreas.push('Recent assessment scores show a downward trend compared to earlier evaluations.');
    }
  }

  if (workingHours.total.workingDays > 0) {
    if (workingHours.total.avgDailyHours >= 4) {
      strengths.push(`Consistent daily working hours averaging ${workingHours.total.avgDailyHours}h/day (${workingHours.onsite.totalHours}h On-Site, ${workingHours.wfh.totalHours}h WFH).`);
    } else {
      improvementAreas.push(`Daily working average is ${workingHours.total.avgDailyHours}h/day; aim for consistent >= 4h daily sessions.`);
    }
  }

  if (leetcode.totalAssigned > 0) {
    const lcPct = Math.round((leetcode.totalSolved / leetcode.totalAssigned) * 100);
    if (lcPct >= 80) {
      strengths.push(`Active LeetCode problem solving (${leetcode.totalSolved}/${leetcode.totalAssigned} assigned problems solved).`);
    } else if (lcPct < 50) {
      improvementAreas.push(`LeetCode completion is ${leetcode.totalSolved}/${leetcode.totalAssigned}; regular coding practice is recommended.`);
    }
  }

  return { strengths, improvementAreas };
};

/**
 * Bulk-loads all data for a batch and computes snapshots for all (or filtered) students with zero N+1 queries.
 */
const computeBatchPerformanceReports = async ({
  batchId,
  reportType,
  startDate,
  endDate,
  weights = DEFAULT_WEIGHTS,
  studentIdsFilter = null
}) => {
  require('../models/User');
  const Batch = require('../models/Batch');
  const Enrollment = require('../models/Enrollment');
  const DailyWorkload = require('../models/DailyWorkload');
  const Attendance = require('../models/Attendance');
  const Leave = require('../models/Leave');
  const Task = require('../models/Task');
  const Submission = require('../models/Submission');
  const Grade = require('../models/Grade');
  const Leetcode = require('../models/Leetcode');
  const LeetcodeSubmission = require('../models/LeetcodeSubmission');
  const GamificationEvent = require('../models/GamificationEvent');

  const batch = await Batch.findById(batchId).populate('mentorId', 'name email').lean();
  if (!batch) {
    throw new Error('Batch not found');
  }

  const enrollmentQuery = { batchId, status: 'approved' };
  if (Array.isArray(studentIdsFilter) && studentIdsFilter.length > 0) {
    enrollmentQuery.studentId = { $in: studentIdsFilter };
  }

  const enrollments = await Enrollment.find(enrollmentQuery)
    .populate('studentId', 'name email rollNumber coins points profileImage')
    .lean();

  const validEnrollments = enrollments.filter(e => e.studentId);
  const studentIds = validEnrollments.map(e => e.studentId._id);

  if (studentIds.length === 0) {
    return { batch, studentReports: [], batchSummary: { totalStudents: 0 } };
  }

  const endDt = endOfDayDate(endDate);
  const startDt = startOfDayDate(startDate);

  // Parallel bulk queries — zero N+1 queries
  const [
    workloads,
    attendances,
    leaves,
    tasks,
    submissions,
    leetcodes,
    leetcodeSubs,
    gamificationEvents
  ] = await Promise.all([
    DailyWorkload.find({ batchId, dateStr: { $lte: endDate } }).select('dateStr onsiteAllocated wfhAllocated').lean(),
    Attendance.find({ studentId: { $in: studentIds }, dateStr: { $lte: endDate } }).lean(),
    Leave.find({ studentId: { $in: studentIds }, status: 'approved', startDate: { $lte: endDate } }).lean(),
    Task.find({ batchId, createdAt: { $lte: endDt } }).lean(),
    Submission.find({ studentId: { $in: studentIds }, submittedAt: { $lte: endDt } }).lean(),
    Leetcode.find({ batchId, createdAt: { $lte: endDt } }).lean(),
    LeetcodeSubmission.find({ studentId: { $in: studentIds }, createdAt: { $lte: endDt } }).lean(),
    GamificationEvent.find({
      userId: { $in: studentIds },
      createdAt: { $gte: startDt, $lte: endDt }
    }).select('userId coinsChange xpChange').lean()
  ]);

  const submissionIds = submissions.map(s => s._id);
  const grades = submissionIds.length > 0
    ? await Grade.find({ submissionId: { $in: submissionIds } }).lean()
    : [];

  // Index everything into O(1) Maps
  const scheduledDatesSet = new Set();
  workloads.forEach(w => {
    if (w.onsiteAllocated || w.wfhAllocated) scheduledDatesSet.add(w.dateStr);
  });

  const attByStudent = new Map();
  attendances.forEach(a => {
    const sid = String(a.studentId);
    if (!attByStudent.has(sid)) attByStudent.set(sid, []);
    attByStudent.get(sid).push(a);
  });

  const leavesByStudent = new Map();
  leaves.forEach(l => {
    const sid = String(l.studentId);
    if (!leavesByStudent.has(sid)) leavesByStudent.set(sid, []);
    leavesByStudent.get(sid).push(l);
  });

  const subsByStudent = new Map();
  submissions.forEach(s => {
    const sid = String(s.studentId);
    if (!subsByStudent.has(sid)) subsByStudent.set(sid, new Map());
    subsByStudent.get(sid).set(String(s.taskId), s);
  });

  const gradeBySubId = new Map();
  grades.forEach(g => gradeBySubId.set(String(g.submissionId), g));

  const lcSubsByStudent = new Map();
  leetcodeSubs.forEach(ls => {
    const sid = String(ls.studentId);
    if (!lcSubsByStudent.has(sid)) lcSubsByStudent.set(sid, []);
    lcSubsByStudent.get(sid).push(ls);
  });

  const periodPointsByStudent = new Map();
  gamificationEvents.forEach(ev => {
    const sid = String(ev.userId);
    const pts = Math.max(0, ev.coinsChange || 0) + Math.max(0, ev.xpChange || 0);
    periodPointsByStudent.set(sid, (periodPointsByStudent.get(sid) || 0) + pts);
  });

  // Compute snapshot rank across batch
  const snapshotRanking = [...validEnrollments]
    .sort((a, b) => (b.studentId.coins || 0) - (a.studentId.coins || 0))
    .map((e, idx) => ({ studentId: String(e.studentId._id), rank: idx + 1, coins: e.studentId.coins || 0 }));
  const snapshotRankMap = new Map(snapshotRanking.map(r => [r.studentId, r.rank]));

  const hasAnyPeriodEvents = gamificationEvents.length > 0;
  const periodRanking = [...validEnrollments]
    .sort((a, b) => (periodPointsByStudent.get(String(b.studentId._id)) || 0) - (periodPointsByStudent.get(String(a.studentId._id)) || 0))
    .map((e, idx) => ({
      studentId: String(e.studentId._id),
      rank: idx + 1,
      points: periodPointsByStudent.get(String(e.studentId._id)) || 0
    }));
  const periodRankMap = new Map(periodRanking.map(r => [r.studentId, r.rank]));

  const studentReports = validEnrollments.map(enr => {
    const st = enr.studentId;
    const sid = String(st._id);
    const joiningDateStr = enr.createdAt ? toISTDateStr(enr.createdAt) : startDate;
    const effectiveStart = (reportType === 'cumulative' && joiningDateStr > startDate)
      ? joiningDateStr
      : startDate;

    const studentAtt = attByStudent.get(sid) || [];
    const studentLeaves = leavesByStudent.get(sid) || [];
    const studentSubMap = subsByStudent.get(sid) || new Map();
    const studentLcSubs = lcSubsByStudent.get(sid) || [];

    const attendance = calculateAttendanceMetrics({
      attendanceRecords: studentAtt,
      scheduledDatesSet,
      approvedLeaves: studentLeaves,
      effectiveStart,
      effectiveEnd: endDate
    });

    const workingHours = calculateWorkingHoursMetrics({
      attendanceRecords: studentAtt,
      effectiveStart,
      effectiveEnd: endDate
    });

    const { tasks: taskMetrics, grades: gradeMetrics } = calculateTaskAndGradeMetrics({
      tasks,
      submissionByTaskId: studentSubMap,
      gradeBySubmissionId: gradeBySubId,
      effectiveStart,
      effectiveEnd: endDate
    });

    const leetcode = calculateLeetcodeMetrics({
      assignedProblems: leetcodes,
      studentSubmissions: studentLcSubs,
      effectiveStart,
      effectiveEnd: endDate
    });

    const consistency = calculateNormalizedScore({
      attendancePct: attendance.attendancePercentage,
      hasAttendanceData: attendance.eligibleTrainingDays > 0,
      taskCompletionPct: taskMetrics.completionPercentage,
      hasTaskData: taskMetrics.assigned > 0,
      gradePct: gradeMetrics.averagePercentage || 0,
      hasGradeData: gradeMetrics.evaluatedAvailable,
      leetcodeSolved: leetcode.totalSolved,
      leetcodeAssigned: leetcode.totalAssigned,
      hasLeetcodeData: leetcode.totalAssigned > 0 || leetcode.totalSolved > 0,
      workingConsistencyPct: workingHours.workingConsistencyPct,
      hasWorkingData: workingHours.total.workingDays > 0,
      weights
    });

    const { strengths, improvementAreas } = deriveInsights({
      attendance,
      tasks: taskMetrics,
      grades: gradeMetrics,
      workingHours,
      leetcode
    });

    const availableModules = [];
    const missingModules = [];
    if (attendance.eligibleTrainingDays > 0) availableModules.push('Attendance'); else missingModules.push('Attendance');
    if (taskMetrics.assigned > 0) availableModules.push('Tasks'); else missingModules.push('Tasks');
    if (gradeMetrics.evaluatedAvailable) availableModules.push('Grades'); else missingModules.push('Grades');
    if (workingHours.total.workingDays > 0) availableModules.push('Working Hours'); else missingModules.push('Working Hours');
    if (leetcode.totalAssigned > 0 || leetcode.totalSolved > 0) availableModules.push('LeetCode'); else missingModules.push('LeetCode');

    const dataCompleteness = {
      percentage: Math.round((availableModules.length / 5) * 100),
      availableModules,
      missingModules,
      notes: [
        ...(!gradeMetrics.evaluatedAvailable ? ['No graded assessments in this period'] : []),
        'LeetCode difficulty/topic breakdown not available in current schema'
      ]
    };

    const currentSnapshotRank = snapshotRankMap.get(sid) || null;
    const periodRank = hasAnyPeriodEvents ? (periodRankMap.get(sid) || null) : null;

    const leaderboard = {
      currentRank: currentSnapshotRank,
      periodRank,
      rankLabel: periodRank ? 'Period Points Rank' : 'Current Rank — Snapshot',
      periodPoints: periodPointsByStudent.get(sid) || 0,
      totalCoinsSnapshot: st.coins || 0,
      batchSize: validEnrollments.length
    };

    return {
      student: {
        _id: st._id,
        name: st.name,
        email: st.email,
        rollNumber: st.rollNumber
      },
      joiningDate: joiningDateStr,
      effectiveStart,
      effectiveEnd: endDate,
      dataCompleteness,
      snapshot: {
        student: {
          _id: st._id,
          name: st.name,
          email: st.email,
          rollNumber: st.rollNumber,
          joiningDate: joiningDateStr
        },
        batch: {
          _id: batch._id,
          batchName: batch.batchName,
          mentorName: batch.mentorId?.name || 'Mentor'
        },
        period: {
          reportType,
          startDate: effectiveStart,
          endDate
        },
        attendance,
        workingHours,
        tasks: taskMetrics,
        grades: gradeMetrics,
        leetcode,
        leaderboard,
        consistency,
        strengths,
        improvementAreas
      }
    };
  });

  // Compute batch averages for comparison
  const n = studentReports.length;
  const avg = (arr) => n > 0 ? Number((arr.reduce((a, b) => a + b, 0) / n).toFixed(1)) : 0;
  const gradedReports = studentReports.filter(r => r.snapshot.grades.evaluatedAvailable);

  const batchSummary = {
    totalStudents: n,
    avgAttendancePct: avg(studentReports.map(r => r.snapshot.attendance.attendancePercentage)),
    avgTaskCompletionPct: avg(studentReports.map(r => r.snapshot.tasks.completionPercentage)),
    avgGradePct: gradedReports.length > 0
      ? Number((gradedReports.reduce((s, r) => s + r.snapshot.grades.averagePercentage, 0) / gradedReports.length).toFixed(1))
      : null,
    avgWorkingHours: avg(studentReports.map(r => r.snapshot.workingHours.total.totalHours)),
    avgOnsiteHours: avg(studentReports.map(r => r.snapshot.workingHours.onsite.totalHours)),
    avgWfhHours: avg(studentReports.map(r => r.snapshot.workingHours.wfh.totalHours)),
    avgLeetcodeSolved: avg(studentReports.map(r => r.snapshot.leetcode.totalSolved)),
    avgConsistencyScore: avg(studentReports.map(r => r.snapshot.consistency.overallScore))
  };

  return { batch, studentReports, batchSummary };
};

module.exports = {
  DEFAULT_WEIGHTS,
  toISTDateStr,
  resolvePeriodDates,
  calculateAttendanceMetrics,
  calculateWorkingHoursMetrics,
  calculateTaskAndGradeMetrics,
  calculateLeetcodeMetrics,
  calculateNormalizedScore,
  deriveInsights,
  computeBatchPerformanceReports
};
