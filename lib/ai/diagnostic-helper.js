/**
 * Optional server-side diagnostics for the analyze flow.
 * This module deliberately never logs secrets.
 */

export function summarizeGroqError(err) {
  const pieces = [];

  if (err && typeof err === 'object') {
    if (err.code) pieces.push('code=' + String(err.code));
    if (err.status) pieces.push('http=' + String(err.status));
    if (err.message) pieces.push('message=' + sanitizeMessage(String(err.message)));
  }

  return pieces.length ? '{' + pieces.join(', ') + '}' : 'no-diagnostic-info';
}

function sanitizeMessage(message) {
  return message
    .replace(/Bearer\s+[A-Za-z0-9_\-./+=]{8,}/g, 'Bearer [REDACTED]')
    .replace(/"key"\s*:\s*"[^"]*"/gi, '"key":"[REDACTED]"')
    .slice(0, 300);
}
