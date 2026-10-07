# Lunik Write

A free AI-powered writing assistant for improving grammar, clarity, tone,
readability, and overall writing quality.

Type as you write. Local rules catch spelling, punctuation, and simple grammar
issues instantly. The AI layer handles the contextual stuff — style, tone,
rewriting, and the grammar problems that rules alone can't solve.

## Features

- Local grammar, spelling, and punctuation checking
- AI-powered contextual grammar, clarity, and style analysis
- Tone analysis
- AI rewriting in several styles: improve, shorten, expand, simplify, formal,
  casual, persuasive
- Readability stats: Flesch reading ease, grade level, words per sentence,
  letters per word, complex-word ratio, reading time
- Writing health overview built from correctness, clarity, variety, and
  readability
- Accept or ignore suggestions; add words to a personal dictionary
- Multiple documents, saved in the browser
- Export to `.txt`, `.md`, or `.html`, or copy the text to the clipboard
- US/UK spelling variant toggle
- Light and dark mode
- Responsive editor with keyboard-friendly shortcuts

## Tech stack

- Next.js 14 (App Router) + React 18
- TypeScript for the app/UI code
- The shared grammar engine and API-layer code are plain JavaScript on
  purpose, so the same engine can be reused elsewhere; type info lives in
  the `.d.ts` files next to them
- CSS custom properties for theming; Tailwind is configured in the project
- Zod for request/response validation
- AI provider abstraction in `lib/ai/` with two supported cloud providers:
  - **Groq** — primary, default (`GROQ_API_KEY`)
  - **Google Gemini** — secondary, optional (`GEMINI_API_KEY` or
    `GOOGLE_AI_API_KEY`)
- All AI calls are server-side only — keys never reach the browser

## Architecture

```
Editor (React, client component)
  ↓
GrammarEngine.findLocalIssues()        — instant, on-device, free
  ↓ (debounced, cancels stale requests)
POST /api/analyze
  ↓
Zod request validation
  ↓
In-memory rate limiter
  ↓
AI provider (lib/ai — Groq by default, swappable via AI_PROVIDER)
  ↓
GrammarEngine.normalizeAIIssues()      — offsets validated server-side
  ↓
GrammarEngine.mergeIssues()            — combines local + AI, drops duplicates
  ↓
Editor
```

The app never calls a provider directly. It always goes through
`lib/ai/index.js` → `getProvider()`, so the active provider is chosen once at
the top of the request and the rest of the app stays provider-agnostic.

Local rules handle the deterministic stuff: spelling, basic grammar,
punctuation, readability math, word/sentence stats, and offset validation.
AI is used only for contextual intelligence: rewrites, tone, contextual
grammar, and summarization.

There is no local AI provider and no Ollama dependency. All AI calls go to a
cloud provider, so the app works on Vercel and when the user's computer is
turned off.

## Local development

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

