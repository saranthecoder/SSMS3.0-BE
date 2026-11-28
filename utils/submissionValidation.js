const MAX_TEXT_SUBMISSION_LINES = 100;
const MAX_URL_LENGTH = 2048;

/**
 * Validates that a link submission value is strictly a single HTTP/HTTPS URL (no code, spaces, or plain text).
 */
const validateSubmissionUrl = (rawUrl, fieldLabel = 'Submission Link') => {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return {
      valid: false,
      message: `Task not submitted: "${fieldLabel}" is required. Please enter a valid URL starting with https:// or http://.`
    };
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    return {
      valid: false,
      message: `Task not submitted: "${fieldLabel}" is too long. Please submit only a valid link (max ${MAX_URL_LENGTH} characters).`
    };
  }

  if (/\s/.test(trimmed) || /[{}<>`]/.test(trimmed)) {
    return {
      valid: false,
      message: `Task not submitted: Only a valid URL link is allowed in "${fieldLabel}" (code, spaces, or multi-line text cannot be submitted as a link).`
    };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      message: `Task not submitted: "${fieldLabel}" is not a valid URL. Enter a full link starting with https:// or http:// (do not paste code).`
    };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return {
      valid: false,
      message: `Task not submitted: "${fieldLabel}" must use https:// or http://.`
    };
  }

  const host = (parsed.hostname || '').toLowerCase();
  const isValidDomain = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host) || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
  if (!isValidDomain) {
    return {
      valid: false,
      message: `Task not submitted: "${fieldLabel}" must point to a valid domain URL (e.g. https://github.com/... or https://drive.google.com/...).`
    };
  }

  return { valid: true, url: trimmed };
};

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
  githubLink,
  liveLink,
  fileUrl,
  task,
  submittedLinks
}) => {
  const requiredLinks = Array.isArray(task?.requiredLinks) ? task.requiredLinks : [];

  if (requiredLinks.length > 0) {
    const provided = Array.isArray(submittedLinks) ? submittedLinks : [];
    for (const reqLink of requiredLinks) {
      const match = provided.find(sl => sl && sl.label === reqLink.label);
      const val = String(match?.url || '').trim();
      if (reqLink.isMandatory && !val) {
        return {
          valid: false,
          message: `Task not submitted: "${reqLink.label}" link is mandatory. Please provide a valid URL before submitting.`
        };
      }
      if (val) {
        const urlCheck = validateSubmissionUrl(val, reqLink.label);
        if (!urlCheck.valid) return urlCheck;
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

  if (effectiveType === 'link') {
    const urlCheck = validateSubmissionUrl(linkUrl, 'Project Link / GitHub URL');
    if (!urlCheck.valid) return urlCheck;
  }

  if (githubLink && String(githubLink).trim()) {
    const ghCheck = validateSubmissionUrl(githubLink, 'GitHub Link');
    if (!ghCheck.valid) return ghCheck;
  }

  if (liveLink && String(liveLink).trim()) {
    const liveCheck = validateSubmissionUrl(liveLink, 'Live Link');
    if (!liveCheck.valid) return liveCheck;
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
  validateSubmissionUrl,
  validateTaskSubmissionPayload
};
