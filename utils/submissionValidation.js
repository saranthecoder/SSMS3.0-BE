const MAX_TEXT_SUBMISSION_LINES = 100;

/**
 * Counts logical text/code lines in a plain-text or rich-text (ReactQuill HTML) submission.
 */
const countSubmissionTextLines = (rawContent) => {
  if (!rawContent || typeof rawContent !== 'string') return 0;

  let text = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Empty Quill paragraphs like <p><br></p> represent a single blank line
  text = text.replace(/<(?:p|div|li|h[1-6]|blockquote)[^>]*>\s*<br\s*\/?>\s*<\/(?:p|div|li|h[1-6]|blockquote)>/gi, '\n');

  // Convert explicit breaks and closing block tags to newlines
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n');

  // Strip remaining HTML tags and decode common entities
  text = text
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  // Drop trailing blank lines emitted by closing block tags at end of document
  const trimmedEnd = text.replace(/\n+$/g, '');
  if (!trimmedEnd.trim()) return 0;

  return trimmedEnd.split('\n').length;
};

/**
 * Validates task submission payload and returns clear reason if invalid.
 */
const validateTaskSubmissionPayload = ({
  submissionType,
  textContent,
  linkUrl,
  fileUrl,
  task,
  submittedLinks
}) => {
  const requiredLinks = Array.isArray(task?.requiredLinks) ? task.requiredLinks : [];

  if (requiredLinks.length > 0) {
    const provided = Array.isArray(submittedLinks) ? submittedLinks : [];
    for (const reqLink of requiredLinks) {
      if (!reqLink.isMandatory) continue;
      const match = provided.find(sl => sl && sl.label === reqLink.label);
      if (!match || !String(match.url || '').trim()) {
        return {
          valid: false,
          message: `Task not submitted: "${reqLink.label}" link is mandatory. Please provide a valid URL before submitting.`
        };
      }
    }
    return { valid: true };
  }

  const effectiveType = submissionType || 'text';
  if (effectiveType === 'text') {
    const lineCount = countSubmissionTextLines(textContent);
    if (lineCount === 0) {
      return {
        valid: false,
        lineCount: 0,
        maxLines: MAX_TEXT_SUBMISSION_LINES,
        message: `Task not submitted: Text submission cannot be empty. Please write or paste your answer/code (maximum ${MAX_TEXT_SUBMISSION_LINES} lines).`
      };
    }
    if (lineCount > MAX_TEXT_SUBMISSION_LINES) {
      const excess = lineCount - MAX_TEXT_SUBMISSION_LINES;
      return {
        valid: false,
        lineCount,
        maxLines: MAX_TEXT_SUBMISSION_LINES,
        message: `Task not submitted: Your text submission has ${lineCount} lines, which exceeds the maximum limit of ${MAX_TEXT_SUBMISSION_LINES} lines by ${excess} line${excess > 1 ? 's' : ''}. Please shorten your text or submit via Link.`
      };
    }
    return { valid: true, lineCount, maxLines: MAX_TEXT_SUBMISSION_LINES };
  }

  if (effectiveType === 'link' && !String(linkUrl || '').trim()) {
    return {
      valid: false,
      message: 'Task not submitted: Please enter a valid Project Link / GitHub URL before submitting.'
    };
  }

  if (effectiveType === 'file' && !String(fileUrl || '').trim()) {
    return {
      valid: false,
      message: 'Task not submitted: Please attach a file before submitting.'
    };
  }

  return { valid: true };
};

module.exports = {
  MAX_TEXT_SUBMISSION_LINES,
  countSubmissionTextLines,
  validateTaskSubmissionPayload
};
