const test = require('node:test');
const assert = require('node:assert');
const {
  MAX_TEXT_SUBMISSION_LINES,
  countSubmissionTextLines,
  validateTaskSubmissionPayload
} = require('./submissionValidation');

test('countSubmissionTextLines handles empty, blank-line, Quill paragraph, and preformatted code content accurately', () => {
  assert.strictEqual(countSubmissionTextLines(''), 0);
  assert.strictEqual(countSubmissionTextLines('<p><br></p>'), 0);
  assert.strictEqual(countSubmissionTextLines('<p>   &nbsp; </p>'), 0);
  assert.strictEqual(countSubmissionTextLines('<p>line 1</p><p>line 2</p>'), 2);
  assert.strictEqual(countSubmissionTextLines('<p>line 1</p><p><br></p><p>line 3</p>'), 3);
  assert.strictEqual(countSubmissionTextLines('<pre class="ql-syntax">a\nb\nc\n</pre>'), 3);
});

test('validateTaskSubmissionPayload enforces exact 100-line limit on text submissions with clear reasons', () => {
  const exact100 = Array.from({ length: 100 }, (_, i) => `<p>console.log(${i + 1});</p>`).join('');
  const res100 = validateTaskSubmissionPayload({
    submissionType: 'text',
    textContent: exact100,
    task: {}
  });
  assert.strictEqual(res100.valid, true);
  assert.strictEqual(res100.lineCount, MAX_TEXT_SUBMISSION_LINES);

  const lines101 = Array.from({ length: 101 }, (_, i) => `<p>line ${i + 1}</p>`).join('');
  const res101 = validateTaskSubmissionPayload({
    submissionType: 'text',
    textContent: lines101,
    task: {}
  });
  assert.strictEqual(res101.valid, false);
  assert.strictEqual(res101.lineCount, 101);
  assert.match(res101.message, /101 lines/);
  assert.match(res101.message, /100 lines/);

  const emptyRes = validateTaskSubmissionPayload({
    submissionType: 'text',
    textContent: '<p><br></p>',
    task: {}
  });
  assert.strictEqual(emptyRes.valid, false);
  assert.match(emptyRes.message, /empty/i);

  // Link submission is not blocked even if unused textContent exceeds 100 lines
  const linkRes = validateTaskSubmissionPayload({
    submissionType: 'link',
    textContent: lines101,
    linkUrl: 'https://github.com/example/repo',
    task: {}
  });
  assert.strictEqual(linkRes.valid, true);
});
