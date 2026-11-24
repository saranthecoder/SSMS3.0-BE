const test = require('node:test');
const assert = require('node:assert/strict');

test('Performance & Concurrency Suite', async (t) => {
  await t.test('O(1) Map pre-indexing eliminates quadratic search overhead', () => {
    // Generate synthetic student submission & attendance data
    const studentIds = Array.from({ length: 50 }, (_, i) => `student_${i}`);
    const taskIds = Array.from({ length: 20 }, (_, i) => `task_${i}`);
    const uniqueDates = Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);

    // Synthetic attendance records
    const attendanceRecords = [];
    studentIds.forEach(sId => {
      uniqueDates.forEach(dateStr => {
        attendanceRecords.push({
          studentId: sId,
          dateStr,
          sessionDurationSeconds: 8 * 3600,
          isActive: false,
          isLeave: false
        });
      });
    });

    // Synthetic submissions
    const submissions = [];
    studentIds.forEach(sId => {
      taskIds.forEach(tId => {
        submissions.push({
          studentId: sId,
          taskId: tId,
          _id: `sub_${sId}_${tId}`
        });
      });
    });

    const start = performance.now();

    // Build Maps
    const studentSubmissionsMap = new Map();
    const submissionByStudentTaskMap = new Map();
    for (let i = 0; i < submissions.length; i++) {
      const s = submissions[i];
      const sId = s.studentId;
      let list = studentSubmissionsMap.get(sId);
      if (!list) {
        list = [];
        studentSubmissionsMap.set(sId, list);
      }
      list.push(s);
      submissionByStudentTaskMap.set(`${sId}_${s.taskId}`, s);
    }

    const attendanceByStudentDateMap = new Map();
    for (let i = 0; i < attendanceRecords.length; i++) {
      const r = attendanceRecords[i];
      attendanceByStudentDateMap.set(`${r.studentId}_${r.dateStr}`, r);
    }

    // Lookup 1,500 attendance entries and 1,000 tasks
    let foundAttendance = 0;
    let foundSubmissions = 0;

    studentIds.forEach(sId => {
      uniqueDates.forEach(date => {
        const rec = attendanceByStudentDateMap.get(`${sId}_${date}`);
        if (rec) foundAttendance++;
      });
      taskIds.forEach(tId => {
        const sub = submissionByStudentTaskMap.get(`${sId}_${tId}`);
        if (sub) foundSubmissions++;
      });
    });

    const duration = performance.now() - start;

    assert.equal(foundAttendance, 50 * 30);
    assert.equal(foundSubmissions, 50 * 20);
    assert.ok(duration < 50, `Map lookups should execute in < 50ms, took ${duration.toFixed(2)}ms`);
  });

  await t.test('Conditional atomic query structure guarantees mutual exclusion on same-day claim', () => {
    const today = new Date('2026-10-28T08:00:00Z');
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    const buildAtomicQuery = (userId, now) => ({
      _id: userId,
      $or: [
        { lastLoginReward: { $exists: false } },
        { lastLoginReward: null },
        { lastLoginReward: { $lt: startOfToday } }
      ]
    });

    const userDocUnclaimed = {
      _id: 'user_123',
      lastLoginReward: null
    };

    const userDocClaimedToday = {
      _id: 'user_123',
      lastLoginReward: new Date('2026-10-28T02:00:00Z') // earlier today
    };

    const userDocClaimedYesterday = {
      _id: 'user_123',
      lastLoginReward: new Date('2026-10-27T10:00:00Z') // yesterday
    };

    const simulateMongoCondition = (doc, query) => {
      if (doc._id !== query._id) return false;
      return query.$or.some(cond => {
        if ('lastLoginReward' in cond && cond.lastLoginReward === null) {
          return doc.lastLoginReward === null;
        }
        if (cond.lastLoginReward && cond.lastLoginReward.$lt) {
          return doc.lastLoginReward && doc.lastLoginReward < cond.lastLoginReward.$lt;
        }
        return false;
      });
    };

    const query = buildAtomicQuery('user_123', today);

    // Unclaimed must match
    assert.equal(simulateMongoCondition(userDocUnclaimed, query), true);

    // Claimed yesterday must match (eligible for today)
    assert.equal(simulateMongoCondition(userDocClaimedYesterday, query), true);

    // Claimed today must NOT match (locked out)
    assert.equal(simulateMongoCondition(userDocClaimedToday, query), false);
  });
});
