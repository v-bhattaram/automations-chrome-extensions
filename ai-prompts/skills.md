# skills.md — technical patterns behind the Social Media Clipper System

© Venkata Bhattaram

This is the "how it works and why" reference — the transferable knowledge
from building three near-identical extensions against three different,
actively-changing, obfuscated-markup social platforms. Read this before
extending an existing clipper or building a new one (e.g. Google/YouTube).

## 1. Content-script CSP blocks eval — diagnostics must be code-free

**The problem:** the first version of the LinkedIn Debug tab let you type
arbitrary JS into a textbox and ran it with `new Function(code)()`. On a
real LinkedIn page this threw:

```
Error: Evaluating a string as JavaScript violates the following Content
Security Policy directive: script-src 'self' ... 'unsafe-eval' is not an
allowed source of script.
```

Chrome extension content scripts run in an "isolated world" that shares the
page's DOM but has its own JS realm — historically this meant they were
*not* bound by the host page's CSP. That's no longer true for `eval`/
`Function()`: modern Chrome enforces the page's `script-src` against the
isolated world too, specifically to close this exact loophole. If the site
sends a CSP without `'unsafe-eval'`, a content script cannot evaluate a
string as code — full stop, regardless of extension permissions.

**The fix:** every diagnostic tool in the Debug tab is a fixed,
pre-written, read-only function — never a string that gets evaluated:

- `probeSelector(selector)` — runs a **CSS selector** (not code) through
  `document.querySelectorAll`, which is a normal DOM API call, not code
  execution. Shows match count + a readable summary (tag, non-class
  attributes, visible text) of the first few matches.
- Platform-specific one-click presets (`probeUrnAttributes`,
  `probePermalinkHrefs`, `probeShortcodeHrefs`) that scan for a specific
  known pattern.

This is the pattern to reuse for any future platform: give the user a
selector box + preset buttons, never a code box.

## 2. The Debug tab pattern (manual "agentic loop" substitute)

The root `README.md` describes an aspirational "Backend Agentic Loop" that
auto-detects DOM changes and pushes fixes. That doesn't exist yet — what
exists instead is a **fast manual loop**, and it's worth understanding
because it's how every extraction bug in this project actually got fixed:

1. Widget's Debug tab shows a **live log** (captures, saves, failures,
   with an HTML snippet on failure) — mirrors every `log()` call from
   `content.js`, not just `console.log`. This means failures are visible
   to a non-technical user without opening DevTools.
2. When capture stalls, the user runs a preset probe or a custom CSS
   selector, copies the output (`Copy Output` / `Copy Log` buttons —
   `navigator.clipboard.writeText`, works from a content script off a user
   gesture without extra permissions), and pastes it back.
3. That output — real attribute names/values from the live page — is what
   lets selectors get updated correctly on the first guess instead of by
   trial and error against a page nobody but the user can see live.

**Why this matters for future work:** none of this project's iteration
could have happened by guessing. Every selector fix in every platform's
`content.js` traces back to a probe's output. If automating "detect +
fix" is ever built, this is the manual version it needs to replace.

## 3. Storage race condition: read-modify-write needs a lock

**The bug:** `chrome.storage.local` posts get deduped in an id-keyed map
(`{ [id]: record }`, not an array). Saving a post means: read the map,
add one key, write the whole map back. When multiple posts get captured
in the same animation frame (common — a `MutationObserver` fires once per
DOM batch, and `scan()` calls `capturePost()` for every in-view post
without awaiting between them), two concurrent read-modify-write cycles
can interleave: both read the same starting map, both add their own
record to their own copy, and the second `set()` call clobbers the first
— silently dropping a capture. This was the actual root cause of "the
counter is inconsistent" early in the LinkedIn build.

**The fix** — serialize all writes through a single promise chain so each
one waits for the previous one to finish:

```js
let storageWriteChain = Promise.resolve();

function saveRecord(record) {
  const run = async () => {
    const map = await getPostsMap();
    map[record.id] = record;
    await chrome.storage.local.set({ [STORAGE_KEY]: map });
  };
  // .catch(() => {}) so one failed write doesn't permanently wedge every
  // write after it — the chain must keep moving even if one link breaks.
  const next = storageWriteChain.catch(() => {}).then(run);
  storageWriteChain = next;
  return next;
}
```

This pattern is identical across all three extensions' `content.js`.

## 4. The "Start" gate — don't auto-start on page load

**The bug:** capturing used to begin automatically whenever the widget
loaded (if the persisted "active" setting was true, which is the default).
This produced a confusing state: the LED shows green, a folder is set, but
nothing gets captured — because the *real* problem (stale selectors) was
happening silently, and there was no way to tell "capturing is running but
finding nothing" apart from "capturing never started."

**The fix:** an in-memory (not persisted) `hasStarted` flag, false on every
fresh page load. The Pause/Resume button reads as **Start** until clicked
once; after that it's Pause/Resume for the rest of that page's lifetime and
never reverts to Start until the tab or extension reloads. The status LED
also treats "not started" as amber, not green, so "nothing is happening"
and "capturing but finding nothing" are now visually distinguishable — the
first shows amber, the second shows green with a log full of failures.