The first run will start with AI features inactive until you add API keys.
See [Environment variables](#environment-variables) and
[AI provider setup](#ai-provider-setup).

## Environment variables

Copy `.env.example` to `.env.local` and fill in the values you need.
`.env.local` is git-ignored and must never be committed.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AI_PROVIDER` | no | `groq` | `groq` or `gemini` |
| `GROQ_API_KEY` | yes, if using Groq | — | Groq API key |
| `GROQ_MODEL` | no | `openai/gpt-oss-120b` | Groq model |
| `GEMINI_API_KEY` | yes, if using Gemini | — | Official Google AI Studio key |
| `GOOGLE_AI_API_KEY` | yes, if using Gemini and `GEMINI_API_KEY` is unset | — | Alias for the same key |
| `GEMINI_MODEL` | no | `gemini-3.5-flash-lite` | Gemini model |
| `ALLOWED_ORIGIN` | no | `*` | CORS origin; set to your deployed domain in production |

Optional placeholders that are not used by the current app:

- `DATABASE_URL`
- `NEXTAUTH_SECRET`

Those are reserved for a future accounts + database layer. Documents currently
live in the browser's `localStorage` only.

## AI provider setup

### Groq (default)

1. Get a Groq API key from your Groq account dashboard.
2. Copy `.env.example` to `.env.local`.
3. Set `GROQ_API_KEY`.
4. Optionally set `GROQ_MODEL` if you want a different model.

The default model is `openai/gpt-oss-120b`.

### Gemini (optional secondary provider)

1. Get a Google AI Studio API key.
2. Copy `.env.example` to `.env.local`.
3. Set `GEMINI_API_KEY`, or set `GOOGLE_AI_API_KEY` if you prefer that
   variable name.
4. Optionally set `GEMINI_MODEL` if you want a different model.
5. Set `AI_PROVIDER=gemini` to switch the app to Gemini.

The default model is `gemini-3.5-flash-lite`.

### Switching providers

Set `AI_PROVIDER=groq` or `AI_PROVIDER=gemini`. There is no automatic
fallback between providers. If the configured provider is unavailable, the
route returns a safe `ai_unavailable` error and the app stays usable for
local checks.

## API

The app exposes these server-side routes:

- `POST /api/analyze` — contextual grammar/clarity/style issues
- `POST /api/tone` — tone analysis
- `POST /api/rewrite` — rewrite a selected snippet in a chosen style
- `POST /api/summarize` — short summary of the input text

All routes validate input with Zod, apply server-side offset validation to AI
output, and return safe error shapes when the AI provider is unavailable.

## Privacy

- Local checks stay on the device.
- When AI features are used, the user's text is sent to the configured cloud
  provider.
- API keys are read server-side only and are never included in browser bundles
  or API responses.

## Security notes

- API keys are server-side only.
- AI output is treated as untrusted. Offsets are validated against the real
  text before anything is highlighted or applied.
- Input is validated with Zod on every route.
- Request sizes are capped in the route schemas.
- Rate limiting is currently in-memory and per-instance. It is fine for a
  first deploy, but should be moved to a shared store before heavy public
  traffic.
- Authentication is not implemented yet. Routes are rate-limited, not gated.

## Running the verification checks

Type checking:

```bash
npx tsc --noEmit
```

Linting:

```bash
npm run lint
```

Test suites:

```bash
npm test
```

That runs:

- `npm run test:engine` — grammar engine tests
- `npm run test:health` — writing health tests
- `npm run test:api` — API route tests
- `npm run test:matrix` — product matrix tests

Or run any suite directly, for example:

```bash
node lib/grammar-engine.test.js
node lib/writing-health.test.js
node lib/api-routes.test.js
node lib/product-matrix.test.js
```

## Production build

```bash
npm run build
npm start
```

## Deployment

The app is a standard Next.js app and deploys to Vercel as usual.

Before deploying:

- Confirm `npm install && npm run build` succeeds locally.
- Add the required environment variables to the Vercel project, not to the
  repository.
- For Groq: set `GROQ_API_KEY` and optionally `GROQ_MODEL` and
  `AI_PROVIDER`.
- For Gemini: set `GEMINI_API_KEY` or `GOOGLE_AI_API_KEY`, and set
  `AI_PROVIDER=gemini` if you want Gemini as the active provider.
- Set `ALLOWED_ORIGIN` to the real deployed domain before switching off the
  open `*` default.

All API routes that use `process.env` declare `runtime = 'nodejs'`, so they
run in the Node runtime rather than the Edge runtime.

Do not commit real API keys to GitHub. They belong only in Vercel
environment variables or a local `.env.local` that stays git-ignored.

## Project structure

```
app/
  api/            # Next.js API routes: analyze, tone, rewrite, summarize
  globals.css     # app styles and theme tokens
  layout.tsx      # root layout
  page.tsx        # main editor page
components/
  WritingEditor.tsx   # main editor and AI-assistant UI
lib/
  ai/            # provider abstraction + Groq and Gemini providers
  grammar-engine.js   # local rules + normalization + merge logic
  writing-health.js   # writing health scoring
  design-system.js    # labels, filenames, helpers
  schemas.js          # Zod request/response schemas
  rate-limit.js       # in-memory per-instance rate limiter
  cors.js             # CORS helpers
  api-client.js       # fetch wrapper for calling the app's own API
  *.test.js           # test suites
```

## Author

Built by Sakib Reza.

## License

License decision pending.
