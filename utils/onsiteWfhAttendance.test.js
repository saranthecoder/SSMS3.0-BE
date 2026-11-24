const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluateAttendanceRecord } = require('../controllers/attendanceController');

describe('On-Site and WFH Attendance Separation & Evaluation Suite', () => {
  it('resets and accumulates WFH seconds independently from stored on-site session', () => {
    const record = {
      onsiteDurationSeconds: 7200, // 2h on-site completed
      wfhDurationSeconds: 0,       // 0h WFH to start
      accessType: 'wfh',
      onsiteAllocated: true,
      wfhAllocated: true,
      onsiteMinHours: 2,
      wfhMinHours: 3,
      isActive: true
    };

    // Simulate 3 hours (10800s) of WFH activity
    evaluateAttendanceRecord(record, 10800);

    // On-site duration remains securely stored at 7200s (2h)
    assert.strictEqual(record.onsiteDurationSeconds, 7200);
    // WFH duration accumulates from 0 to 10800s (3h)
    assert.strictEqual(record.wfhDurationSeconds, 10800);
    // Total session duration is the exact sum of both
    assert.strictEqual(record.sessionDurationSeconds, 18000); // 5h
  });

  it('marks Present when BOTH On-Site and WFH conditions are satisfied on dual-mode days', () => {
    const record = {
      onsiteDurationSeconds: 7200,  // 2h logged
      wfhDurationSeconds: 10800,    // 3h logged
      onsiteMinHours: 2,            // 2h required
      wfhMinHours: 3,               // 3h required
      onsiteAllocated: true,
      wfhAllocated: true,
      isActive: false
    };

    const status = evaluateAttendanceRecord(record, 0);
    assert.strictEqual(status, 'Present');
  });

  it('marks Absent when student completes On-Site but fails WFH minimum on dual-mode days', () => {
    const record = {
      onsiteDurationSeconds: 7200, // 2h logged (meets 2h on-site min)
      wfhDurationSeconds: 3600,    // 1h logged (fails 3h WFH min)
      onsiteMinHours: 2,
      wfhMinHours: 3,
      onsiteAllocated: true,
      wfhAllocated: true,
      isActive: false
    };

    const status = evaluateAttendanceRecord(record, 0);
    assert.strictEqual(status, 'Absent');
  });

  it('evaluates ONLY WFH criteria on holiday/remote days when mentor only allocated WFH', () => {
    const record = {
      onsiteDurationSeconds: 0,  // 0h on-site on holiday
      wfhDurationSeconds: 10800, // 3h WFH logged
      onsiteMinHours: 4,         // Default schema value should NOT block holiday WFH
      wfhMinHours: 3,            // 3h required for WFH
      onsiteAllocated: false,    // No on-site was allocated today
      wfhAllocated: true,        // WFH allocated for holiday
      isActive: false
    };

    const status = evaluateAttendanceRecord(record, 0);
    assert.strictEqual(status, 'Present');
  });

  it('evaluates ONLY On-Site criteria on regular days when mentor only allocated On-Site', () => {
    const record = {
      onsiteDurationSeconds: 14400, // 4h on-site logged
      wfhDurationSeconds: 0,
      onsiteMinHours: 4,
      wfhMinHours: 4,
      onsiteAllocated: true,
      wfhAllocated: false,
      isActive: false
    };

    const status = evaluateAttendanceRecord(record, 0);
    assert.strictEqual(status, 'Present');
  });

  it('preserves In Progress status while a session is still active', () => {
    const record = {
      onsiteDurationSeconds: 7200,
      wfhDurationSeconds: 1800,
      onsiteMinHours: 2,
      wfhMinHours: 3,
      onsiteAllocated: true,
      wfhAllocated: true,
      isActive: true
    };

    const status = evaluateAttendanceRecord(record, 0);
    assert.strictEqual(status, 'In Progress');
  });
});
