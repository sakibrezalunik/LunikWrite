/**
 * Plain-Node tests for the grammar engine — deliberately dependency-free so
 * they run today, before `npm install`, with just: node lib/grammar-engine.test.js
 * (or `npm run test:engine`). Once the project is fully set up, feel free to
 * port these into Vitest/Jest for CI — the assertions themselves don't change.
 */
const assert = require('assert');
const GrammarEngine = require('./grammar-engine.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log('PASS — ' + name);
    pass++;
  } catch (e) {
    console.log('FAIL — ' + name + '\n    ' + e.message);
    fail++;
  }
}
function applyIssue(text, issue) {
  return text.slice(0, issue.start) + issue.suggestion + text.slice(issue.end);
}

test('subject-verb agreement: "She don\'t" -> "She doesn\'t"', () => {
  const text = "She don't like coffee.";
  const issues = GrammarEngine.findLocalIssues(text, 'US', []);
  const hit = issues.find((i) => i.category === 'subject_verb_agreement');
  assert.ok(hit, 'expected a subject_verb_agreement issue');
  assert.strictEqual(applyIssue(text, hit), "She doesn't like coffee.");
});

test('verb tense is correctly left to the AI layer (no false local flag)', () => {
  const issues = GrammarEngine.findLocalIssues('I go there yesterday.', 'US', []);
  assert.strictEqual(issues.length, 0);
});

test('a/an silent h: "a honest man" -> "an honest man"', () => {
  const text = 'He is a honest man.';
  const issues = GrammarEngine.findLocalIssues(text, 'US', []);
  const hit = issues.find((i) => i.category === 'article');
  assert.ok(hit, 'expected an article issue');
  assert.strictEqual(applyIssue(text, hit), 'He is an honest man.');
});

test('spelling: "recieve" -> "receive"', () => {
  const text = 'I recieve the email.';
  const issues = GrammarEngine.findLocalIssues(text, 'US', []);
  const hit = issues.find((i) => i.category === 'misspelling');
  assert.ok(hit, 'expected a misspelling issue');
  assert.strictEqual(applyIssue(text, hit), 'I receive the email.');
});

test('no false positive on "bat"', () => {
  const issues = GrammarEngine.findLocalIssues('The bat flew out of the cave.', 'US', []);
  assert.strictEqual(issues.length, 0);
});

test('a correct sentence produces no issues', () => {
  const issues = GrammarEngine.findLocalIssues('She has been working here for five years.', 'US', []);
  assert.strictEqual(issues.length, 0);
});

test('an AI issue with an invalid offset is discarded, never mis-highlighted', () => {
  const text = 'This sentence is completely fine.';
  const raw = [{ type: 'grammar', category: 'x', severity: 'high', start: 999, end: 1010, original: 'nonsense', suggestion: 'y', explanation: 'bad offset', confidence: 0.95 }];
  const normalized = GrammarEngine.normalizeAIIssues(text, raw);
  assert.strictEqual(normalized.length, 0);
});

test('a duplicate local+AI suggestion on the same span collapses to one', () => {
  const text = 'I recieve the email.';
  const local = GrammarEngine.findLocalIssues(text, 'US', []);
  const dup = local.find((i) => i.category === 'misspelling');
  const aiRaw = [{ type: 'spelling', category: 'misspelling', severity: 'high', start: dup.start, end: dup.end, original: dup.original, suggestion: 'receive', explanation: 'AI also caught this', confidence: 0.95 }];
  const aiIssues = GrammarEngine.normalizeAIIssues(text, aiRaw);
  const merged = GrammarEngine.mergeIssues(local, aiIssues);
  const countForSpan = merged.filter((i) => i.start === dup.start && i.end === dup.end).length;
  assert.strictEqual(countForSpan, 1);
});

test('an AI spelling/punctuation issue keeps its own type (reaches its tab)', () => {
  const text = 'Their going to the park. However the bus left.';
  const raw = [
    { type: 'spelling', category: 'confusable', severity: 'medium', start: 0, end: 5, original: 'Their', suggestion: "They're", explanation: 'Contraction needed.', confidence: 0.9 },
    { type: 'punctuation', category: 'missing_comma', severity: 'medium', start: 25, end: 32, original: 'However', suggestion: 'However,', explanation: 'Comma after an introductory word.', confidence: 0.9 }
  ];
  const normalized = GrammarEngine.normalizeAIIssues(text, raw);
  assert.strictEqual(normalized.length, 2);
  assert.strictEqual(normalized[0].type, 'spelling', 'AI spelling must stay spelling, not be coerced to style');
  assert.strictEqual(normalized[1].type, 'punctuation', 'AI punctuation must stay punctuation');
});

test('an unknown AI issue type coerces to grammar, never to style', () => {
  const text = 'Some sample text here.';
  const raw = [{ type: 'tone_problem', category: 'voice', severity: 'low', start: 5, end: 11, original: 'sample', suggestion: 'model', explanation: 'unknown type', confidence: 0.9 }];
  const normalized = GrammarEngine.normalizeAIIssues(text, raw);
  assert.strictEqual(normalized.length, 1);
  assert.strictEqual(normalized[0].type, 'grammar');
});

test('mergeIssues keeps an AI second opinion with a different suggestion on the same span', () => {
  const text = 'I recieve the email.';
  const local = GrammarEngine.findLocalIssues(text, 'US', []);
  const dup = local.find((i) => i.category === 'misspelling');
  const aiRaw = [{ type: 'spelling', category: 'misspelling', severity: 'high', start: dup.start, end: dup.end, original: dup.original, suggestion: 'received', explanation: 'AI disagrees on tense', confidence: 0.95 }];
  const aiIssues = GrammarEngine.normalizeAIIssues(text, aiRaw);
  const merged = GrammarEngine.mergeIssues(local, aiIssues);
  assert.strictEqual(merged.length, local.length + 1, 'AI issue with a different suggestion must survive');
});

test('a low-confidence AI issue is filtered out', () => {
  const text = 'Some text here.';
  const raw = [{ type: 'style', category: 'weak', severity: 'low', start: 0, end: 4, original: 'Some', suggestion: 'A', explanation: 'low confidence', confidence: 0.4 }];
  const normalized = GrammarEngine.normalizeAIIssues(text, raw, { minConfidence: 0.7 });
  assert.strictEqual(normalized.length, 0);
});

console.log('\nTOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