## 5. Per-platform extraction hooks

Every platform obfuscates class names and rotates them frequently — the
patterns below were chosen specifically because they're *not* class names,
so they survive markup churn better (though never permanently — see
section 2 for what to do when they eventually break too).

### LinkedIn

- **Post id**: `[data-urn]` was the original hook and *disappeared*
  entirely at some point (confirmed via the Debug tab: 0 matches on a page
  full of visible posts). The replacement, found via probing: some
  elements carry a `componentkey` attribute whose *value* contains a
  `urn:li:...` string (most `componentkey` values are random UUIDs from
  unrelated UI components — only a handful per page are the real thing, so
  the selector must be `[componentkey*="urn:li:"]`, not `[componentkey]`
  alone). Current selector: `[data-urn], [data-id], [componentkey*="urn:li:"]`
  — keeps the legacy hooks as free, harmless fallbacks.
- **Text/author**: the urn-bearing element is sometimes a small
  sub-component (e.g. just an avatar link), not the whole post, so
  `findContentContainer()` walks up to 6 ancestors looking for one that
  yields text before giving up. Extraction itself tries the legacy fixed
  class names first (`.update-components-text`, etc. — cheap, harmless if
  they never match again), then falls back to a heuristic: the longest
  leaf text block that isn't inside a link/button (author name and
  timestamp are almost always short anchors; body text isn't). Author
  falls back to the first `a[href*="/in/"], a[href*="/company/"]` link —
  this specific pattern was already proven reliable elsewhere in the same
  file (`detectSource` used it for "is this a company post" long before
  the componentkey fix existed).

### Facebook

- **Post container**: `[role="article"]` — an ARIA role, not a class name,
  and Facebook has used it for feed posts for years for accessibility
  reasons. More stable than anything class-based.
- **Post id**: no equivalent of LinkedIn's urn exists. Instead, scan every
  `<a href>` inside the article for a permalink-shaped URL —
  `/posts/(\d+)`, `story_fbid=(\d+)`, `/permalink/(\d+)`, `/videos/(\d+)`
  — and use the first match as the id (and the href itself, minus query
  string, as the permalink — no separate "build the permalink" step
  needed like LinkedIn's urn-to-URL reconstruction). **Not yet verified
  live** — this is the first thing to check with the Debug tab's
  "Probe permalink hrefs" button if capture doesn't work.
- **Text**: `[data-ad-preview="message"]` / `[data-ad-comet-preview="message"]`
  — a Facebook-internal attribute used for post/ad bodies, observed to be
  more stable than class names across redesigns (unverified for the
  current markup — same caveat as above).

### Instagram

- **Post container**: the `<article>` tag — Instagram still wraps each
  feed post in one.
- **Post id**: the permalink shortcode, `/p/<shortcode>/` or
  `/reel/<shortcode>/`, found via `a[href*="/p/"], a[href*="/reel/"]`
  inside the article. This is Instagram's actual stable permalink scheme
  (has been for years), unlike LinkedIn/Facebook where the id had to be
  reverse-engineered from internal attributes.
- **Timestamp**: the `<time>` element (`datetime` attribute, ISO 8601) —
  semantic HTML, not a class name.
- **Caption (the fragile part)**: Instagram exposes no stable
  "this is the caption" hook at all, unlike the other two platforms. The
  heuristic: the longest leaf text block inside the post that isn't inside
  the `<header>` (author byline). This is the most likely thing to need
  correcting once this extension is actually tested against a live,
  logged-in session.

## 6. Icon generation

All three extensions' icons are generated programmatically (Python + PIL,
`icons/generate_icons.py` in each extension folder) rather than
hand-drawn — a paperclip shape (two nested rounded-rectangle outlines,
rotated 35°) on a brand-colored background: LinkedIn blue, Facebook blue,
Instagram's diagonal gradient (approximated with a per-pixel lerp between
its brand colors, masked to a rounded square). Re-run the script after
editing it; it overwrites `icon16/32/48/128.png` in place.

## 7. Manifest V3 basics used throughout

- `background.js` (service worker) only relays two things: the toolbar
  icon click (`chrome.action.onClicked` → sends `TOGGLE_WIDGET` to the
  active tab) and the keyboard shortcut (`chrome.commands.onCommand` →
  sends `TOGGLE_PAUSE`). All actual state and logic lives in the content
  script — the widget owns everything. This file is identical (verbatim)
  across all three extensions.
- No popup (`action.default_popup` is intentionally unset) — clicking the
  toolbar icon toggles the on-page widget instead of opening a separate
  UI, so there's exactly one place state lives and gets rendered.
- Each extension needs its own `commands.toggle-pause.suggested_key` if
  more than one might be loaded at once — reused shortcuts across
  concurrently loaded extensions only fire for one of them. Current
  assignment: LinkedIn `Alt+Shift+P`, Facebook `Alt+Shift+F`, Instagram
  `Alt+Shift+I`.
