# Social Media Clipper System — Overview

© Venkata Bhattaram

Start here if you're new to this project. This folder (`docs/`) is meant to
be shared with teammates as a standalone summary of what exists, how it
works, and what's still open — without needing to read the full build
history.

## What this is

A set of personal-use Chrome extensions (Manifest V3) that capture posts as
you manually scroll a social platform, and export them to CSV on your own
machine. Nothing is scraped automatically or sent to any server — capture
only happens for posts that render on your screen because you scrolled to
them yourself.

Three extensions exist today, one per platform, each independently loadable:

| Platform  | Folder                                      | Status |
|-----------|----------------------------------------------|--------|
| LinkedIn  | `LINKEDIN/linkedin-clipper-extension/`        | Working — actively tested and fixed through several DOM-change cycles |
| Facebook  | `META/FB/fb-clipper-extension/`               | Built, not yet live-tested (no logged-in FB session available during build) |
| Instagram | `META/INSTAGRAM/instagram-clipper-extension/` | Built, not yet live-tested (same reason); caption extraction is the most likely thing to need tuning |

Each extension's own `README.md` has load/use instructions specific to that
platform. This `docs/` folder covers what's common across all three and the
reasoning behind it.

## Shared design

All three extensions share the same architecture, deliberately kept
identical so a fix or pattern learned on one platform transfers to the
others:

- **On-page floating widget** (top-right corner), not a toolbar popup.
  Toolbar icon click toggles it hidden/expanded. Three widget states:
  Expanded, Compact ("–"), Hidden ("×", capturing still runs in the
  background).
- **Two tabs**: **Usage** (folder picker, Start/Pause/Resume, capture
  counts) and **Debug** (live log + read-only DOM diagnostics — see
  [skills.md](skills.md) for why it's read-only).
- **Color status LED**: green = capturing normally, amber = paused or not
  yet started, red = folder needs picking/re-granting.
- **Explicit Start**: capturing never begins just because the page loaded.
  The Pause/Resume button starts as **Start**; once clicked it becomes
  Pause/Resume for the rest of that page's lifetime and never reverts,
  until the tab or extension reloads.
- **Folder picker** via the File System Access API — writes CSVs straight
  to a real folder on disk, not the Downloads folder. The folder handle is
  remembered (in IndexedDB) across reloads; if Chrome ever forgets the
  grant, the widget offers a one-click re-grant instead of re-picking.
- **One CSV per session**, filename stamped with when that session's Start
  was clicked (e.g. `linkedin_2026-08-16_14-32-05.csv`), so reloading the
  tab produces a fresh, separately traceable file rather than silently
  overwriting the last one.
- **Global, cross-session, cross-tab dedup** keyed by a per-platform post
  id, stored in `chrome.storage.local`. A post captured in any earlier
  session never reappears in a later session's file.

See [skills.md](skills.md) for the technical patterns and platform-specific
extraction details, and [memory.md](memory.md) for the chronological record
of what was tried, what broke, and why things are built the way they are.

## What's not built yet

From the original spec (see `LINKEDIN/to-do.md`):

- **Media capture** (image/PDF/video → a `/media` subfolder, linked from
  the CSV row). Deliberately deferred — real CORS uncertainty that can't be
  verified without a live, logged-in browsing session, and it made more
  sense to get text capture solid first.
- **Google (YouTube, Search, Maps)** support — mentioned in the root
  `README.md` as a future platform, not started.
- **Backend agentic loop** that auto-detects DOM changes and pushes
  selector fixes to the extensions automatically — currently this is a
  manual loop instead (see [skills.md](skills.md) → "The Debug tab
  pattern").
