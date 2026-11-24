const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const MonitorAccess = require('../models/MonitorAccess');

test('MonitorAccess Schema: requires panelName and pin, uppercases pin', () => {
  const doc = new MonitorAccess({
    panelName: 'MIT Mysore College Management',
    pin: 'mit123',
    allowedBatches: [new mongoose.Types.ObjectId()],
    isGlobal: false
  });

  assert.strictEqual(doc.pin, 'MIT123');
  assert.strictEqual(doc.panelName, 'MIT Mysore College Management');
  assert.strictEqual(doc.isGlobal, false);
  assert.strictEqual(doc.isActive, true);
  assert.strictEqual(doc.allowedBatches.length, 1);
});

test('MonitorAccess Schema: allows global scope with empty allowedBatches', () => {
  const doc = new MonitorAccess({
    panelName: 'Executive Command Center',
    pin: 'SA123',
    isGlobal: true,
    allowedBatches: []
  });

  assert.strictEqual(doc.pin, 'SA123');
  assert.strictEqual(doc.isGlobal, true);
  assert.strictEqual(doc.allowedBatches.length, 0);
});
