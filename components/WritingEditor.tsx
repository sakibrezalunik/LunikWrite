'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GrammarEngine, { Issue } from '@/lib/grammar-engine';
import WritingHealth, { HealthResult } from '@/lib/writing-health';
import { ISSUE_TYPES, REWRITE_STYLES, TONE_PRIMARY, labelize, sanitizedFilename } from '@/lib/design-system';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

type Variant = 'US' | 'UK';
type IssueType = 'grammar' | 'spelling' | 'punctuation' | 'clarity' | 'style';
type ActiveTypes = Record<IssueType, boolean>;
type TabKey = 'suggestions' | 'tone' | 'readability';
type CheckState = 'idle' | 'running' | 'done' | 'error';

interface DocRecord {
  id: string;
  title: string;
  content: string;
  updatedAt: number;
}

interface ToneResult {
  primary: string;
  traits: { name: string; score: number }[];
  note: string;
}

const DEFAULT_TEXT =
  'Lunik Write checks your writing as you type. It catches things like a extra space, a mispelled word, ' +
  'and grammar slips such as she don’t notice repeated the the words. correct sentences, like this one, ' +
  'are left alone — so you only see suggestions where they matter.';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota errors */
  }
}

/** Map an issue's severity onto the design-system badge colors. */
function severityBadge(sev: string): string {
  if (sev === 'high') return 'badge badge-warn';
  if (sev === 'medium') return 'badge badge-accent';
  return 'badge badge-ghost';
}

/**
 * Issues the user explicitly ignored are keyed by content signature —
 * type|original|suggestion — so "Ignore" sticks across keystrokes, offset
 * shifts, and re-scans without ever matching a different fix.
 */
function issueSignature(i: Issue): string {
  return i.type + '|' + i.original + '|' + i.suggestion;
}

function dropIgnored(list: Issue[], ignored: Set<string>): Issue[] {
  return list.filter((i) => !ignored.has(issueSignature(i)));
}

