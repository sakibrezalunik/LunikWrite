/**
 * Restored API-route test suite (the original 10/10 suite was never committed
 * and was lost — this recreates equivalent, broader coverage).
 *
 * Plain Node, zero test dependencies — same style as lib/grammar-engine.test.js:
 *   node lib/api-routes.test.js   (or `npm run test:api`)
 *
 * What makes it real: it imports the ACTUAL Next.js route handlers
 * (app/api/<name>/route.js) and exercises their real Zod validation, real
 * in-memory rate limiter, real GrammarEngine offset normalization, and the
 * real Groq provider code path — only the outbound HTTP call to Groq is
 * mocked. No real network calls, no real API key needed.
 *
 * The ESM hook (lib/test/esm-hook.mjs) lets plain Node load the project's
 * ESM .js files without changing how Next.js builds them.
 */
const { register } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert');

register(pathToFileURL(path.join(__dirname, 'test', 'esm-hook.mjs')).href, pathToFileURL(__filename).href);

// Provider config read at request time by lib/ai — set before handlers run.
const MOCK_KEY = 'mock-groq-key-never-real';
process.env.AI_PROVIDER = 'groq';
process.env.GROQ_API_KEY = MOCK_KEY;
delete process.env.GROQ_MODEL; // exercise the provider's default model

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('PASS — ' + name);
    pass++;
  } catch (e) {
    console.log('FAIL — ' + name + '\n    ' + e.message);
    fail++;
  }
}

/* ---------------- helpers ---------------- */

const BASE = 'http://localhost:3000';

