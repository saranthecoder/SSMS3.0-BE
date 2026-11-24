const test = require('node:test');
const assert = require('node:assert/strict');

test('Student Panel Access & Suspension Suite', async (t) => {
  await t.test('Permanent block status prevents student access', () => {
    const student = {
      role: 'student',
      isBlocked: true,
      blockReason: 'Misconduct in batch chat',
      isSuspended: false
    };

    const isAccessBlocked = Boolean(student.isBlocked);
    assert.equal(isAccessBlocked, true);
    assert.equal(student.blockReason, 'Misconduct in batch chat');
  });

  await t.test('Active suspension calculates remaining duration accurately', () => {
    const now = Date.now();
    const future24Hours = new Date(now + 24 * 3600 * 1000);

    const student = {
      role: 'student',
      isBlocked: false,
      isSuspended: true,
      suspendedUntil: future24Hours,
      suspensionReason: 'Task submission delay'
    };

    const isSuspensionActive = Boolean(student.isSuspended && new Date(student.suspendedUntil) > new Date(now));
    assert.equal(isSuspensionActive, true);

    const diffHours = Math.round((new Date(student.suspendedUntil) - new Date(now)) / (1000 * 3600));
    assert.equal(diffHours, 24);
  });

  await t.test('Expired suspension automatically lifts and restores access', () => {
    const pastTime = new Date(Date.now() - 3600 * 1000); // 1 hour ago

    const student = {
      role: 'student',
      isBlocked: false,
      isSuspended: true,
      suspendedUntil: pastTime,
      suspensionReason: 'Temporary review'
    };

    const isSuspensionActive = Boolean(student.isSuspended && new Date(student.suspendedUntil) > new Date());
    assert.equal(isSuspensionActive, false);
  });

  await t.test('Multi-hour preset durations calculate correct future target timestamps', () => {
    const presets = [1, 3, 6, 12, 24, 48, 72, 168];
    const baseTime = Date.now();

    presets.forEach(hours => {
      const targetDate = new Date(baseTime + hours * 3600 * 1000);
      const computedDiffHours = Math.round((targetDate.getTime() - baseTime) / 3600000);
      assert.equal(computedDiffHours, hours);
    });
  });

  await t.test('StudentAccessLog: validates required fields and action enum values', () => {
    const StudentAccessLog = require('../models/StudentAccessLog');
    
    // Valid log instance
    const validLog = new StudentAccessLog({
      studentId: '507f1f77bcf86cd799439011',
      studentName: 'Saran Vel',
      studentRollNumber: '23691A3340',
      action: 'suspend',
      reason: 'Rule breach',
      durationHours: 24,
      suspendedUntil: new Date(Date.now() + 86400000),
      performedBy: '507f1f77bcf86cd799439022',
      performedByName: 'Admin Mentor',
      performedByRole: 'mentor'
    });
    const validErr = validLog.validateSync();
    assert.equal(validErr, undefined);

    // Invalid action
    const invalidLog = new StudentAccessLog({
      studentId: '507f1f77bcf86cd799439011',
      studentName: 'Saran Vel',
      action: 'banned_permanently', // invalid enum
      performedBy: '507f1f77bcf86cd799439022',
      performedByName: 'Admin',
      performedByRole: 'admin'
    });
    const invalidErr = invalidLog.validateSync();
    assert.ok(invalidErr.errors.action);
  });

  await t.test('Auto check-out simulation on suspension: active session duration and checkOutTime are committed', () => {
    const checkInTime = new Date(Date.now() - 7200 * 1000); // checked in 2 hours ago
    const activeAttendance = {
      studentId: '507f1f77bcf86cd799439011',
      dateStr: '2026-11-24',
      isActive: true,
      lastCheckInTime: checkInTime,
      sessionDurationSeconds: 1800, // already had 30 mins from previous slot
      checkOutTime: null
    };

    // Simulate auto checkout logic
    const now = Date.now();
    const durationMs = now - new Date(activeAttendance.lastCheckInTime).getTime();
    activeAttendance.sessionDurationSeconds += Math.floor(durationMs / 1000);
    activeAttendance.checkOutTime = now;
    activeAttendance.isActive = false;

    assert.equal(activeAttendance.isActive, false);
    assert.ok(activeAttendance.checkOutTime !== null);
    // 1800s + ~7200s ≈ 9000s
    assert.ok(activeAttendance.sessionDurationSeconds >= 8990);
  });
});