export default function WritingEditor() {
  const [activeTypes, setActiveTypes] = useState<Record<string, boolean>>({
    grammar: true,
    spelling: true,
    punctuation: true,
    clarity: true,
    style: true
  });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const latestTextRef = useRef('');
  const localIssuesRef = useRef<Issue[]>([]);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Issues the user explicitly ignored, by content signature (type|original|
  // suggestion). Without this, every keystroke re-ran the local engine and
  // resurrected ignored suggestions — "Ignore" must stick while editing.
  const ignoredRef = useRef<Set<string>>(new Set());

  const [ready, setReady] = useState(false);
  const [text, setText] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);

  const [variant, setVariant] = useState<Variant>('US');
  const [personalDict, setPersonalDict] = useState<string[]>([]);
  const [docs, setDocs] = useState<DocRecord[]>([]);
  const [activeDocId, setActiveDocId] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('suggestions');
  const [aiStatus, setAiStatus] = useState<'idle' | 'thinking' | 'error'>('idle');
  const [aiError, setAiError] = useState('');
  const [toast, setToast] = useState('');
  const [suggestionsFixed, setSuggestionsFixed] = useState(0);
  const [docsOpen, setDocsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const visibleIssues = issues.filter((i) => activeTypes[i.type]);

  const backdropHtml = useMemo(() => {
    const sorted = [...visibleIssues].sort((a, b) => a.start - b.start);
    let html = '';
    let pos = 0;
    for (const iss of sorted) {
      if (iss.start < pos) continue;
      if (iss.start > pos) html += escapeHtml(text.slice(pos, iss.start));
      html += `<mark class="highlight">${escapeHtml(text.slice(iss.start, iss.end))}</mark>`;
      pos = iss.end;
    }
    html += escapeHtml(text.slice(pos));
    return html + '\n';
  }, [text, visibleIssues]);

  const [toneResult, setToneResult] = useState<ToneResult | null>(null);
  const [toneLoading, setToneLoading] = useState(false);

  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriteSelection, setRewriteSelection] = useState<{ start: number; end: number; text: string } | null>(null);
  const [rewriteStyle, setRewriteStyle] = useState<string | null>(null);
  const [rewriteOutput, setRewriteOutput] = useState('');
  const [rewriteLoading, setRewriteLoading] = useState(false);
  const [rewriteError, setRewriteError] = useState('');

  // Explicit "Check writing" lifecycle, shared with the debounced auto-check.
  const [checkState, setCheckState] = useState<CheckState>('idle');
  const [checkError, setCheckError] = useState('');

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 2200);
  }, []);



  // Motion is decorative only: honor the OS reduced-motion preference by
  // collapsing every transition to zero duration.
  const reduceMotion = useReducedMotion();
  const mt = useCallback(
    (d: number) => (reduceMotion ? { duration: 0 } : { duration: d, ease: 'easeOut' as const }),
    [reduceMotion]
  );

  /* ---------------- boot: load everything from localStorage once ---------------- */
  useEffect(() => {
    const savedDict = loadJSON<string[]>('lunik_dict', []);
    const savedVariantRaw = window.localStorage.getItem('lunik_variant');
    const savedVariant: Variant = savedVariantRaw === 'UK' ? 'UK' : 'US';
    const savedStats = loadJSON<{ suggestionsFixed: number }>('lunik_stats', { suggestionsFixed: 0 });
    const savedTheme = window.localStorage.getItem('lunik_theme') as 'light' | 'dark' | null;

    let savedDocs = loadJSON<DocRecord[]>('lunik_documents', []);
    if (!savedDocs.length) {
      savedDocs = [{ id: 'doc-' + Date.now(), title: 'Untitled document', content: DEFAULT_TEXT, updatedAt: Date.now() }];
    }
    let savedActiveId = window.localStorage.getItem('lunik_active_doc') || '';
    if (!savedDocs.some((d) => d.id === savedActiveId)) savedActiveId = savedDocs[0].id;

    setPersonalDict(savedDict);
    setVariant(savedVariant);
    setSuggestionsFixed(savedStats.suggestionsFixed || 0);
    if (savedTheme) setTheme(savedTheme);
    setDocs(savedDocs);
    setActiveDocId(savedActiveId);
    const initialText = savedDocs.find((d) => d.id === savedActiveId)?.content ?? '';
    setText(initialText);
    latestTextRef.current = initialText;
    localIssuesRef.current = GrammarEngine.findLocalIssues(initialText, savedVariant, savedDict);
    setIssues(GrammarEngine.mergeIssues(dropIgnored(localIssuesRef.current, ignoredRef.current), []));
    setReady(true);
  }, []);

  useEffect(() => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }, [theme]);

  useEffect(() => {
    if (!ready || !docs.length) return;
    saveJSON('lunik_documents', docs);
    if (activeDocId) window.localStorage.setItem('lunik_active_doc', activeDocId);
  }, [docs, activeDocId, ready]);

  useEffect(() => {
    if (!ready) return;
    saveJSON('lunik_dict', personalDict);
  }, [personalDict, ready]);

  useEffect(() => {
    if (!ready) return;
    window.localStorage.setItem('lunik_variant', variant);
  }, [variant, ready]);

  useEffect(() => {
    if (!ready) return;
    saveJSON('lunik_stats', { suggestionsFixed });
  }, [suggestionsFixed, ready]);

  // keep the active document's stored content in sync as the user types
  useEffect(() => {
    if (!ready || !activeDocId) return;
    latestTextRef.current = text;
    setDocs((prev) => prev.map((d) => (d.id === activeDocId ? { ...d, content: text, updatedAt: Date.now() } : d)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, ready]);

  /* ---------------- analysis pipeline ---------------- */
  const runAnalysis = useCallback(async (value: string, manual = false) => {
    if (!value.trim()) {
      setAiStatus('idle');
      setCheckState('idle');
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAiStatus('thinking');
    setAiError('');
    // The banner lifecycle is manual-check only — debounced background checks
    // must not flash "Checking…"/"Check complete" on every keystroke pause.
    if (manual) {
      setCheckState('running');
      setCheckError('');
    }
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: value }),
        signal: controller.signal
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || 'AI analysis failed.');
      if (latestTextRef.current !== value) return; // editor moved on — discard this stale response
      setIssues(GrammarEngine.mergeIssues(dropIgnored(localIssuesRef.current, ignoredRef.current), dropIgnored(data.issues || [], ignoredRef.current)));
      setAiStatus('idle');
      if (manual) setCheckState('done');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      const msg = e instanceof Error ? e.message : 'Could not analyze this text right now.';
      setAiStatus('error');
      setAiError(msg);
      // Auto-check failures surface quietly in the topbar status; the loud
      // banner is reserved for explicit user-initiated checks.
      if (manual) {
        setCheckState('error');
        setCheckError(msg);
      }
    }
  }, []);

  const scheduleAnalysis = useCallback(
    (value: string) => {
      const local = GrammarEngine.findLocalIssues(value, variant, personalDict);
      localIssuesRef.current = local;
      setIssues(GrammarEngine.mergeIssues(dropIgnored(local, ignoredRef.current), []));
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => runAnalysis(value), 800);
    },
    [variant, personalDict, runAnalysis]
  );

  // re-scan locally (and re-trigger AI) whenever the variant or personal dictionary changes
  useEffect(() => {
    if (!ready) return;
    scheduleAnalysis(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, personalDict, ready]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setText(value);
    // The "Check complete / check failed" banner describes a snapshot of a
    // past text — editing invalidates it.
    setCheckState((s) => (s === 'done' || s === 'error' ? 'idle' : s));
    scheduleAnalysis(value);
  }

  function handleScroll() {
    if (textareaRef.current && backdropRef.current) {
      backdropRef.current.scrollTop = textareaRef.current.scrollTop;
      backdropRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }

  function runCheckNow() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    runAnalysis(text, true);
  }

  /* ---------------- apply / ignore / dictionary ---------------- */
  function applyIssue(issue: Issue) {
    if (text.slice(issue.start, issue.end) !== issue.original) {
      setIssues((prev) => prev.filter((i) => i.id !== issue.id));
      return;
    }
    const before = text.slice(0, issue.start);
    const after = text.slice(issue.end);
    const newText = before + issue.suggestion + after;
    const delta = issue.suggestion.length - (issue.end - issue.start);

    setIssues((prev) =>
      prev
        .filter((i) => i.id !== issue.id)
        .map((i) => (i.start >= issue.end ? { ...i, start: i.start + delta, end: i.end + delta } : i))
        .filter((i) => newText.slice(i.start, i.end) === i.original)
    );
    setSuggestionsFixed((n) => n + 1);
    setCheckState((s) => (s === 'done' || s === 'error' ? 'idle' : s));
    setText(newText);
    scheduleAnalysis(newText);

    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        const caret = before.length + issue.suggestion.length;
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  function ignoreIssue(id: string) {
    const issue = issues.find((i) => i.id === id);
    if (issue) ignoredRef.current.add(issueSignature(issue));
    setIssues((prev) => prev.filter((i) => i.id !== id));
  }

  function addToDictionary(issue: Issue) {
    const w = issue.original.toLowerCase();
    ignoredRef.current.add(issueSignature(issue));
    setPersonalDict((prev) => (prev.includes(w) ? prev : [...prev, w]));
    setIssues((prev) => prev.filter((i) => i.id !== issue.id));
    showToast(`Added "${w}" to your dictionary`);
  }

  function removeFromDictionary(w: string) {
    setPersonalDict((prev) => prev.filter((x) => x !== w));
  }

  function toggleType(t: IssueType) {
    setActiveTypes((prev) => ({ ...prev, [t]: !prev[t] }));
  }

  /* ---------------- documents ---------------- */
  function switchDoc(id: string) {
    const doc = docs.find((d) => d.id === id);
    if (!doc) return;
    setActiveDocId(id);
    setText(doc.content);
    latestTextRef.current = doc.content;
    setIssues([]);
    setCheckState('idle');
    setCheckError('');
    setDeleteConfirmId(null);
    scheduleAnalysis(doc.content);
    setDocsOpen(false);
  }

  function newDocument() {
    const d: DocRecord = { id: 'doc-' + Date.now(), title: 'Untitled document', content: '', updatedAt: Date.now() };
    setDocs((prev) => [...prev, d]);
    setActiveDocId(d.id);
    setText('');
    latestTextRef.current = '';
    setIssues([]);
    setCheckState('idle');
    setCheckError('');
    showToast('New document created');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function duplicateDocument(id: string) {
    const src = docs.find((d) => d.id === id);
    if (!src) return;
    const copy: DocRecord = { id: 'doc-' + Date.now(), title: src.title + ' copy', content: src.content, updatedAt: Date.now() };
    setDocs((prev) => [...prev, copy]);
    showToast('Document duplicated');
  }

  function deleteDocument(id: string) {
    if (docs.length <= 1) {
      showToast('You need at least one document.');
      return;
    }
    if (deleteConfirmId !== id) {
      setDeleteConfirmId(id);
      return;
    }
    const wasActive = id === activeDocId;
    const remaining = docs.filter((d) => d.id !== id);
    setDocs(remaining);
    setDeleteConfirmId(null);
    if (wasActive) {
      const next = remaining[0];
      setActiveDocId(next.id);
      setText(next.content);
      latestTextRef.current = next.content;
      setIssues([]);
      setCheckState('idle');
      setCheckError('');
      scheduleAnalysis(next.content);
    }
    showToast('Document deleted');
  }

  function renameDocument(id: string, title: string) {
    setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, title: title || 'Untitled document', updatedAt: Date.now() } : d)));
  }

  /* ---------------- export ---------------- */
  function exportFile(ext: 'txt' | 'md' | 'html') {
    const title = (activeDocId ? docs.find((d) => d.id === activeDocId)?.title : 'document') || 'document';
    const filename = sanitizedFilename(title) + '.' + ext;
    let content = text;
    let mime = 'text/plain;charset=utf-8';
    if (ext === 'html') {
      const body = text
        .split(/\n{2,}/)
        .map((p) => '<p>' + escapeHtml(p).replace(/\n/g, '<br />') + '</p>')
        .join('\n');
      content =
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<title>' +
        escapeHtml(title) +
        '</title>\n</head>\n<body>\n' +
        body +
        '\n</body>\n</html>\n';
      mime = 'text/html;charset=utf-8';
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Saved ' + filename);
    setExportOpen(false);
  }

  function copyText() {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast('Copied'),
        () => showToast('Couldn’t copy')
      );
    }
    setExportOpen(false);
  }

  function openExport() {
    setExportOpen(true);
    setDocsOpen(false);
  }

  /* ---------------- AI / rewrite / tone ---------------- */
  async function analyzeTone() {
    if (!text.trim()) {
      showToast('Write something first.');
      return;
    }
    setActiveTab('tone');
    setToneLoading(true);
    try {
      const res = await fetch('/api/tone', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || 'Could not read the tone right now.');
      setToneResult(data);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not read the tone right now.');
    } finally {
      setToneLoading(false);
    }
  }

  function openRewrite() {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart, selectionEnd } = el;
    if (selectionStart === selectionEnd) {
      showToast('Select some text first.');
      return;
    }
    setRewriteSelection({ start: selectionStart, end: selectionEnd, text: text.slice(selectionStart, selectionEnd) });
    setRewriteStyle(null);
    setRewriteOutput('');
    setRewriteError('');
    setRewriteOpen(true);
  }

  async function runRewrite(style: string) {
    if (!rewriteSelection) return;
    setRewriteStyle(style);
    setRewriteLoading(true);
    setRewriteOutput('');
    setRewriteError('');
    try {
      const res = await fetch('/api/rewrite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: rewriteSelection.text, style })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || 'Could not rewrite that right now.');
      setRewriteOutput(data.text);
    } catch (e) {
      // The error must never land in the output box — "Replace" stays disabled.
      setRewriteError(e instanceof Error ? e.message : 'Could not rewrite that right now.');
    } finally {
      setRewriteLoading(false);
    }
  }

  function replaceSelection() {
    if (!rewriteSelection || !rewriteOutput || rewriteLoading || rewriteError) return;
    const newText = text.slice(0, rewriteSelection.start) + rewriteOutput + text.slice(rewriteSelection.end);
    setText(newText);
    latestTextRef.current = newText;
    setCheckState((s) => (s === 'done' || s === 'error' ? 'idle' : s));
    scheduleAnalysis(newText);
    setRewriteOpen(false);
    showToast('Replaced');
  }

  /* ---------------- keyboard shortcuts + outside-click for dropdowns ---------------- */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        showToast('Draft saved');
      } else if (mod && e.key === 'Enter') {
        e.preventDefault();
        runCheckNow();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        openRewrite();
      } else if (e.key === 'Escape') {
        setRewriteOpen(false);
        setExportOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('.dropdown-wrap')) {
        setDocsOpen(false);
        setExportOpen(false);
      }
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const totalWords = docs.reduce((sum, d) => sum + (d.content.match(/[A-Za-z0-9']+/g) || []).length, 0);
  const stats = useMemo(() => GrammarEngine.computeStats(text), [text]);
  const health: HealthResult | null = useMemo(() => WritingHealth.computeWritingHealth(text, issues), [text, issues]);

  const fleschPct = Math.max(0, Math.min(100, Math.round(stats.flesch)));

  if (!ready) return null;

  const hiddenCount = issues.length - visibleIssues.length;

  return (
    <div id="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path
              d="M20.5 4.5C15 5.6 11 10.4 11 16.1c0 6.6 5.4 12 12 12 2.2 0 4.2-.6 6-1.6-2.7 3.2-6.8 5.3-11.4 5.3C9 31.8 2.2 25 2.2 16.5S9 1.2 17.6 1.2c1.6 0 3.1.2 4.6.7-.6.8-1.2 1.6-1.7 2.6z"
              fill="var(--accent)"
            />
            <circle cx="25.5" cy="8" r="1.7" fill="var(--warm)" />
          </svg>
          <div>
            <div className="brand-name">Lunik Write</div>
            <div className="brand-tag">— clarity, checked as you write</div>
          </div>
        </div>

        <div className="top-controls">
          <div className="ai-status">
            <span className="dot" />
            <span>{aiStatus === 'thinking' ? 'Checking with AI…' : aiStatus === 'error' ? aiError || 'AI checks unavailable' : 'AI checks on'}</span>
          </div>

          <div className="dropdown-wrap">
            <button
              className="btn btn-ghost"
              onClick={(e) => {
                e.stopPropagation();
                setDeleteConfirmId(null);
                setDocsOpen((v) => !v);
                setExportOpen(false);
              }}
            >
              Documents
            </button>
            {docsOpen && (
              <div className={'dropdown-menu' + (docsOpen ? ' open' : '')} onClick={(e) => e.stopPropagation()}>
                <div className="docs-header">
                  <div className="docs-stats">{docs.length} document{docs.length === 1 ? '' : 's'} · {totalWords} words total · {suggestionsFixed} suggestions fixed</div>
                  <div className="docs-stats" style={{ marginTop: 4 }}>Saved in this browser only</div>
                </div>
                <button className="dropdown-item" onClick={newDocument}>
                  + New document
                </button>
                {[...docs].sort((a, b) => b.updatedAt - a.updatedAt).map((d) => (
                  <div key={d.id} className={'doc-item' + (d.id === activeDocId ? ' active' : '')}>
                    <input
                      className="doc-name"
                      value={d.title}
                      onChange={(e) => renameDocument(d.id, e.target.value)}
                      aria-label="Document title in list"
                    />
                    <span className="doc-meta">{(d.content.match(/[A-Za-z0-9']+/g) || []).length}w</span>
                    <div className="doc-dots">
                      {d.id !== activeDocId && (
                        <button className="item-icon" title="Open this document" onClick={() => switchDoc(d.id)}>
                          Open
                        </button>
                      )}
                      <button className="item-icon" title="Duplicate" onClick={() => duplicateDocument(d.id)}>
                        ⎘
                      </button>
                      <button
                        className={'item-icon' + (deleteConfirmId === d.id ? ' confirm' : '')}
                        onClick={() => deleteDocument(d.id)}
                        title="Delete"
                      >
                        {deleteConfirmId === d.id ? 'Confirm?' : '✕'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <select className="input" value={variant} onChange={(e) => setVariant(e.target.value as Variant)} aria-label="Spelling variant">
            <option value="US">US spelling</option>
            <option value="UK">UK spelling</option>
          </select>
          <button
            className="btn btn-ghost"
            onClick={() => {
              const next: 'light' | 'dark' = theme === 'light' ? 'dark' : 'light';
              setTheme(next);
              window.localStorage.setItem('lunik_theme', next);
            }}
            title="Toggle dark mode"
            aria-label="Toggle dark mode"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z" />
            </svg>
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="main">
          {/* ---------- Left: document sidebar ---------- */}
          <aside className="sidebar">
            <div className="sidebar-header">
              <h3 className="sidebar-title">Documents</h3>
              <div className="doc-count">{docs.length} doc{docs.length === 1 ? '' : 's'} · {totalWords} words</div>
            </div>
            <div className="docs-list">
              <button className="doc-item" onClick={newDocument}>
                <span className="doc-name">+ New document</span>
              </button>
              {[...docs].sort((a, b) => b.updatedAt - a.updatedAt).map((d) => (
                <div key={d.id} className={'doc-item' + (d.id === activeDocId ? ' active' : '')}>
                  <input
                    className="doc-name"
                    value={d.title}
                    onChange={(e) => renameDocument(d.id, e.target.value)}
                    aria-label="Document title in list"
                  />
                  <span className="doc-meta">{(d.content.match(/[A-Za-z0-9']+/g) || []).length}w</span>
                  <div className="doc-dots">
                    {d.id !== activeDocId && (
                      <button className="item-icon" title="Open this document" onClick={() => switchDoc(d.id)}>Open</button>
                    )}
                    <button className="item-icon" title="Duplicate" onClick={() => duplicateDocument(d.id)}>⎘</button>
                    <button className={'item-icon' + (deleteConfirmId === d.id ? ' confirm' : '')} title="Delete" onClick={() => deleteDocument(d.id)}>
                      {deleteConfirmId === d.id ? 'Confirm?' : '✕'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </aside>

          {/* ---------- Center: editor ---------- */}
          <div className="editor-column">
            <div className="doc-title-bar">
              <div className="doc-name-input-wrap">
                <input
                  className="doc-name-input"
                  value={activeDocId ? docs.find((d) => d.id === activeDocId)?.title : ''}
                  onChange={(e) => renameDocument(activeDocId, e.target.value)}
                  aria-label="Document title"
                  placeholder="Untitled"
                />
              </div>
              <div className="doc-status">
                <span className="status-dot" />
                <span>Saved</span>
              </div>
            </div>

            <div className="editor-main">
              <div className="editor-body">
                <div className="editor-scroll" onScroll={handleScroll}>
                  <div className="editor-content">
                    <div
                      className="editor-canvas"
                      ref={backdropRef}
                      aria-hidden="true"
                      dangerouslySetInnerHTML={{ __html: backdropHtml }}
                    />
                    <textarea
                      className="editor-input"
                      ref={textareaRef}
                      spellCheck={false}
                      placeholder="Start writing…"
                      aria-label="Document text"
                      value={text}
                      onChange={handleChange}
                      onScroll={handleScroll}
                    />
                  </div>
                </div>

                <div className="editor-toolbar">
                  <button
                    className="btn btn-primary"
                    onClick={runCheckNow}
                    disabled={checkState === 'running'}
                  >
                    {checkState === 'running' ? 'Checking…' : checkState === 'error' ? 'Retry check' : 'Check writing'}
                  </button>
                  <button className="btn btn-ghost" onClick={openRewrite}>
                    Rewrite
                  </button>
                  <div className="dropdown-wrap">
                    <button className="btn btn-ghost" onClick={openExport}>
                      Export
                    </button>
                    <div className={'dropdown-menu' + (exportOpen ? ' open' : '')}>
                      <button className="dropdown-item" onClick={copyText}>
                        Copy text
                      </button>
                      <button className="dropdown-item" onClick={() => exportFile('txt')}>
                        Download .txt
                      </button>
                      <button className="dropdown-item" onClick={() => exportFile('md')}>
                        Download .md
                      </button>
                      <button className="dropdown-item" onClick={() => exportFile('html')}>
                        Download .html
                      </button>
                    </div>
                  </div>
                  <div className="chip-row" role="group" aria-label="Suggestion categories">
                    {ISSUE_TYPES.map((t) => (
                      <button key={t.key} className={'chip' + (activeTypes[t.key] ? ' active' : '')} onClick={() => toggleType(t.key as IssueType)}>
                        {labelize(t.key)}
                      </button>
                    ))}
                  </div>
                </div>

                <AnimatePresence initial={false}>
                {checkState === 'running' && (
                  <motion.div
                    key="banner-running"
                    className="check-banner running"
                    role="status"
                    initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0 }}
                    transition={mt(0.15)}
                  >
                    Checking your writing with AI…
                  </motion.div>
                )}
                {checkState === 'error' && (
                  <motion.div
                    key="banner-error"
                    className="check-banner error"
                    role="alert"
                    initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0 }}
                    transition={mt(0.15)}
                  >
                    <span>AI check failed{checkError ? ' — ' + checkError : ''}. Local checks are still active.</span>
                    <button className="btn btn-soft" onClick={runCheckNow}>
                      Try again
                    </button>
                  </motion.div>
                )}
                {checkState === 'done' && (
                  <motion.div
                    key="banner-done"
                    className="check-banner ok"
                    role="status"
                    initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0 }}
                    transition={mt(0.15)}
                  >
                    {visibleIssues.length === 0
                      ? 'Check complete — no issues in view.'
                      : `Check complete — ${visibleIssues.length} suggestion${visibleIssues.length === 1 ? '' : 's'} in view.`}
                  </motion.div>
                )}
                </AnimatePresence>

                <div className="editor-stats">
                  <div className="stat">
                    <span className="stat-num">{stats.wordCount}</span>
                    <span className="stat-lbl">words</span>
                  </div>
                  <div className="stat">
                    <span className="stat-num">{stats.charCount}</span>
                    <span className="stat-lbl">characters</span>
                  </div>
                  <div className="stat">
                    <span className="stat-num">{stats.readingTime} min</span>
                    <span className="stat-lbl">read time</span>
                  </div>
                </div>

                {health && (
                  <div className="health-strip" aria-label="Writing health">
                    <div className="health-overall">
                      <span className="health-num">{health.overall}</span>
                      <span className="health-lbl">{health.label}</span>
                    </div>
                    {health.metrics.map((m) => (
                      <div className="health-metric" key={m.key}>
                        <div className="health-metric-top">
                          <span className="health-metric-lbl">{m.label}</span>
                          <span className="health-metric-score">{m.score}</span>
                        </div>
                        <div className="meter-track">
                          <motion.div
                            className={'meter-fill' + (m.score < 50 ? ' low' : '')}
                            initial={reduceMotion ? false : { width: 0 }}
                            animate={{ width: m.score + '%' }}
                            transition={mt(0.5)}
                          />
                        </div>
                        <div className="health-detail">{m.detail}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ---------- Right: AI assistant ---------- */}
          <aside className="ai-card">
            <div className="ai-header">
              <h3 className="ai-title">AI assistant</h3>
              <button className="icon-btn" onClick={() => setActiveTab('suggestions')} aria-label="Suggestions">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" /></svg>
              </button>
            </div>

            <div className="ai-tabs">
              <button
                className={'ai-tab' + (activeTab === 'suggestions' ? ' active' : '')}
                onClick={() => setActiveTab('suggestions')}
              >
                Suggestions
              </button>
              <button
                className={'ai-tab' + (activeTab === 'tone' ? ' active' : '')}
                onClick={() => setActiveTab('tone')}
              >
                Tone
              </button>
              <button
                className={'ai-tab' + (activeTab === 'readability' ? ' active' : '')}
                onClick={() => setActiveTab('readability')}
              >
                Readability
              </button>
            </div>

            <div className="ai-panel">
              {activeTab === 'suggestions' && (
                <div className="panel active">
                  {visibleIssues.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-icon">{hiddenCount > 0 ? '⌸' : '✓'}</div>
                      <p>
                        {stats.wordCount === 0
                          ? 'Start writing to see suggestions.'
                          : hiddenCount > 0
                            ? `${hiddenCount} suggestion${hiddenCount === 1 ? ' is' : 's are'} hidden by your category filters above.`
                            : 'No issues in view right now.'}
                      </p>
                    </div>
                  ) : (
                    <AnimatePresence initial={false}>
                    {[...visibleIssues].sort((a, b) => a.start - b.start).map((iss) => (
                      <motion.div
                        className="sugg-card"
                        key={iss.id}
                        layout={reduceMotion ? undefined : true}
                        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
                        transition={mt(0.18)}
                      >
                        <div className="sugg-top">
                          <span className={severityBadge(iss.severity)}>{labelize(iss.type)}</span>
                          <span className="sugg-right">
                            {iss.source === 'ai' && <span className="badge badge-ghost">AI</span>}
                            <span className="sugg-conf" title="Model or rule confidence">
                              {Math.round(iss.confidence * 100)}%
                            </span>
                          </span>
                        </div>
                        <div className="sugg-swap">
                          <span className="old">{iss.original}</span>
                          <span className="swap-arrow" aria-hidden="true">→</span>
                          <span className="new">{iss.suggestion}</span>
                        </div>
                        {iss.explanation && <div className="sugg-why">{iss.explanation}</div>}
                        <div className="sugg-actions">
                          <button className="btn btn-soft" onClick={() => applyIssue(iss)}>
                            Accept
                          </button>
                          <button className="btn btn-ghost" onClick={() => ignoreIssue(iss.id)}>
                            Ignore
                          </button>
                          {iss.type === 'spelling' && (
                            <button className="btn btn-ghost" onClick={() => addToDictionary(iss)}>
                              Dictionary
                            </button>
                          )}
                        </div>
                      </motion.div>
                    ))}
                    </AnimatePresence>
                  )}
                  {personalDict.length > 0 && (
                    <div className="dict-box">
                      <h4>Personal dictionary</h4>
                      <div className="pill-row">
                        {personalDict.map((w) => (
                          <span className="pill" key={w}>
                            {w}
                            <button onClick={() => removeFromDictionary(w)} aria-label={'Remove ' + w}>×</button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'tone' && (
                <div className="panel active">
                  <div className="tone-btn-row">
                    <button className="btn btn-primary" onClick={analyzeTone} disabled={toneLoading}>
                      {toneLoading ? 'Reading tone…' : 'Analyze tone'}
                    </button>
                  </div>
                  {!toneResult ? (
                    <p className="tone-empty">
                      Run a tone check to see how your writing is likely to come across — formal, casual, confident, and so on. These
                      are AI estimates, not a scientific measurement.
                    </p>
                  ) : (
                    <div>
                      <div className="tone-primary">{toneResult.primary}</div>
                      {toneResult.traits.slice(0, 5).map((t) => {
                        const pct = Math.max(0, Math.min(100, Number(t.score) || 0));
                        return (
                          <div className="meter-row" key={t.name}>
                            <div className="meter-lbl">
                              <span>{t.name}</span>
                              <span>{Math.round(pct)}</span>
                            </div>
                          <div className="meter-track">
                            <motion.div
                              className="meter-fill"
                              initial={reduceMotion ? false : { width: 0 }}
                              animate={{ width: pct + '%' }}
                              transition={mt(0.5)}
                            />
                          </div>
                          </div>
                        );
                      })}
                      {toneResult.note && <div className="tone-note">{toneResult.note}</div>}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'readability' && (
                <div className="panel active">
                  {stats.wordCount === 0 ? (
                    <p className="tone-empty">Start writing to see readability stats.</p>
                  ) : (
                    <>
                      <div className="stat-grid">
                        <div className="stat-box">
                          <div className="num">{Math.round(stats.fk * 10) / 10}</div>
                          <div className="lbl">Grade level</div>
                        </div>
                        <div className="stat-box">
                          <div className="num">{Math.round(stats.avgSentLen * 10) / 10}</div>
                          <div className="lbl">Words / sentence</div>
                        </div>
                        <div className="stat-box">
                          <div className="num">{Math.round(stats.avgWordLen * 10) / 10}</div>
                          <div className="lbl">Letters / word</div>
                        </div>
                        <div className="stat-box">
                          <div className="num">{Math.round(stats.complexPct)}%</div>
                          <div className="lbl">Complex words</div>
                        </div>
                      </div>
                      <div className="meter-row">
                        <div className="meter-lbl">
                          <span>Reading ease</span>
                          <span>{Math.round(stats.flesch)}</span>
                        </div>
                        <div className="meter-track">
                          <div className="meter-fill" style={{ width: fleschPct + '%' }} />
                        </div>
                      </div>
                      <div className="read-verdict">{GrammarEngine.readabilityLabel(stats.flesch)}</div>
                    </>
                  )}
                </div>
              )}
            </div>
          </aside>
        </section>
      </main>

      <AnimatePresence>
        {rewriteOpen && (
          <motion.div
            className="modal-overlay"
            onClick={() => setRewriteOpen(false)}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            transition={mt(0.15)}
          >
            <motion.div
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-label="Rewrite selection"
              onClick={(e) => e.stopPropagation()}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.97, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={mt(0.2)}
            >
            <h3>Rewrite selection</h3>
            <div className="orig-text">{rewriteSelection?.text}</div>
            <div className="style-row">
              {REWRITE_STYLES.map((s: { key: string; label: string }) => (
                <button key={s.key} className={rewriteStyle === s.key ? 'selected' : ''} disabled={rewriteLoading} onClick={() => runRewrite(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
            <div className="rw-output">
              {rewriteLoading ? 'Thinking…' : rewriteOutput || 'Choose a style above.'}
            </div>
            {rewriteError && (
              <div className="rw-error" role="alert">
                {rewriteError}
                <button className="btn btn-soft" onClick={() => rewriteStyle && runRewrite(rewriteStyle)} disabled={rewriteLoading}>
                  Try again
                </button>
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => setRewriteOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn-ghost"
                disabled={!rewriteStyle || rewriteLoading}
                onClick={() => rewriteStyle && runRewrite(rewriteStyle)}
              >
                {rewriteLoading ? 'Thinking…' : 'Try again'}
              </button>
              <button className="btn btn-ghost" disabled={!rewriteOutput || rewriteLoading} onClick={copyRewriteOutput}>
                Copy
              </button>
              <button
                className="btn btn-primary"
                disabled={!rewriteOutput || rewriteLoading || !!rewriteError}
                onClick={replaceSelection}
              >
                Replace
              </button>
            </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={'toast' + (toast ? ' show' : '')}>{toast}</div>
    </div>
  );

  function copyRewriteOutput() {
    if (!rewriteOutput) return;
    navigator.clipboard?.writeText(rewriteOutput).then(
      () => showToast('Copied'),
      () => showToast('Couldn’t copy')
    );
  }
}
