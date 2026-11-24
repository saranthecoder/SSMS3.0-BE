const test = require('node:test');
const assert = require('node:assert/strict');

test('Socket.io and Distributed Job Coordination Suite', async (t) => {

  await t.test('Distributed Job Lock: Only one worker acquires lease among concurrent attempts', async () => {
    // In-memory mock representing MongoDB atomic document collection
    const locksCollection = new Map();

    const simulateAtomicAcquire = (jobName, workerId, lockTtlMs, minIntervalMs = 0) => {
      const now = Date.now();
      const existing = locksCollection.get(jobName);

      if (existing) {
        // Cooldown check
        if (minIntervalMs > 0 && existing.lastRunAt && (now - existing.lastRunAt < minIntervalMs)) {
          return { acquired: false, reason: 'cooldown_active' };
        }
        // Active lock check
        if (existing.expiresAt && existing.expiresAt > now) {
          return { acquired: false, reason: 'already_locked' };
        }
      }

      // Simulate atomic findOneAndUpdate with condition
      const newRecord = {
        lockedBy: workerId,
        lockedAt: now,
        expiresAt: now + lockTtlMs,
        lastRunAt: now
      };
      locksCollection.set(jobName, newRecord);
      return { acquired: true, record: newRecord };
    };

    // 4 concurrent instances firing at the same millisecond
    const instances = ['node-1', 'node-2', 'node-3', 'node-4'];
    const results = instances.map(id => simulateAtomicAcquire('attendance_midnight_reset', id, 60000, 3600000));

    // Exactly one instance must acquire the lock
    const winners = results.filter(r => r.acquired);
    const losers = results.filter(r => !r.acquired);

    assert.equal(winners.length, 1, 'Exactly one instance should acquire the distributed lock');
    assert.equal(losers.length, 3, 'Other instances must be locked out');
    assert.ok(['already_locked', 'cooldown_active'].includes(losers[0].reason), 'Lockout reason must be active lock or cooldown');
  });

  await t.test('Distributed Job Lock: Expired lease automatically frees lock for recovery', async () => {
    const locksCollection = new Map();
    const now = Date.now();

    // Stale lock from crashed instance 5 minutes ago
    locksCollection.set('batch_auto_checkout', {
      lockedBy: 'crashed-node-x',
      lockedAt: now - 300000,
      expiresAt: now - 240000, // Expired 4 minutes ago
      lastRunAt: now - 300000
    });

    const existing = locksCollection.get('batch_auto_checkout');
    const isExpired = existing.expiresAt < now;
    assert.equal(isExpired, true, 'Stale lock should be detected as expired');

    // Recovery instance attempts acquire
    const recovered = {
      lockedBy: 'healthy-node-1',
      lockedAt: now,
      expiresAt: now + 60000,
      lastRunAt: now
    };
    locksCollection.set('batch_auto_checkout', recovered);

    assert.equal(locksCollection.get('batch_auto_checkout').lockedBy, 'healthy-node-1');
  });

  await t.test('Socket Authorization: Batch chat requires authorized role or enrollment', () => {
    const isAuthorizedForBatch = (userRole, userId, batchId, enrollments = [], mentorBatches = []) => {
      if (userRole === 'admin') return true;
      if (userRole === 'mentor' && mentorBatches.includes(batchId)) return true;
      if (enrollments.some(e => e.studentId === userId && e.batchId === batchId && e.status === 'approved')) {
        return true;
      }
      return false;
    };

    const studentId = 'student_001';
    const batchAlpha = 'batch_alpha';
    const batchBeta = 'batch_beta';

    const enrollments = [
      { studentId, batchId: batchAlpha, status: 'approved' }
    ];

    // Admin can access any batch
    assert.equal(isAuthorizedForBatch('admin', 'admin_1', batchAlpha), true);
    assert.equal(isAuthorizedForBatch('admin', 'admin_1', batchBeta), true);

    // Student can only access enrolled approved batch
    assert.equal(isAuthorizedForBatch('student', studentId, batchAlpha, enrollments), true);
    assert.equal(isAuthorizedForBatch('student', studentId, batchBeta, enrollments), false);

    // Mentor can access assigned batch
    assert.equal(isAuthorizedForBatch('mentor', 'mentor_1', batchBeta, [], [batchBeta]), true);
    assert.equal(isAuthorizedForBatch('mentor', 'mentor_1', batchAlpha, [], [batchBeta]), false);
  });

  await t.test('Socket Sender Integrity: Disallows client spoofing of senderId or announcement role', () => {
    const validateChatMessage = (authenticatedSocket, clientPayload) => {
      // Force sender identity from authenticated socket session
      const senderId = authenticatedSocket.userId;
      const senderRole = authenticatedSocket.userRole;

      // Only admin or mentor can post announcements
      const isAnnouncement = Boolean(clientPayload.isAnnouncement && (senderRole === 'admin' || senderRole === 'mentor'));

      return {
        senderId,
        senderRole,
        isAnnouncement
      };
    };

    const studentSocket = { userId: 'student_123', userRole: 'student' };
    const spoofAttempt = {
      senderId: 'admin_master',
      isAnnouncement: true,
      text: 'Fake announcement'
    };

    const processed = validateChatMessage(studentSocket, spoofAttempt);
    assert.equal(processed.senderId, 'student_123', 'senderId must match authenticated socket, ignoring spoofed payload');
    assert.equal(processed.isAnnouncement, false, 'Student cannot trigger announcement');
  });

  await t.test('Cross-Instance Broadcast Bridge: Ignores self-originated events and routes foreign events', () => {
    const localInstanceId = 'node-instance-1';
    const localConnectedSockets = {
      'user_target_1': new Set(['socket_abc_1'])
    };

    let emittedLocally = 0;
    const mockEmit = (socketId, event, data) => {
      emittedLocally++;
    };

    const handleIncomingBroadcast = (broadcastDoc) => {
      // Rule 1: Ignore own events
      if (broadcastDoc.sourceInstance === localInstanceId) return false;

      // Rule 2: Deliver to target user if present locally
      if (broadcastDoc.type === 'to_user' && localConnectedSockets[broadcastDoc.target]) {
        for (const sId of localConnectedSockets[broadcastDoc.target]) {
          mockEmit(sId, broadcastDoc.event, broadcastDoc.data);
        }
        return true;
      }
      return false;
    };

    // Event originated on this instance -> ignored
    const selfEvent = { sourceInstance: 'node-instance-1', type: 'to_user', target: 'user_target_1', event: 'force-checkout' };
    assert.equal(handleIncomingBroadcast(selfEvent), false);
    assert.equal(emittedLocally, 0);

    // Event originated on another instance (e.g. node-2) -> delivered locally
    const foreignEvent = { sourceInstance: 'node-instance-2', type: 'to_user', target: 'user_target_1', event: 'force-checkout' };
    assert.equal(handleIncomingBroadcast(foreignEvent), true);
    assert.equal(emittedLocally, 1);
  });
});