function makeRequest(routePath, body, ip) {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip || '10.0.0.1' };
  return new Request(BASE + routePath, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

/** Build a Response shaped like a successful Groq chat completions reply. */
function groqTextResponse(text) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'openai/gpt-oss-120b',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** One mock AI issue pointing at "dont" in the default test sentence. */
const TEST_TEXT = 'She dont like coffee. He is a honest man.';
function mockIssue(overrides) {
  return Object.assign({
    type: 'grammar', category: 'subject_verb_agreement', severity: 'medium',
    start: TEST_TEXT.indexOf('dont'), end: TEST_TEXT.indexOf('dont') + 4,
    original: 'dont', suggestion: "doesn't",
    explanation: 'Subject-verb agreement.', confidence: 0.95
  }, overrides || {});
}

let lastFetchCalls = [];
/**
 * Install a mocked fetch for the duration of `fn`, capturing every call.
 * `handler(url, init)` -> Response (or throws to simulate network failure).
 */
async function withMockedFetch(handler, fn) {
  const original = globalThis.fetch;
  lastFetchCalls = [];
  globalThis.fetch = async function (url, init) {
    lastFetchCalls.push({ url: String(url), init });
    return handler(url, init);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Run a route handler while capturing (and silencing) console.error. */
async function captureRouteErrors(fn) {
  const original = console.error;
  const lines = [];
  console.error = function () { lines.push(Array.from(arguments).map(String).join(' ')); };
  try {
    const res = await fn();
    return { res, lines };
  } finally {
    console.error = original;
  }
}

function assertNoKeyIn(text, label) {
  assert.ok(text.indexOf(MOCK_KEY) === -1, label + ': API key must never appear in ' + label);
}

let analyzeRoute, toneRoute, rewriteRoute, summarizeRoute;

async function runTests() {
  await test('analyze: success — issues normalized, invalid offsets and low confidence dropped server-side', async () => {
    const valid = mockIssue();
    const badOffset = mockIssue({ start: 5000, end: 5100, original: 'junk', suggestion: 'x' });
    const lowConf = mockIssue({ start: 4, end: 8, confidence: 0.3, original: 'dont' });
    await withMockedFetch(
      () => groqTextResponse(JSON.stringify([valid, badOffset, lowConf])),
      async () => {
        const res = await analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.1.0.1'));
        assert.strictEqual(res.status, 200, 'expected 200');
        const body = await res.json();
        assert.ok(Array.isArray(body.issues), 'issues must be an array');
        assert.strictEqual(body.issues.length, 1, 'only the valid, confident issue survives');
        assert.strictEqual(body.issues[0].category, 'subject_verb_agreement');
        assert.strictEqual(body.issues[0].suggestion, "doesn't");
        assert.strictEqual(body.truncatedAt, null);
      }
    );
  });

  await test('analyze: provider invoked with default model, key in Authorization header, JSON mode', async () => {
    await withMockedFetch(
      () => groqTextResponse(JSON.stringify([mockIssue()])),
      async () => {
        await analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.1.0.2'));
        assert.strictEqual(lastFetchCalls.length, 1, 'exactly one provider call');
        const { url, init } = lastFetchCalls[0];
        assert.ok(url.includes('/v1/chat/completions'), 'default endpoint in URL: ' + url);
        assert.ok(!url.includes(MOCK_KEY), 'key must not travel in the URL');
        assert.strictEqual(init.headers['Authorization'], 'Bearer ' + MOCK_KEY, 'auth header: ' + JSON.stringify(init.headers));
        const sent = JSON.parse(init.body);
        assert.strictEqual(sent.response_format.type, 'json_object', 'JSON mode on');
        assert.ok(sent.messages[1].content.includes(TEST_TEXT), 'user text present in prompt');
      }
    );
  });

  await test('analyze: missing text → 400 invalid_request', async () => {
    await withMockedFetch(() => { throw new Error('must not be called'); }, async () => {
      const res = await analyzeRoute.POST(makeRequest('/api/analyze', {}, '10.1.0.3'));
      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error, 'invalid_request');
    });
  });

  await test('analyze: wrong input type (text: 123) → 400', async () => {
    await withMockedFetch(() => { throw new Error('must not be called'); }, async () => {
      const res = await analyzeRoute.POST(makeRequest('/api/analyze', { text: 123 }, '10.1.0.4'));
      assert.strictEqual(res.status, 400);
      assert.strictEqual((await res.json()).error, 'invalid_request');
    });
  });

  await test('analyze: invalid JSON body → 400', async () => {
    await withMockedFetch(() => { throw new Error('must not be called'); }, async () => {
      const res = await analyzeRoute.POST(makeRequest('/api/analyze', '{not json', '10.1.0.5'));
      assert.strictEqual(res.status, 400);
      assert.strictEqual((await res.json()).error, 'invalid_request');
    });
  });

  await test('analyze: oversized text (> 20000 chars) → 400, provider never called', async () => {
    await withMockedFetch(() => { throw new Error('must not be called'); }, async () => {
      const res = await analyzeRoute.POST(makeRequest('/api/analyze', { text: 'a'.repeat(20001) }, '10.1.0.6'));
      assert.strictEqual(res.status, 400);
      assert.strictEqual(lastFetchCalls.length, 0, 'validation must short-circuit before the provider');
    });
  });

  await test('analyze: rate limit → 429 on the 31st request in one window', async () => {
    await withMockedFetch(
      () => groqTextResponse(JSON.stringify([mockIssue()])),
      async () => {
        const ip = '10.2.9.9';
        let last;
        for (let i = 0; i < 30; i++) {
          last = await analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, ip));
          await last.json();
          assert.ok(last.status === 200, 'request ' + (i + 1) + ' should pass, got ' + last.status);
        }
        const blocked = await analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, ip));
        assert.strictEqual(blocked.status, 429);
        assert.strictEqual((await blocked.json()).error, 'rate_limited');
      }
    );
  });

  await test('analyze: provider auth failure (401) → 502 ai_unavailable, no key or raw error leaked', async () => {
    const { res, lines } = await captureRouteErrors(() =>
      withMockedFetch(
        () => new Response(JSON.stringify({ error: { message: 'Invalid API key.', type: 'authentication_error' } }), { status: 401, headers: { 'content-type': 'application/json' } }),
        () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.3.0.1'))
      )
    );
    assert.strictEqual(res.status, 502);
    const body = await res.json();
    assert.strictEqual(body.error, 'ai_unavailable');
    assert.ok(!('issues' in body), 'no partial data on failure');
    const bodyText = JSON.stringify(body);
    assertNoKeyIn(bodyText, 'response body');
    for (const line of lines) assertNoKeyIn(line, 'server-side log');
  });

  await test('analyze: provider 429 → HTTP 429 with the route\'s existing ai_unavailable body convention', async () => {
    // Existing route contract (unchanged): provider-side rate limiting is
    // signalled by the 429 STATUS; the body stays error:"ai_unavailable" —
    // body error:"rate_limited" is reserved for the in-app limiter (test above).
    const { res } = await captureRouteErrors(() =>
      withMockedFetch(
        () => new Response(JSON.stringify({ error: { message: 'Rate limit reached.', type: 'rate_limit_error' } }), { status: 429, headers: { 'content-type': 'application/json' } }),
        () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.3.0.2'))
      )
    );
    assert.strictEqual(res.status, 429);
    assert.strictEqual((await res.json()).error, 'ai_unavailable');
  });

  await test('analyze: malformed provider text (not JSON) → 502 ai_unavailable', async () => {
    const { res } = await captureRouteErrors(() =>
      withMockedFetch(
        () => groqTextResponse('this is definitely not JSON'),
        () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.3.0.3'))
      )
    );
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.json()).error, 'ai_unavailable');
  });

  await test('analyze: provider wraps its issues array in a JSON object → still 200 (tolerant extraction)', async () => {
    const { res } = await captureRouteErrors(() =>
      withMockedFetch(
        () => groqTextResponse(JSON.stringify({ issues: [mockIssue()] })),
        () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.3.0.4'))
      )
    );
    assert.strictEqual(res.status, 200, 'object-wrapped issue arrays are extracted, not 502\u2019d');
    const body = await res.json();
    assert.ok(Array.isArray(body.issues), 'issues array present');
    assert.strictEqual(body.issues.length, 1);
    assert.strictEqual(body.issues[0].category, 'subject_verb_agreement');
  });

  await test('analyze: provider returns an object with no array at all → 502', async () => {
    const { res } = await captureRouteErrors(() =>
      withMockedFetch(
        () => groqTextResponse(JSON.stringify({ summary: 'no issues here' })),
        () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.3.0.4b'))
      )
    );
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.json()).error, 'ai_unavailable');
  });

  await test('analyze: one transient bad format is retried once and recovers → 200', async () => {
    let calls = 0;
    const { res } = await captureRouteErrors(() =>
      withMockedFetch(
        () => {
          calls++;
          return calls === 1
            ? groqTextResponse(JSON.stringify({ summary: 'model had a bad day' }))
            : groqTextResponse(JSON.stringify([mockIssue()]));
        },
        () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.3.0.7'))
      )
    );
    assert.strictEqual(res.status, 200, 'second-attempt success must surface, not 502');
    assert.strictEqual((await res.json()).issues.length, 1);
    assert.strictEqual(calls, 2, 'exactly one retry, not more');
  });

  await test('analyze: unparseable JSON then success on retry → 200', async () => {
    let calls = 0;
    const { res } = await captureRouteErrors(() =>
      withMockedFetch(
        () => {
          calls++;
          return groqTextResponse(calls === 1 ? '{{{not json at all' : JSON.stringify([mockIssue()]));
        },
        () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.3.0.8'))
      )
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls, 2);
  });

  await test('analyze: provider 429 is NEVER retried (no TPM burn), exactly one call', async () => {
    let calls = 0;
    const { res } = await captureRouteErrors(() =>
      withMockedFetch(
        () => {
          calls++;
          return new Response(JSON.stringify({ error: { message: 'Rate limit reached.' } }), { status: 429, headers: { 'content-type': 'application/json' } });
        },
        () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.3.0.9'))
      )
    );
    assert.strictEqual(res.status, 429);
    assert.strictEqual(calls, 1, 'rate limits must not be retried');
  });

  await test('analyze: persistent bad format fails after the single retry → 502, two calls', async () => {
    let calls = 0;
    const { res } = await captureRouteErrors(() =>
      withMockedFetch(
        () => {
          calls++;
          return groqTextResponse(JSON.stringify({ nope: 'still not an array' }));
        },
        () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.3.0.10'))
      )
    );
    assert.strictEqual(res.status, 502);
    assert.strictEqual(calls, 2, 'one retry maximum');
  });

  await test('analyze: empty provider response (no choices) → 502', async () => {
    const { res } = await captureRouteErrors(() =>
      withMockedFetch(
        () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
        () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.3.0.5'))
      )
    );
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.json()).error, 'ai_unavailable');
  });

  await test('analyze: network failure (fetch throws) → 502 ai_unavailable, app does not crash', async () => {
    const { res } = await captureRouteErrors(() =>
      withMockedFetch(
        () => { throw new Error('ECONNREFUSED simulated'); },
        () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.3.0.6'))
      )
    );
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.json()).error, 'ai_unavailable');
  });

  await test('tone: success → 200 with Zod-validated tone object', async () => {
    await withMockedFetch(
      () => groqTextResponse(JSON.stringify({ primary: 'joyful', traits: [{ name: 'Friendly', score: 90 }], note: 'Reads as upbeat.' })),
      async () => {
        const res = await toneRoute.POST(makeRequest('/api/tone', { text: 'I am so happy about this news!' }, '10.4.0.1'));
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.primary, 'joyful');
        assert.strictEqual(body.traits[0].name, 'Friendly');
        assert.strictEqual(typeof body.note, 'string');
      }
    );
  });

  await test('tone: provider returns invalid shape (primary: 123) → 502 invalid_ai_response', async () => {
    const { res } = await captureRouteErrors(() =>
      withMockedFetch(
        () => groqTextResponse(JSON.stringify({ primary: 123, traits: [], note: '' })),
        () => toneRoute.POST(makeRequest('/api/tone', { text: 'hello' }, '10.4.0.2'))
      )
    );
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.json()).error, 'invalid_ai_response');
  });

  await test('tone: 0-1 scale trait scores are rescaled to 0-100, not rejected', async () => {
    await withMockedFetch(
      () => groqTextResponse(JSON.stringify({ primary: 'calm', traits: [{ name: 'Formal', score: 0.8 }, { name: 'Casual', score: 0.25 }], note: '' })),
      async () => {
        const res = await toneRoute.POST(makeRequest('/api/tone', { text: 'hello' }, '10.4.0.3'));
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.traits[0].score, 80);
        assert.strictEqual(body.traits[1].score, 25);
      }
    );
  });

  await test('tone: extra traits are capped and over-range scores clamped (graceful, not 502)', async () => {
    const traits = ['A','B','C','D','E','F','G','H','I'].map((n, i) => ({ name: n, score: i === 0 ? 150 : 10 + i }));
    await withMockedFetch(
      () => groqTextResponse(JSON.stringify({ primary: 'mixed', traits, note: '' })),
      async () => {
        const res = await toneRoute.POST(makeRequest('/api/tone', { text: 'hello' }, '10.4.0.4'));
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.ok(body.traits.length <= 6, 'traits capped at 6, got ' + body.traits.length);
        assert.strictEqual(body.traits[0].score, 100, 'over-range score clamped');
      }
    );
  });

  await test('tone: rambling note is truncated to the contract length, not rejected', async () => {
    await withMockedFetch(
      () => groqTextResponse(JSON.stringify({ primary: 'neutral', traits: [], note: 'x'.repeat(500) })),
      async () => {
        const res = await toneRoute.POST(makeRequest('/api/tone', { text: 'hello' }, '10.4.0.5'));
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.note.length, 300);
      }
    );
  });

  await test('rewrite: success → 200 { text }', async () => {
    await withMockedFetch(
      () => groqTextResponse('She does not like coffee, and he is an honest man.'),
      async () => {
        const res = await rewriteRoute.POST(makeRequest('/api/rewrite', { text: TEST_TEXT, style: 'improve' }, '10.5.0.1'));
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(typeof body.text, 'string');
        assert.ok(body.text.length > 0);
      }
    );
  });

  await test('rewrite: unsupported style → 400 before any provider call', async () => {
    await withMockedFetch(() => { throw new Error('must not be called'); }, async () => {
      const res = await rewriteRoute.POST(makeRequest('/api/rewrite', { text: TEST_TEXT, style: 'yell' }, '10.5.0.2'));
      assert.strictEqual(res.status, 400);
      assert.strictEqual(lastFetchCalls.length, 0);
    });
  });

  await test('summarize: success → 200 { text }', async () => {
    await withMockedFetch(
      () => groqTextResponse('Two small errors about coffee and honesty.'),
      async () => {
        const res = await summarizeRoute.POST(makeRequest('/api/summarize', { text: TEST_TEXT }, '10.6.0.1'));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(typeof (await res.json()).text, 'string');
      }
    );
  });

  await test('CORS: OPTIONS preflight → 204 with permissive local headers', async () => {
    const res = await analyzeRoute.OPTIONS();
    assert.strictEqual(res.status, 204);
    assert.ok(res.headers.get('access-control-allow-origin'));
    assert.ok(res.headers.get('access-control-allow-methods').includes('POST'));
  });

  await test('provider selection is deterministic: groq and gemini both expose the full AI interface, unknown → throws', async () => {
    const aiIndex = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'ai', 'index.js')).href);
    const prev = process.env.AI_PROVIDER;
    try {
      process.env.AI_PROVIDER = 'groq';
      const asGroq = aiIndex.getProvider();
      ['analyzeGrammar', 'analyzeClarity', 'analyzeTone', 'rewriteText', 'summarizeText'].forEach((m) =>
        assert.strictEqual(typeof asGroq[m], 'function', 'groq chain exposes ' + m)
      );
      process.env.AI_PROVIDER = 'gemini';
      const asGemini = aiIndex.getProvider();
      ['analyzeGrammar', 'analyzeClarity', 'analyzeTone', 'rewriteText', 'summarizeText'].forEach((m) =>
        assert.strictEqual(typeof asGemini[m], 'function', 'gemini chain exposes ' + m)
      );
      process.env.AI_PROVIDER = 'ollama';
      assert.throws(() => aiIndex.getProvider(), /Unknown AI_PROVIDER/);
    } finally {
      process.env.AI_PROVIDER = prev;
    }
  });

  await test('fallback: Groq 429 → Gemini attempted → Gemini success returned (one Groq call, one Gemini call)', async () => {
    const prevProvider = process.env.AI_PROVIDER;
    const prevGeminiKey = process.env.GEMINI_API_KEY;
    process.env.AI_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = MOCK_KEY;
    process.env.GEMINI_API_KEY = 'mock-gemini-key-never-real';
    try {
      let groqCalls = 0, geminiCalls = 0;
      const { res } = await captureRouteErrors(() =>
        withMockedFetch(
          (url) => {
            if (String(url).indexOf('api.groq.com') !== -1) {
              groqCalls++;
              return new Response(JSON.stringify({ error: { message: 'Rate limit reached.' } }), { status: 429, headers: { 'content-type': 'application/json' } });
            }
            geminiCalls++;
            return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify([mockIssue()]) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
          },
          () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '11.1.0.1'))
        )
      );
      assert.strictEqual(res.status, 200, 'Gemini success after Groq 429 must surface');
      assert.strictEqual((await res.json()).issues.length, 1);
      assert.strictEqual(groqCalls, 1, 'Groq 429 is not retried on Groq');
      assert.strictEqual(geminiCalls, 1, 'exactly one Gemini attempt (no loop)');
    } finally {
      process.env.AI_PROVIDER = prevProvider;
      if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevGeminiKey;
    }
  });

  await test('fallback: both providers fail (Groq 429, Gemini 5xx) → provider-429 status preserved on ai_unavailable', async () => {
    const prevProvider = process.env.AI_PROVIDER;
    const prevGeminiKey = process.env.GEMINI_API_KEY;
    process.env.AI_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = MOCK_KEY;
    process.env.GEMINI_API_KEY = 'mock-gemini-key-never-real';
    try {
      const { res } = await captureRouteErrors(() =>
        withMockedFetch(
          (url) => new Response(JSON.stringify({ error: { message: 'upstream down' } }), { status: String(url).indexOf('api.groq.com') !== -1 ? 429 : 503, headers: { 'content-type': 'application/json' } }),
          () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '11.1.0.2'))
        )
      );
      assert.strictEqual(res.status, 429, 'when the primary hit its own 429, the standardized status stays 429 even after the secondary also failed');
      assert.strictEqual((await res.json()).error, 'ai_unavailable');
    } finally {
      process.env.AI_PROVIDER = prevProvider;
      if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevGeminiKey;
    }
  });

  await test('no fallback for invalid user input: 400 invalid_request → exactly zero provider calls', async () => {
    const prevProvider = process.env.AI_PROVIDER;
    const prevGeminiKey = process.env.GEMINI_API_KEY;
    process.env.AI_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = MOCK_KEY;
    process.env.GEMINI_API_KEY = 'mock-gemini-key-never-real';
    try {
      await withMockedFetch(() => { throw new Error('provider must never be called'); }, async () => {
        const res = await analyzeRoute.POST(makeRequest('/api/analyze', { text: 42 }, '11.2.0.1'));
        assert.strictEqual(res.status, 400);
        assert.strictEqual((await res.json()).error, 'invalid_request');
      });
    } finally {
      process.env.AI_PROVIDER = prevProvider;
      if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevGeminiKey;
    }
  });

  await test('fallback never alternates: total provider calls per request ≤ 2', async () => {
    const prevProvider = process.env.AI_PROVIDER;
    const prevGeminiKey = process.env.GEMINI_API_KEY;
    process.env.AI_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = MOCK_KEY;
    process.env.GEMINI_API_KEY = 'mock-gemini-key-never-real';
    try {
      let calls = 0;
      await captureRouteErrors(() =>
        withMockedFetch(
          () => {
            calls++;
            return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503, headers: { 'content-type': 'application/json' } });
          },
          () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '11.3.0.1'))
        )
      );
      assert.ok(calls <= 2, 'at most primary + one secondary attempt, got ' + calls);
    } finally {
      process.env.AI_PROVIDER = prevProvider;
      if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevGeminiKey;
    }
  });

  await test('unconfigured secondary key does not mask the real failure: Groq 503 with no Gemini key → 502 from the Groq error', async () => {
    const prevProvider = process.env.AI_PROVIDER;
    const prevGeminiKey = process.env.GEMINI_API_KEY;
    process.env.AI_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = MOCK_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    try {
      const { res } = await captureRouteErrors(() =>
        withMockedFetch(
          () => new Response(JSON.stringify({ error: { message: 'upstream down' } }), { status: 503, headers: { 'content-type': 'application/json' } }),
          () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '11.4.0.1'))
        )
      );
      assert.strictEqual(res.status, 502, 'the original 503-class provider failure is what surfaces');
      assert.strictEqual((await res.json()).error, 'ai_unavailable');
    } finally {
      process.env.AI_PROVIDER = prevProvider;
      if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevGeminiKey;
    }
  });

  await test('gemini path: analyze works end-to-end with the real Gemini provider code', async () => {
    const prev = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'mock-gemini-key-never-real';
    try {
      await withMockedFetch(
        () => new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify([mockIssue()]) }] } }]
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
        async () => {
          const res = await analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.8.0.1'));
          assert.strictEqual(res.status, 200);
          const body = await res.json();
          assert.strictEqual(body.issues.length, 1);
          assert.strictEqual(body.issues[0].suggestion, "doesn't");
          const { url, init } = lastFetchCalls[0];
          assert.ok(url.includes('generativelanguage.googleapis.com'), 'Gemini endpoint: ' + url);
          assert.ok(!url.includes('mock-gemini-key'), 'key must not travel in the URL');
          assert.strictEqual(init.headers['x-goog-api-key'], 'mock-gemini-key-never-real', 'key in header');
          assert.ok(!JSON.stringify(init.body).includes('mock-gemini-key'), 'key must not be in the body');
        }
      );
    } finally {
      process.env.AI_PROVIDER = prev;
      process.env.GEMINI_API_KEY = 'real-key-was-here'; // restored below
    }
    // restore whatever the process had (tests run without real keys)
    delete process.env.GEMINI_API_KEY;
  });

  await test('gemini path: non-array model output → 502 ai_unavailable', async () => {
    const prev = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'mock-gemini-key-never-real';
    try {
      const { res } = await captureRouteErrors(() =>
        withMockedFetch(
          () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'just prose' }] } }] }), { status: 200 }),
          () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.8.0.2'))
        )
      );
      assert.strictEqual(res.status, 502);
      assert.strictEqual((await res.json()).error, 'ai_unavailable');
    } finally {
      process.env.AI_PROVIDER = prev;
      delete process.env.GEMINI_API_KEY;
    }
  });

  await test('security: no response anywhere echoes the configured provider key', async () => {
    // Re-run a success + the 401 path and scan every response body captured.
    await withMockedFetch(
      () => groqTextResponse(JSON.stringify([mockIssue()])),
      async () => {
        const ok = await analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.7.0.1'));
        assertNoKeyIn(JSON.stringify(await ok.json()), 'success response');
      }
    );
    const { res } = await captureRouteErrors(() =>
      withMockedFetch(
        () => new Response(JSON.stringify({ error: { message: 'Forbidden' } }), { status: 403, headers: { 'content-type': 'application/json' } }),
        () => analyzeRoute.POST(makeRequest('/api/analyze', { text: TEST_TEXT }, '10.7.0.2'))
      )
    );
    assertNoKeyIn(JSON.stringify(await res.json()), 'failure response');
  });
}

(async function main() {
  // Import the real route handlers through the ESM hook.
  const load = (p) => import(pathToFileURL(path.join(__dirname, '..', p)).href);
  [analyzeRoute, toneRoute, rewriteRoute, summarizeRoute] = await Promise.all([
    load('app/api/analyze/route.js'),
    load('app/api/tone/route.js'),
    load('app/api/rewrite/route.js'),
    load('app/api/summarize/route.js')
  ]);
  await runTests();
  console.log('\nTOTAL: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch(function (e) {
  console.error('FATAL — could not load route handlers: ' + (e && e.message));
  process.exit(1);
});
