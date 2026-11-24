const { describe, it } = require('node:test');
const assert = require('node:assert');
const { awardCoinsWithCap, checkAndAwardBadges } = require('./gamification');

describe('Task Submission Gamification Coins Suite', () => {
  it('correctly calculates 10x multiplier for allocated task marks', () => {
    const task1 = { maxMarks: 10 };
    const task2 = { maxMarks: 100 };
    const task3 = { maxMarks: 25 };

    assert.strictEqual(task1.maxMarks * 10, 100);
    assert.strictEqual(task2.maxMarks * 10, 1000);
    assert.strictEqual(task3.maxMarks * 10, 250);
  });

  it('awards full coins to student user bypassing standard daily caps', () => {
    const mockStudent = {
      coins: 50,
      rewardHistory: [],
      badges: []
    };

    const taskMarks = 100;
    const coinsToAward = taskMarks * 10; // 1000 coins

    const actualAwarded = awardCoinsWithCap(
      mockStudent,
      coinsToAward,
      `Task Submission: "Java OOP Assignment" (10x ${taskMarks} marks)`,
      true
    );

    assert.strictEqual(actualAwarded, 1000);
    assert.strictEqual(mockStudent.coins, 1050);
    assert.strictEqual(mockStudent.rewardHistory.length, 1);
    assert.strictEqual(mockStudent.rewardHistory[0].type, 'coins');
    assert.strictEqual(mockStudent.rewardHistory[0].amount, 1000);
  });

  it('triggers badge unlock upon reaching accumulated coins milestones', () => {
    const mockStudent = {
      coins: 1050,
      rewardHistory: [],
      badges: []
    };

    const newBadges = checkAndAwardBadges(mockStudent);
    // Student with 1050 coins should unlock "Coin Collector" (>=100) and "Rich Student" (>=500)
    assert.ok(mockStudent.badges.some(b => b.name === 'Coin Collector'));
    assert.ok(mockStudent.badges.some(b => b.name === 'Rich Student'));
  });
});
