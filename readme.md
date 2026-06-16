# YT Toolkit

A userscript that adds small tools to YouTube watch pages. No build step, no
npm, no dependencies — it's a single standalone `.user.js` file.

## Tools

- **Transcript → Markdown** — a floating **📋 Transcript** button auto-opens the
  transcript panel, reads it, and copies chapter-grouped prose with clickable
  timestamp links to your clipboard. Paste it anywhere (notes, docs, an LLM).

### Planned

- **Description → Markdown** — export the video description + links.
- **Ask AI** — send the transcript/description to an LLM and ask about the video.

## Install

You need a userscript manager — **[Violentmonkey]** or **[Tampermonkey]** (both
work on Chrome and Firefox). Then:

- **Now:** open `yt-toolkit.user.js`, copy its contents, and create a new script
  in the manager.
- **Later (once this is on GitHub):** point the manager at the raw
  `yt-toolkit.user.js` URL for one-click install **+ auto-update on push**.

[Violentmonkey]: https://violentmonkey.github.io/
[Tampermonkey]: https://www.tampermonkey.net/

> The manager keeps its **own copy** of the script. After editing the file,
> re-import it into the manager for changes to take effect.

## How it works

Browsers can't write local files, so each tool **copies to the clipboard**
rather than saving. The transcript reader walks YouTube's live DOM (handling
both the "classic" and "viewmodel" transcript layouts) and groups segments into
paragraphs — it doesn't scrape a saved HTML dump.

Clipboard write prefers `navigator.clipboard.writeText` (verifiable) and falls
back to `GM_setClipboard`.

## Notes

YouTube is a single-page app, so the button re-mounts on in-app navigation
(`yt-navigate-finish`), not just on hard page loads.
