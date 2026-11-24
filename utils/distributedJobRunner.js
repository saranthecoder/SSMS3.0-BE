const JobLock = require('../models/JobLock');

const INSTANCE_ID = process.env.RENDER_INSTANCE_ID || `instance_${process.pid}_${Math.random().toString(36).substring(2, 8)}`;

/**
 * Coordinates background jobs across multiple backend instances using atomic MongoDB operations.
 * Guarantees mutual exclusion and prevents duplicate job execution.
 *
 * @param {string} jobName - Unique job identifier (e.g. 'attendance_midnight_reset')
 * @param {number} lockTtlMs - Lock duration before lease expires (default 60000ms)
 * @param {number} minIntervalMs - Minimum cooldown before job may run again (e.g. 3600000ms for hourly jobs)
 * @param {Function} jobFn - The actual async job function to execute
 * @returns {Promise<{executed: boolean, reason?: string, error?: string}>}
 */
const runDistributedJob = async (jobName, lockTtlMs = 60000, minIntervalMs = 0, jobFn) => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + lockTtlMs);

  try {
    // 1. Check existing lock to verify minIntervalMs hasn't already been satisfied recently
    const existing = await JobLock.findById(jobName).lean();
    if (existing) {
      if (minIntervalMs > 0 && existing.lastRunAt) {
        const elapsed = now.getTime() - new Date(existing.lastRunAt).getTime();
        if (elapsed < minIntervalMs) {
          return { executed: false, reason: 'cooldown_active' };
        }
      }

      if (existing.expiresAt && new Date(existing.expiresAt) > now) {
        return { executed: false, reason: 'already_locked' };
      }
    }

    // 2. Atomically acquire lock using conditional update
    let lockAcquired = null;
    try {
      lockAcquired = await JobLock.findOneAndUpdate(
        {
          _id: jobName,
          $or: [
            { expiresAt: { $exists: false } },
            { expiresAt: null },
            { expiresAt: { $lt: now } }
          ]
        },
        {
          $set: {
            lockedBy: INSTANCE_ID,
            lockedAt: now,
            expiresAt: expiresAt,
            lastRunAt: now
          }
        },
        { upsert: true, returnDocument: 'after' }
      );
    } catch (upsertErr) {
      if (upsertErr.code === 11000) {
        // Another instance acquired or inserted the lock concurrently
        return { executed: false, reason: 'contention_lost' };
      }
      throw upsertErr;
    }

    if (!lockAcquired || lockAcquired.lockedBy !== INSTANCE_ID) {
      return { executed: false, reason: 'contention_lost' };
    }

    // 3. Execute the job
    try {
      await jobFn();
      // On success, set expiresAt to now so lock is freed, but lastRunAt remains
      await JobLock.findByIdAndUpdate(jobName, {
        $set: { expiresAt: now }
      });
      return { executed: true };
    } catch (jobErr) {
      console.error(`[JobLock] Error executing ${jobName}:`, jobErr.message);
      await JobLock.findByIdAndUpdate(jobName, {
        $set: { expiresAt: now }
      });
      return { executed: false, error: jobErr.message };
    }
  } catch (err) {
    console.error(`[JobLock] Distributed lock error for ${jobName}:`, err.message);
    return { executed: false, error: err.message };
  }
};

module.exports = {
  runDistributedJob,
  INSTANCE_ID
};
