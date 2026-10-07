/**
 * Small helpers shared by every AI provider (Anthropic, Gemini, ...).
 * Nothing provider-specific belongs here.
 */

/** Strip common markdown-fence wrapping a model sometimes adds despite instructions, then parse. */
export function parseJsonLoose(raw) {
  const cleaned = String(raw || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '');
  return JSON.parse(cleaned);
}
