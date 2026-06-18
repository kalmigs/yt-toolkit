// ==UserScript==
// @name         YT Toolkit
// @namespace    https://github.com/kalmigs/yt-toolkit
// @version      0.1.0
// @description  Toolkit for YouTube. Tool 1: copy the (auto-opened) transcript as chapter-grouped Markdown with timestamp links — works on watch pages and Shorts. More coming — description export, Ask AI.
// @author       kal
// @match        https://www.youtube.com/watch*
// @match        https://www.youtube.com/shorts/*
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes
// ==/UserScript==
//
// A userscript is a single standalone file (the manager can't require() modules),
// so everything is inlined here — the pure formatting helpers (tsToSeconds, tsLink,
// formatSections, FLUSH_EVERY), the live-DOM transcript reader, and the page glue.
// No build step, no dependencies.

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

  function tsLink(ts, videoUrl) {
    if (!videoUrl) return `[${ts}]`;
    try {
      const u = new URL(videoUrl);
      u.searchParams.set('t', `${tsToSeconds(ts)}s`);
      return `[\`${ts}\`](${u.toString()})`;
    } catch {
      return `[${ts}]`;
    }
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

  // ─── DOM reader (replaces the CLI's regex parseTranscript) ───────────────
  // YouTube ships two transcript DOM shapes; both are handled by reading live
  // nodes in document order and assigning each segment to the last-seen chapter.
  const SEG_SEL = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
  const CH_SEL = 'ytd-transcript-section-header-renderer, .ytwTimelineChapterViewModelTitle';

  const txt = (el) => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();

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
    const nodes = document.querySelectorAll(`${SEG_SEL}, ${CH_SEL}`);
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

  // ─── Build the Markdown ──────────────────────────────────────────────────
  function buildMarkdown() {
    const { videoUrl, title, channel, channelUrl } = getMeta();
    const chapters = parseTranscriptDOM();
    const total = chapters.reduce((n, c) => n + c.segments.length, 0);
    if (!total) return null;

    const created = new Date().toISOString().slice(0, 10);
    const sections = formatSections(chapters, { videoUrl, chHeading: '##' });
    // Same escaping rationale as the title: channel names can carry ':' and
    // quotes. Omit the field entirely when the channel can't be read rather
    // than emitting an empty/`null` value.
    const fm = [
      '---',
      `title: ${JSON.stringify(title)}`,
      ...(channel ? [`channel: ${JSON.stringify(channel)}`] : []),
      `source: ${JSON.stringify(videoUrl)}`,
      `created: ${created}`,
      '---',
    ];
    // Attribution line: "Channel · Source video", each linked when we have a URL.
    const channelLink = channel
      ? channelUrl
        ? `[${channel}](${channelUrl})`
        : channel
      : null;
    const attribution = [channelLink, `[Source video](${videoUrl})`]
      .filter(Boolean)
      .join(' · ');
    const md = [
      ...fm,
      '',
      `# ${title}`,
      '',
      `> ${attribution}`,
      '',
      sections.join('\n'),
    ].join('\n');
    return { md, chapters: chapters.length, total };
  }

  // ─── UI: floating button + toast ─────────────────────────────────────────
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

  async function run(btn) {
    const original = btn.textContent;
    btn.textContent = '⏳ reading…';
    btn.disabled = true;
    try {
      const opened = await ensureTranscriptOpen();
      if (!opened) {
        toast('No transcript found for this video.', false);
        return;
      }
      const result = buildMarkdown();
      if (!result) {
        toast('Transcript panel is open but empty — try again.', false);
        return;
      }
      await copy(result.md);
      toast(`✓ Copied ${result.total} segments · ${result.chapters} chapter(s)`);
    } catch (e) {
      console.error('[yt-transcript]', e);
      toast(`Error: ${e.message}`, false);
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
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

  // Shorts have no transcript panel to scrape, but the SAME video plays at
  // /watch?v=<id> with the full UI (transcript button included). So on a Short
  // we stash the id and bounce to the watch page, where mountButton() picks up
  // the flag and auto-runs the existing flow.
  function openShortAsWatch() {
    const id = shortsId();
    if (!id) {
      toast('Could not read this Short’s video id.', false);
      return;
    }
    sessionStorage.setItem(AUTORUN_KEY, id);
    location.href = `https://www.youtube.com/watch?v=${id}`;
  }

  function mountButton() {
    const existing = document.getElementById('yt-transcript-copy-btn');
    // Show on watch pages and Shorts; remove the button elsewhere (SPA nav).
    if (!isWatch() && !isShorts()) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      const btn = document.createElement('button');
      btn.id = 'yt-transcript-copy-btn';
      btn.textContent = '📋 Transcript';
      Object.assign(btn.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: 99999,
        padding: '10px 16px',
        borderRadius: '20px',
        border: 'none',
        cursor: 'pointer',
        font: '600 13px/1 Roboto, system-ui, sans-serif',
        color: '#fff',
        background: '#0f0f0f',
        boxShadow: '0 2px 10px rgba(0,0,0,.4)',
      });
      // isShorts() is read at click time, so the same button works on both
      // page types as you navigate the SPA.
      btn.addEventListener('click', () => (isShorts() ? openShortAsWatch() : run(btn)));
      document.body.appendChild(btn);
    }

    // Arrived at the watch page from a Short → auto-run once the transcript
    // control has hydrated (a fresh load may still be building the UI).
    if (isWatch()) {
      const autoId = sessionStorage.getItem(AUTORUN_KEY);
      if (autoId && autoId === currentV()) {
        sessionStorage.removeItem(AUTORUN_KEY);
        const btn = document.getElementById('yt-transcript-copy-btn');
        wait(() => findShowTranscriptButton() != null || hasSegments(), 8000).then(() => run(btn));
      }
    }
  }

  // YouTube is a SPA: navigating home → video fires `yt-navigate-finish` with no
  // document reload, so the userscript only auto-injects on a HARD load of a
  // /watch URL. Re-mount on every in-app navigation so the button appears no
  // matter how you arrived. mountButton() is idempotent and removes itself off
  // /watch pages, so firing it on each navigation (and possible re-injection) is
  // safe.
  window.addEventListener('yt-navigate-finish', mountButton);
  mountButton();
})();
