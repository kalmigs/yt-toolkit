// ==UserScript==
// @name         YT Toolkit
// @namespace    https://github.com/kalmigs/yt-toolkit
// @version      0.3.0
// @description  Toolkit for YouTube. Copy composer: pick sources (Transcript, ✦ Ask answers) and copy them as one chapter-grouped Markdown doc with timestamp links — works on watch pages and Shorts. More coming — description export.
// @author       kal
// @license      MIT
// @homepageURL  https://github.com/kalmigs/yt-toolkit
// @supportURL   https://github.com/kalmigs/yt-toolkit/issues
// @downloadURL  https://raw.githubusercontent.com/kalmigs/yt-toolkit/main/yt-toolkit.user.js
// @updateURL    https://raw.githubusercontent.com/kalmigs/yt-toolkit/main/yt-toolkit.user.js
// @icon         https://www.youtube.com/favicon.ico
// @match        https://www.youtube.com/*
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes
// ==/UserScript==
//
// A userscript is a single standalone file (the manager can't require() modules),
// so everything is inlined here — the pure formatting helpers (tsToSeconds, tsLink,
// formatSections, FLUSH_EVERY), the live-DOM readers (transcript + ✦ Ask panel),
// and the page glue (the copy-composer popover). No build step, no dependencies.

