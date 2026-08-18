# memory.md — project history and decisions

© Venkata Bhattaram

A chronological record of how the Social Media Clipper System got to its
current state: what was reported, what was tried, what worked, and what's
still open. Read [OVERVIEW.md](OVERVIEW.md) first for the current-state
summary; this file is the "why is it built this way" backstory, and
[skills.md](skills.md) is the extracted technical patterns.

## Origin

The project started from `LINKEDIN/to-do.md`, which evolved over the
course of the build from a short punch list into a fuller spec:

> Current Issues in clipper extension
> - The counter is not incrementing, its inconsistant
> - Show Green when all is good, create a green led like dot
> - show folder name where the data is written
> - Rename to LinkedIN Clipper
> - LinkedIN Icon
> - Add (c) Venkata Bhattaram

...then later, once the extension existed and was tested against a real
LinkedIn account, it was rewritten into a broader system spec covering all
three platforms (folder selection, per-day/run CSVs, media capture,
pause/resume, a debug tab) plus a fresh, more specific bug report:

> Issues with Linkedin
> - The status is green and I set folder but parsing doesnt happen
> - even if I refresh, it works after a few tries

## Timeline

1. **Initial LinkedIn build-out.** Starting point was an existing
   `clipper-extension/` with the on-page widget, folder picker, pause/
   resume, and urn-keyed storage already in place. Added: the green LED
   status dot, a visible "saving to: folder/" label, a rename to
   "LinkedIn Clipper," generated icons, and a `(c) Venkata Bhattaram`
   copyright line. Folder renamed to `linkedin-clipper-extension/` at some
   point during testing (outside this conversation).

2. **"Counter not increasing" bug #1 — storage race condition.** Traced to
   concurrent `saveRecord()` calls doing an unsynchronized read-modify-
   write on `chrome.storage.local`, silently dropping captures when
   multiple posts were captured in the same animation frame. Fixed by
   chaining all writes through a single promise (see skills.md §3).

3. **"Counter not increasing" bug #2 — LinkedIn changed its DOM.** After
   the race-condition fix, the counter *still* didn't move. Added
   temporary `console.log` diagnostics, which reported: `no [data-urn]
   elements found on page`. LinkedIn had removed the `data-urn` attribute
   the extraction logic depended on entirely.

4. **First diagnostic-console attempt (failed on CSP).** Built a
   free-form JS textbox + "Run" button into the widget so the user could
   run diagnostic snippets without switching to DevTools. On the real
   LinkedIn page this threw a CSP violation — `eval`/`Function()` is
   blocked in content scripts by a page without `'unsafe-eval'` in its
   `script-src` (see skills.md §1). Rebuilt as a **read-only** tool: a CSS
   selector box (`querySelectorAll`, not code) plus fixed preset probes.

5. **Finding the replacement hook.** Using the new selector probe, the
   user found: `content: 1, componentkey: 8, id: 2` elements matched an
   urn-like-attribute scan. Narrowed further (`[componentkey*="urn:li:"]`)
   to filter out ~400 unrelated UI elements with random UUID
   `componentkey`s, down to the ~8 that correspond to real posts.

6. **Applying the fix, plus a fuller rewrite driven by the new spec.**
   Once `to-do.md` was rewritten with the broader system spec and the more
   specific "status is green but parsing doesn't happen" report, the
   extraction logic was rebuilt: broadened post-id selector
   (`[data-urn], [data-id], [componentkey*="urn:li:"]`), an ancestor-walk
   to find the real content container from a urn-bearing sub-element, and
   heuristic text/author extraction fallbacks (no longer solely dependent
   on LinkedIn's old, now-stale, fixed class names). Also added: a
   persistent in-widget **live debug log** (mirrors every diagnostic
   `log()` call, not just console output) so failures are visible without
   DevTools, tabs renamed **Usage**/**Debug** to match the spec's wording,
   and session-scoped CSV export (one file per Start-click, timestamped,
   instead of one cumulative file overwritten per day).

7. **Facebook and Instagram extensions built.** Same architecture,
   ported extraction logic per-platform (see skills.md §5 for the
   specifics and honesty about what's unverified). Saved to
   `META/FB/fb-clipper-extension/` and
   `META/INSTAGRAM/instagram-clipper-extension/` per the user's request
   (those folders already existed as empty placeholders under `META/`).
   **Media capture** (images/PDF/video → linked CSV entries) was
   explicitly scoped out of this pass — flagged to the user as the next
   step once text capture is confirmed solid on a live account, rather
   than building an unverifiable feature (real CORS risk) on top of a
   foundation that had just been found broken.

8. **"Its auto starting the clipping" — the Start gate.** Even after the
   parsing fix, capturing began automatically whenever the widget loaded
   (green LED, folder set, but the *actual* problem was silent stale-
   selector failures underneath). The user asked for an explicit
   Start/Pause/Resume flow where Start never reappears once clicked until
   reload. Implemented as an in-memory `hasStarted` flag (see skills.md
   §4); the LED logic was also corrected so "not started yet" and
   "actually capturing" are distinguishable in the UI (amber vs. green)
   rather than both reading as an ambiguous green.

## Current state (as of this doc)

- **LinkedIn**: built, fixed through multiple real-DOM iterations, Start-
  gated. Should be considered the most trustworthy of the three, but its
  extraction selectors are inherently fragile (see skills.md §5) and will
  likely need another round the next time LinkedIn redesigns.
- **Facebook / Instagram**: built with the same architecture and
  Start-gating, but extraction selectors are **best-effort guesses never
  verified against a live logged-in session**. Expect to go through the
  same probe-and-fix loop that LinkedIn already went through (see
  skills.md §2 for exactly how).
- **Not built**: media capture, Google/YouTube/Search/Maps support, any
  automatic DOM-change detection (the "Backend Agentic Loop" from the root
  `README.md` is still just an idea — the Debug tab is its manual
  stand-in for now).

## Open questions for the team

- Should media capture download via in-page `fetch()` (subject to CORS per
  host) or route through the background service worker with broader
  `host_permissions` for the CDN domains? Neither has been tried yet.
- Is a shared/common `content.js` core (storage, CSV, widget chrome, debug
  console) worth factoring out now that three near-identical copies exist,
  or is duplication still cheaper while extraction logic is this
  unstable per platform?
