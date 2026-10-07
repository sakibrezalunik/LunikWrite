import type { Config } from 'tailwindcss';

// Tailwind is configured and available for new UI work, but the editor's
// existing look (ported from the tested claude.ai prototype) intentionally
// stays as hand-written CSS custom properties in app/globals.css rather than
// being rewritten into utility classes blind — see the README for why.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {}
  },
  plugins: []
};

export default config;