(function () {
  'use strict';

  // ─── Pure formatting helpers (timestamp links + paragraph grouping) ──────
  const FLUSH_EVERY = 8; // segments per paragraph

  function tsToSeconds(ts) {
    const parts = ts.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  // Build a "[`m:ss`](videoUrl&t=Ns)" link from a label + an explicit seconds
  // value. The transcript path derives the seconds from the label; the Ask path
  // has them directly (the timestamp chips carry data-time in seconds).
  function tsLinkFromSeconds(label, seconds, videoUrl) {
    if (!videoUrl || !Number.isFinite(seconds)) return `[${label}]`;
    try {
      const u = new URL(videoUrl);
      u.searchParams.set('t', `${seconds}s`);
      return `[\`${label}\`](${u.toString()})`;
    } catch {
      return `[${label}]`;
    }
  }

  function tsLink(ts, videoUrl) {
    return tsLinkFromSeconds(ts, tsToSeconds(ts), videoUrl);
  }

  function formatSections(chapters, { videoUrl, chHeading }) {
    const sections = [];
    for (const ch of chapters) {
      if (!ch.segments.length) continue;
      const lines = [`${chHeading} ${ch.title}`, ''];
      let buf = [];
      let bufStart = ch.segments[0].ts;
      ch.segments.forEach((seg, idx) => {
        buf.push(seg.text);
        const isLast = idx === ch.segments.length - 1;
        if (buf.length >= FLUSH_EVERY || isLast) {
          const text = buf.join(' ').replace(/\s+/g, ' ').trim();
          lines.push(`${tsLink(bufStart, videoUrl)} ${text}`);
          lines.push('');
          buf = [];
          bufStart = ch.segments[idx + 1]?.ts;
        }
      });
      sections.push(lines.join('\n'));
    }
    return sections;
  }

  const txt = (el) => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();

  // ─── Transcript DOM reader (replaces the CLI's regex parseTranscript) ────
  // YouTube ships two transcript DOM shapes; both are handled by reading live
  // nodes in document order and assigning each segment to the last-seen chapter.
  const SEG_SEL = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
  const CH_SEL = 'ytd-transcript-section-header-renderer, .ytwTimelineChapterViewModelTitle';

  function readSegment(el) {
    if (el.matches('ytd-transcript-segment-renderer')) {
      const ts = txt(el.querySelector('.segment-timestamp'));
      const text = txt(el.querySelector('.segment-text'));
      return ts ? { ts, text } : null;
    }
    // viewmodel
    const ts = txt(el.querySelector('[class*="Timestamp"]'));
    const text = txt(el.querySelector('.ytAttributedStringHost, [class*="AttributedString"]'));
    return ts ? { ts, text } : null;
  }

  function chapterTitle(el) {
    let t;
    if (el.matches('.ytwTimelineChapterViewModelTitle')) {
      t = el.textContent;
    } else {
      const labelled = el.querySelector('[aria-label]');
      t = labelled ? labelled.getAttribute('aria-label') : el.textContent;
    }
    // Strip a redundant "Chapter N: " prefix when a real title follows.
    return (t || 'Chapter').replace(/\s+/g, ' ').trim().replace(/^Chapter\s+\d+:\s+(?=\S)/i, '');
  }

  function parseTranscriptDOM() {
    // Scope the read to a single transcript panel. YouTube sometimes mounts the
    // same transcript in two engagement panels at once (e.g. the transcript
    // panel + the "search in video" preview), so a document-wide query would
    // read — and emit — every segment twice.
    const first = document.querySelector(SEG_SEL);
    const scope =
      (first && first.closest('ytd-engagement-panel-section-list-renderer')) || document;
    const nodes = scope.querySelectorAll(`${SEG_SEL}, ${CH_SEL}`);
    const chapters = [];
    const orphan = []; // segments before the first chapter header
    let current = null;
    for (const el of nodes) {
      if (el.matches(CH_SEL)) {
        current = { title: chapterTitle(el), segments: [] };
        chapters.push(current);
      } else {
        const seg = readSegment(el);
        if (seg) (current ? current.segments : orphan).push(seg);
      }
    }
    if (!chapters.length) return [{ title: 'Transcript', segments: orphan }];
    if (orphan.length) chapters.unshift({ title: 'Transcript', segments: orphan });
    return chapters;
  }

  // ─── ✦ Ask panel reader (YouTube's Ask / Gemini engagement panel) ────────
  // The Ask panel is an engagement panel with target-id="PAyouchat". Its
  // conversation is a flat list of turns in document order:
  //   • yt-chat-user-turn-view-model → a question you asked
  //   • you-chat-item-view-model     → an AI message: an answer, the canned
  //                                    greeting, or a row of suggested-question
  //                                    chips
  // Real answers carry a <markdown-div>; greetings do too but sit before the
  // first user turn; chip rows have no <markdown-div>. So we ignore everything
  // before the first question and any row without a <markdown-div>, leaving
  // exactly the Q&A you drove.
  const ASK_PANEL_SEL = 'ytd-engagement-panel-section-list-renderer[target-id="PAyouchat"]';
  const ASK_TURN_SEL = 'yt-chat-user-turn-view-model, you-chat-item-view-model';
  const ASK_ANSWER_SEL = 'markdown-div';

  const askPanel = () => document.querySelector(ASK_PANEL_SEL);

  // Cheap sync check for the composer's enabled/disabled state: does the panel
  // hold at least one real answer? (An answer implies a question preceded it.)
  function hasAskConversation() {
    const panel = askPanel();
    if (!panel) return false;
    for (const el of panel.querySelectorAll('you-chat-item-view-model')) {
      if (el.querySelector(ASK_ANSWER_SEL) && isAnswerItem(el, panel)) return true;
    }
    return false;
  }

  // A you-chat-item-view-model is a real answer (not the greeting) if it has a
  // markdown-div AND at least one user turn appears before it in the panel.
  function isAnswerItem(el, panel) {
    if (!el.querySelector(ASK_ANSWER_SEL)) return false;
    const turns = panel.querySelectorAll(ASK_TURN_SEL);
    for (const t of turns) {
      if (t === el) return false; // reached this item before any question
      if (t.matches('yt-chat-user-turn-view-model')) return true;
    }
    return false;
  }

  // Convert one rendered <markdown-div> back into Markdown. YouTube renders the
  // model's Markdown to HTML; we walk that HTML and rebuild the Markdown, turning
  // its timestamp chips (span.ytwMarkdownDivTimestamp[data-time]) into the same
  // clickable [`m:ss`](…&t=Ns) links the transcript uses.
  function askDivToMarkdown(root, videoUrl) {
    function inlineChildren(node) {
      let out = '';
      for (const n of node.childNodes) out += serializeNode(n);
      return out;
    }

    // Block-level walk: same as inlineChildren but skips whitespace-only text
    // nodes between blocks. YouTube pretty-prints the rendered HTML, so there
    // are "\n  " text nodes between <p>/<ul>/<li> siblings; keeping them would
    // prepend a stray space to the next paragraph or list item. Whitespace
    // inside inline flow (between words / inline tags) still goes through
    // inlineChildren, where it's significant.
    function serializeBlocks(node) {
      let out = '';
      for (const n of node.childNodes) {
        if (n.nodeType === 3 && !n.textContent.trim()) continue;
        out += serializeNode(n);
      }
      return out;
    }

    function serializeNode(n) {
      if (n.nodeType === 3) return n.textContent.replace(/\s+/g, ' '); // text
      if (n.nodeType !== 1) return '';
      const tag = n.tagName.toLowerCase();
      if (n.classList && n.classList.contains('ytwMarkdownDivTimestamp')) {
        const secs = n.getAttribute('data-time');
        const label = txt(n);
        return secs !== null && secs !== ''
          ? tsLinkFromSeconds(label, Number(secs), videoUrl)
          : tsLink(label, videoUrl);
      }
      switch (tag) {
        case 'p':
          return inlineChildren(n).trim() + '\n\n';
        case 'br':
          return '  \n';
        case 'strong':
        case 'b':
          return `**${inlineChildren(n).trim()}**`;
        case 'em':
        case 'i':
          return `*${inlineChildren(n).trim()}*`;
        case 'code':
          return `\`${txt(n)}\``;
        case 'pre':
          return '```\n' + n.textContent.replace(/\n+$/, '') + '\n```\n\n';
        case 'a': {
          const href = n.getAttribute('href');
          const text = inlineChildren(n).trim();
          return href ? `[${text}](${href})` : text;
        }
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          return '#'.repeat(Number(tag[1])) + ' ' + inlineChildren(n).trim() + '\n\n';
        case 'blockquote':
          return (
            inlineChildren(n)
              .trim()
              .split('\n')
              .map((l) => (l ? `> ${l}` : '>'))
              .join('\n') + '\n\n'
          );
        case 'hr':
          return '---\n\n';
        case 'ul':
        case 'ol':
          return serializeList(n, tag === 'ol', 0) + '\n\n';
        default:
          return inlineChildren(n); // span and unknown wrappers: pass through
      }
    }

    function serializeList(listEl, ordered, depth) {
      const pad = '  '.repeat(depth);
      const lines = [];
      let i = 1;
      for (const li of listEl.children) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        const marker = ordered ? `${i++}. ` : '- ';
        // Split the item into its inline content and any nested lists.
        let head = '';
        const subLists = [];
        for (const c of li.childNodes) {
          if (c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)) subLists.push(c);
          else head += serializeNode(c);
        }
        lines.push(pad + marker + head.replace(/\s+/g, ' ').trim());
        for (const sl of subLists) {
          lines.push(serializeList(sl, sl.tagName.toLowerCase() === 'ol', depth + 1));
        }
      }
      return lines.join('\n');
    }

    return serializeBlocks(root)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ─── Page metadata ───────────────────────────────────────────────────────
  // The channel lives in the video-owner block on the watch page. Try the
  // current and legacy selectors and take the first anchor that resolves to a
  // channel (its text is the name, its href the channel URL).
  function getChannel() {
    const a = document.querySelector(
      'ytd-video-owner-renderer ytd-channel-name a, #owner #channel-name a, ytd-channel-name#channel-name a'
    );
    const name = txt(a) || null;
    const href = a ? a.getAttribute('href') : null;
    let channelUrl = null;
    if (href) {
      try {
        channelUrl = new URL(href, location.origin).toString();
      } catch (_) {
        channelUrl = null;
      }
    }
    return { channel: name, channelUrl };
  }

  function getMeta() {
    const id = new URLSearchParams(location.search).get('v');
    const videoUrl = id ? `https://www.youtube.com/watch?v=${id}` : location.href;
    const h1 = document.querySelector('h1.ytd-watch-metadata, h1 yt-formatted-string');
    const title = (txt(h1) || document.title.replace(/\s*-\s*YouTube\s*$/, '') || 'Transcript').trim();
    return { videoUrl, title, ...getChannel() };
  }

  // ─── Auto-open the transcript panel ──────────────────────────────────────
  const hasSegments = () => document.querySelector(SEG_SEL) != null;

  const wait = (predicate, timeout = 5000, step = 150) =>
    new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        if (predicate()) return resolve(true);
        if (performance.now() - t0 > timeout) return resolve(false);
        setTimeout(tick, step);
      };
      tick();
    });

  function findShowTranscriptButton() {
    const direct = document.querySelector('button[aria-label="Show transcript" i]');
    if (direct) return direct;
    // Scope the text-based fallback to the structured-description / metadata
    // areas. Scanning every button on the page risks clicking an unrelated
    // control that merely mentions "transcript" (a comment, a related card).
    const scopes = document.querySelectorAll(
      'ytd-video-description-transcript-section-renderer, #structured-description, ytd-watch-metadata'
    );
    for (const scope of scopes) {
      const btn = [...scope.querySelectorAll('button, tp-yt-paper-button')].find((el) =>
        /transcript/i.test(`${el.textContent} ${el.getAttribute('aria-label') || ''}`)
      );
      if (btn) return btn;
    }
    return null;
  }

  async function ensureTranscriptOpen() {
    if (hasSegments()) return true;
    // The transcript control sometimes hides inside the collapsed description.
    const expand = document.querySelector('ytd-text-inline-expander #expand, #expand');
    if (expand && !findShowTranscriptButton()) {
      expand.click();
      await wait(() => findShowTranscriptButton() != null, 1500);
    }
    const btn = findShowTranscriptButton();
    if (btn) {
      btn.click();
      await wait(hasSegments, 5000);
    }
    return hasSegments();
  }

  // ─── Section builders (one Markdown body per source) ─────────────────────
  // The transcript's chapters render as sub-headings under a "## Transcript"
  // section wrapper, so pass chHeading='###'. A video with no chapters yields a
  // single pseudo-chapter titled "Transcript" — drop its redundant sub-heading.
  function readTranscriptSection(videoUrl) {
    const chapters = parseTranscriptDOM();
    const total = chapters.reduce((n, c) => n + c.segments.length, 0);
    if (!total) return null;
    const body = formatSections(chapters, { videoUrl, chHeading: '###' }).join('\n');
    if (chapters.length === 1 && chapters[0].title === 'Transcript') {
      const lines = body.split('\n');
      if (lines[0] === '### Transcript') lines.splice(0, 2); // heading + blank
      return lines.join('\n').trim();
    }
    return body;
  }

  function readAskSection(videoUrl) {
    const panel = askPanel();
    if (!panel) return null;
    const parts = [];
    let started = false;
    for (const el of panel.querySelectorAll(ASK_TURN_SEL)) {
      if (el.matches('yt-chat-user-turn-view-model')) {
        started = true;
        const q = txt(el);
        if (q) parts.push(`**Q:** ${q}`);
      } else {
        // you-chat-item-view-model
        if (!started) continue; // canned greeting before the first question
        const md = el.querySelector(ASK_ANSWER_SEL);
        if (!md) continue; // suggested-question chips (no answer body)
        const a = askDivToMarkdown(md, videoUrl);
        if (a) parts.push(`**A:**\n\n${a}`);
      }
    }
    return parts.length ? parts.join('\n\n') : null;
  }

  // ─── Sources (the composer's checkboxes) ─────────────────────────────────
  // Each source knows how to detect its own availability (sync, for the
  // checkbox state) and how to read its Markdown body (async). Adding a source
  // later — Description, Chapters — is just another entry here.
  const SOURCES = [
    {
      id: 'transcript',
      label: 'Transcript',
      heading: 'Transcript',
      hint: 'No transcript on this video',
      isAvailable: () => isWatch() && (hasSegments() || findShowTranscriptButton() != null),
      read: async (meta) => {
        await ensureTranscriptOpen();
        return readTranscriptSection(meta.videoUrl);
      },
    },
    {
      id: 'ask',
      label: 'Ask (✦ AI answers)',
      heading: 'Ask',
      hint: 'Ask the ✦ panel a question first',
      isAvailable: () => isWatch() && hasAskConversation(),
      read: async (meta) => readAskSection(meta.videoUrl),
    },
  ];

  // ─── Assemble the Markdown doc ───────────────────────────────────────────
  function buildFrontmatter(meta) {
    const { videoUrl, title, channel, channelUrl } = meta;
    const created = new Date().toISOString().slice(0, 10);
    // Same escaping rationale throughout: titles and channel names routinely
    // carry ':'/quotes/leading '-' that break frontmatter parsers. Omit the
    // channel field entirely when unreadable rather than emitting null.
    const fm = [
      '---',
      `title: ${JSON.stringify(title)}`,
      ...(channel ? [`channel: ${JSON.stringify(channel)}`] : []),
      `source: ${JSON.stringify(videoUrl)}`,
      `created: ${created}`,
      '---',
    ];
    const channelLink = channel ? (channelUrl ? `[${channel}](${channelUrl})` : channel) : null;
    const attribution = [channelLink, `[Source video](${videoUrl})`].filter(Boolean).join(' · ');
    return [...fm, '', `# ${title}`, '', `> ${attribution}`].join('\n');
  }

  // Read each chosen source and stitch the non-empty ones into one doc under
  // shared frontmatter. Sources that yield nothing (e.g. Ask checked but never
  // used) are skipped, never fatal — so a present transcript still copies.
  async function buildDoc(sources) {
    const meta = getMeta();
    const sections = [];
    const skipped = [];
    for (const s of sources) {
      let body = null;
      try {
        body = await s.read(meta);
      } catch (e) {
        console.error('[yt-toolkit]', s.id, e);
      }
      if (body) sections.push(`## ${s.heading}\n\n${body.trim()}`);
      else skipped.push(s.label);
    }
    if (!sections.length) return { md: null, skipped, count: 0 };
    const md = [buildFrontmatter(meta), '', sections.join('\n\n')].join('\n');
    return { md, skipped, count: sections.length };
  }

  // ─── Clipboard + toast ───────────────────────────────────────────────────
  function toast(msg, ok = true) {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '76px',
      right: '20px',
      zIndex: 99999,
      padding: '10px 14px',
      borderRadius: '8px',
      font: '500 13px/1.3 Roboto, system-ui, sans-serif',
      color: '#fff',
      background: ok ? '#1f7a33' : '#a02929',
      boxShadow: '0 2px 10px rgba(0,0,0,.35)',
      maxWidth: '320px',
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  async function copy(text) {
    // Try the modern API first: it returns a real promise we can actually
    // verify, so a success toast means the write happened. The button click is
    // a fresh user gesture and the panel is already open here, so activation is
    // still valid.
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_) {
      // Fall back to the GM API (reliable inside the sandbox when the page
      // blocks navigator.clipboard).
    }
    if (typeof GM_setClipboard === 'function') {
      // Plain string type — NOT { type, mimetype }. The object form is
      // Tampermonkey-only; Violentmonkey silently no-ops on it (which is what
      // produced a green toast with an empty clipboard).
      GM_setClipboard(text, 'text');
      return;
    }
    throw new Error('no working clipboard method (navigator blocked, GM_setClipboard missing)');
  }

  // ─── Page-type helpers ───────────────────────────────────────────────────
  const isWatch = () => location.pathname === '/watch';
  const isShorts = () => location.pathname.startsWith('/shorts/');
  const currentV = () => new URLSearchParams(location.search).get('v');
  const shortsId = () => {
    const m = location.pathname.match(/^\/shorts\/([^/?#]+)/);
    return m ? m[1] : null;
  };
  // Survives the Short→watch hop (sessionStorage outlives a hard reload too).
  const AUTORUN_KEY = 'yt-toolkit-autorun';

  // Shorts have no transcript/Ask panel to scrape, but the SAME video plays at
  // /watch?v=<id> with the full UI. So on a Short we stash the id and bounce to
  // the watch page, where mountButton() picks up the flag and auto-copies the
  // transcript (the proven default; the composer is a watch-page interface).
  function openShortAsWatch() {
    const id = shortsId();
    if (!id) {
      toast('Could not read this Short’s video id.', false);
      return;
    }
    sessionStorage.setItem(AUTORUN_KEY, id);
    location.href = `https://www.youtube.com/watch?v=${id}`;
  }

  async function autoCopyTranscript() {
    try {
      const transcript = SOURCES.find((s) => s.id === 'transcript');
      const { md } = await buildDoc([transcript]);
      if (!md) {
        toast('No transcript found for this video.', false);
        return;
      }
      await copy(md);
      toast('✓ Copied transcript');
    } catch (e) {
      console.error('[yt-toolkit]', e);
      toast(`Error: ${e.message}`, false);
    }
  }

  // ─── Theme + fullscreen chrome ───────────────────────────────────────────
  // Detect YouTube's *own* theme — NOT the OS preference (the page can be light
  // while the OS is dark). YouTube flips a `dark` attribute on <html>; if that's
  // ever absent, fall back to the page's actual background luminance. Used to
  // invert the widget so it stays high contrast (a black pill vanished on dark).
  function isDark() {
    if (document.documentElement.hasAttribute('dark')) return true;
    for (const el of [document.body, document.documentElement]) {
      const bg = el && getComputedStyle(el).backgroundColor;
      const m = bg && bg.match(/[\d.]+/g);
      // Skip transparent backgrounds (alpha 0); use the first painted one.
      if (m && m.length >= 3 && (m[3] === undefined || Number(m[3]) > 0)) {
        const [r, g, b] = m.map(Number);
        return 0.299 * r + 0.587 * g + 0.114 * b < 128;
      }
    }
    return false;
  }

  // The player overlays the page in fullscreen/theater-fullscreen, so a fixed
  // widget would float over the video. Covers native fullscreen and YouTube's
  // own fullscreen flag (which also fires on Shorts/HTML5 fullscreen).
  const isFullscreen = () =>
    document.fullscreenElement != null ||
    document.querySelector('ytd-app[fullscreen], .ytp-fullscreen') != null;

  function applyMenuTheme(menu, dark) {
    Object.assign(menu.style, {
      background: dark ? '#282828' : '#fff',
      color: dark ? '#f1f1f1' : '#0f0f0f',
      border: `1px solid ${dark ? '#3f3f3f' : '#e5e5e5'}`,
    });
  }

  // Repaint theme colors + show/hide for fullscreen on the whole widget.
  function updateChrome() {
    const root = document.getElementById('yt-toolkit-root');
    if (!root) return;
    root.style.display = isFullscreen() ? 'none' : '';
    const dark = isDark();
    const btn = document.getElementById('yt-toolkit-btn');
    if (btn) {
      Object.assign(btn.style, {
        color: dark ? '#0f0f0f' : '#fff',
        background: dark ? '#f1f1f1' : '#0f0f0f',
      });
    }
    const menu = document.getElementById('yt-toolkit-menu');
    if (menu) applyMenuTheme(menu, dark);
  }

  // ─── UI: copy-composer popover ───────────────────────────────────────────
  function ensureUI() {
    let root = document.getElementById('yt-toolkit-root');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'yt-toolkit-root';
    Object.assign(root.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: 99999,
      font: '600 13px/1 Roboto, system-ui, sans-serif',
    });
    const btn = document.createElement('button');
    btn.id = 'yt-toolkit-btn';
    btn.textContent = '📋 Copy';
    Object.assign(btn.style, {
      padding: '10px 16px',
      borderRadius: '20px',
      border: 'none',
      cursor: 'pointer',
      font: 'inherit',
      boxShadow: '0 2px 10px rgba(0,0,0,.4)',
    });
    // isShorts() is read at click time, so the same widget works on both page
    // types as you navigate the SPA: a Short bounces to watch, a watch page
    // toggles the source picker.
    btn.addEventListener('click', () => (isShorts() ? openShortAsWatch() : toggleMenu()));
    root.appendChild(btn);
    document.body.appendChild(root);
    return root;
  }

  function toggleMenu() {
    if (document.getElementById('yt-toolkit-menu')) closeMenu();
    else openMenu();
  }

  function openMenu() {
    const root = ensureUI();
    const menu = document.createElement('div');
    menu.id = 'yt-toolkit-menu';
    Object.assign(menu.style, {
      position: 'absolute',
      right: '0',
      bottom: '100%',
      marginBottom: '10px',
      width: '250px',
      padding: '12px',
      borderRadius: '12px',
      boxShadow: '0 4px 24px rgba(0,0,0,.35)',
      font: '500 13px/1.4 Roboto, system-ui, sans-serif',
      cursor: 'default',
    });

    const heading = document.createElement('div');
    heading.textContent = 'Copy as Markdown';
    Object.assign(heading.style, { fontWeight: '700', marginBottom: '8px' });
    menu.appendChild(heading);

    for (const s of SOURCES) {
      const available = s.isAvailable();
      const row = document.createElement('label');
      Object.assign(row.style, {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '6px 2px',
        cursor: available ? 'pointer' : 'default',
        opacity: available ? '1' : '.5',
      });
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.sourceId = s.id;
      cb.checked = available; // default-on when available, opportunistic
      cb.disabled = !available;
      Object.assign(cb.style, {
        marginTop: '2px',
        cursor: available ? 'pointer' : 'default',
        accentColor: '#3ea6ff',
      });
      const text = document.createElement('div');
      const name = document.createElement('div');
      name.textContent = s.label;
      text.appendChild(name);
      if (!available) {
        const hint = document.createElement('div');
        hint.textContent = s.hint;
        Object.assign(hint.style, { fontSize: '11px', opacity: '.85', marginTop: '1px' });
        text.appendChild(hint);
      }
      row.append(cb, text);
      menu.appendChild(row);
    }

    const copyBtn = document.createElement('button');
    copyBtn.id = 'yt-toolkit-copy';
    copyBtn.textContent = 'Copy';
    Object.assign(copyBtn.style, {
      width: '100%',
      marginTop: '10px',
      padding: '9px 12px',
      borderRadius: '18px',
      border: 'none',
      cursor: 'pointer',
      font: '600 13px/1 Roboto, system-ui, sans-serif',
      background: '#3ea6ff',
      color: '#0f0f0f',
    });
    copyBtn.addEventListener('click', onCopy);
    menu.appendChild(copyBtn);

    applyMenuTheme(menu, isDark());
    root.appendChild(menu);

    // Close when clicking outside the widget. Deferred a tick so the very click
    // that opened the menu doesn't immediately close it.
    setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
  }

  function onOutsideClick(e) {
    const root = document.getElementById('yt-toolkit-root');
    if (root && !root.contains(e.target)) closeMenu();
  }

  function closeMenu() {
    document.removeEventListener('click', onOutsideClick);
    const menu = document.getElementById('yt-toolkit-menu');
    if (menu) menu.remove();
  }

  async function onCopy(e) {
    const copyBtn = e.currentTarget;
    const menu = document.getElementById('yt-toolkit-menu');
    const chosen = SOURCES.filter((s) => {
      const cb = menu.querySelector(`input[data-source-id="${s.id}"]`);
      return cb && cb.checked && !cb.disabled;
    });
    if (!chosen.length) {
      toast('Pick at least one source.', false);
      return;
    }
    const original = copyBtn.textContent;
    copyBtn.textContent = '⏳ reading…';
    copyBtn.disabled = true;
    try {
      const { md, skipped, count } = await buildDoc(chosen);
      if (!md) {
        toast('Nothing to copy — the selected source(s) were empty.', false);
        return;
      }
      await copy(md);
      let msg = `✓ Copied ${count} source${count > 1 ? 's' : ''}`;
      if (skipped.length) msg += ` · skipped ${skipped.join(', ')}`;
      toast(msg);
      closeMenu();
    } catch (err) {
      console.error('[yt-toolkit]', err);
      toast(`Error: ${err.message}`, false);
    } finally {
      copyBtn.textContent = original;
      copyBtn.disabled = false;
    }
  }

  // ─── Mount + SPA glue ────────────────────────────────────────────────────
  function mountButton() {
    const root = document.getElementById('yt-toolkit-root');
    // Show on watch pages and Shorts; remove the widget elsewhere (SPA nav).
    if (!isWatch() && !isShorts()) {
      if (root) root.remove();
      return;
    }
    closeMenu(); // navigation → drop any stale open menu
    ensureUI();
    updateChrome(); // theme colors + fullscreen visibility

    // Arrived at the watch page from a Short → auto-copy the transcript once the
    // transcript control has hydrated (a fresh load may still be building UI).
    if (isWatch()) {
      const autoId = sessionStorage.getItem(AUTORUN_KEY);
      if (autoId && autoId === currentV()) {
        sessionStorage.removeItem(AUTORUN_KEY);
        wait(() => findShowTranscriptButton() != null || hasSegments(), 8000).then(autoCopyTranscript);
      }
    }
  }

  // YouTube is a SPA: navigating home → video fires `yt-navigate-finish` with no
  // document reload, so the userscript only auto-injects on a HARD load of a
  // /watch URL. Re-mount on every in-app navigation so the widget appears no
  // matter how you arrived. mountButton() is idempotent and removes itself off
  // watch/Shorts pages, so firing it on each navigation is safe.
  window.addEventListener('yt-navigate-finish', mountButton);

  // Fullscreen and theme can toggle without any navigation, so update the
  // chrome directly on those events too.
  document.addEventListener('fullscreenchange', updateChrome);
  // YouTube flips the `dark` attribute on <html> when you change the theme.
  new MutationObserver(updateChrome).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['dark'],
  });

  mountButton();
})();
