// Client-safe design system helpers. No CSS values here — this module only
// formats/labels what the rest of the app already stores, so it can be
// imported by components without a bundler warning.
export const ISSUE_TYPES = [
  { key: 'grammar', label: 'Grammar' },
  { key: 'spelling', label: 'Spelling' },
  { key: 'punctuation', label: 'Punctuation' },
  { key: 'clarity', label: 'Clarity' },
  { key: 'style', label: 'Style' }
];

export const REWRITE_STYLES = [
  { key: 'improve', label: 'Rewrite' },
  { key: 'shorten', label: 'Concise' },
  { key: 'expand', label: 'Expand' },
  { key: 'simplify', label: 'Simplify' },
  { key: 'formal', label: 'Formal' },
  { key: 'casual', label: 'Friendly' },
  { key: 'persuasive', label: 'Confident' }
];

export const TONE_PRIMARY = ['Professional', 'Friendly', 'Confident', 'Formal', 'Casual', 'Academic', 'Persuasive'];

export function labelize(cat) {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function sanitizedFilename(name) {
  const base = (name || 'document')
    .replace(/[^a-z0-9\-_ ]/gi, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  return base || 'document';
}
