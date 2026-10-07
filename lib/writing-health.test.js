/**
 * Plain-Node tests for Writing Health — dependency-free, same style as
 * lib/grammar-engine.test.js:  node lib/writing-health.test.js
 */
const assert = require('assert');
const WritingHealth = require('./writing-health.js');

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

test('an empty document returns null (nothing to score)', () => {
  assert.strictEqual(WritingHealth.computeWritingHealth(''), null);
  assert.strictEqual(WritingHealth.computeWritingHealth('   \n\t  '), null);
});

test('scores are bounded 0-100 and include all four metrics for real prose', () => {
  const text = 'The sun is up. We can go out and play in the park today. She brings her ball. We stay until dinner.';
  const h = WritingHealth.computeWritingHealth(text, []);
  assert.ok(h, 'expected a result');
  assert.ok(h.overall >= 0 && h.overall <= 100, 'overall in range, got ' + h.overall);
  const keys = h.metrics.map((m) => m.key).sort().join(',');
  assert.strictEqual(keys, 'clarity,conciseness,correctness,variety');
  assert.ok(['Strong', 'Solid', 'Fair', 'Needs work'].includes(h.label), 'known label, got ' + h.label);
});

test('clarity: dense academic prose scores lower than plain prose', () => {
  const plain = WritingHealth.computeWritingHealth('The sun is up. We can go out and play in the park today.', []);
  const dense = WritingHealth.computeWritingHealth(
    'Notwithstanding the aforementioned considerations, the implementation of comprehensive interdisciplinary ' +
      'methodologies necessitates substantial organizational restructuring throughout contemporary institutional frameworks.',
    []
  );
  const c = (h) => h.metrics.find((m) => m.key === 'clarity').score;
  assert.ok(c(dense) < c(plain), 'dense clarity ' + c(dense) + ' should be below plain clarity ' + c(plain));
});

test('correctness: severity-weighted issues reduce the score; clean text scores 100', () => {
  const text = 'one two three four five six seven eight nine ten.';
  const clean = WritingHealth.computeWritingHealth(text, []);
  const flagged = WritingHealth.computeWritingHealth(text, [
    { severity: 'high' },
    { severity: 'high' }
  ]);
  const c = (h) => h.metrics.find((m) => m.key === 'correctness').score;
  assert.strictEqual(c(clean), 100);
  assert.ok(c(flagged) < c(clean), 'flagged correctness ' + c(flagged) + ' must be below clean ' + c(clean));
});

test('variety: uniform sentence lengths score below varied ones', () => {
  const monotone = WritingHealth.computeWritingHealth('The cat sat. The dog ran. The bird flew. The fish swam.', []);
  const varied = WritingHealth.computeWritingHealth(
    'The cat sat. Quickly, the energetic little dog ran across the entire garden. Birds flew. Fish swam lazily in the pond.',
    []
  );
  const v = (h) => h.metrics.find((m) => m.key === 'variety').score;
  assert.ok(v(varied) > v(monotone), 'varied ' + v(varied) + ' must beat monotone ' + v(monotone));
});

test('variety is honestly omitted for a single-sentence document', () => {
  const h = WritingHealth.computeWritingHealth('Just one sentence here.', []);
  assert.ok(h, 'expected a result');
  assert.strictEqual(h.metrics.find((m) => m.key === 'variety'), undefined);
});

test('the same input always produces the exact same result (determinism)', () => {
  const text = 'She dont like coffee. He is a honest man, and the weather is nice today too.';
  const issues = [{ severity: 'high' }, { severity: 'low' }];
  const a = JSON.stringify(WritingHealth.computeWritingHealth(text, issues));
  const b = JSON.stringify(WritingHealth.computeWritingHealth(text, issues));
  assert.strictEqual(a, b);
});

console.log('\nTOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
