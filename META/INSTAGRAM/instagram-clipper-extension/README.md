# Instagram Clipper (personal use)

© Venkata Bhattaram

Captures posts that render on your screen as you manually scroll Instagram
(feed or reels). It does not navigate, paginate, or scroll on its own —
it only reads what's already in the DOM because you put it there by
browsing normally.

There is exactly one UI: an on-page widget (top-right corner), with two
tabs:

- **Status** — folder, pause/resume, capture counts
- **Console** — read-only diagnostics for when Instagram changes its markup
  (see "If capture stops working" below)

The widget has three states — **Expanded**, **Compact** (via "–"), and
**Hidden** (via "×") — same behavior as the LinkedIn Clipper this was built
from. Clicking the extension's toolbar icon toggles hidden/expanded.

## Load it

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" and select this `instagram-clipper-extension` folder

## Use it

1. Go to Instagram and browse your feed
2. The widget appears top-right. Click **Choose Folder** once — this opens
   your OS's real folder picker (File System Access API)
3. Scroll normally — each post in view gets captured (auto-expanding the
   "more" caption toggle first)
4. About 3 seconds after each new batch, the CSV is written into your
   chosen folder as `instagram_<mon>_<dd>.csv`, overwritten in place
5. **Pause** / **Resume**, or press **Alt+Shift+I** anytime
6. "–" collapses to compact (keeps capturing); "×" hides it (capturing
   keeps running in the background; toolbar icon brings it back)

## Why extraction may be fragile — and what to do about it

Instagram's markup uses short, obfuscated, frequently-rotating class names.
This extension identifies a post by its permalink shortcode
(`/p/<shortcode>/` or `/reel/<shortcode>/`), finds the post container via
the `<article>` tag (still used per-post in the feed), and reads the
timestamp from the `<time>` element (semantic HTML, relatively stable).

The caption is the fragile part: Instagram exposes no equivalent of
LinkedIn's text-container class or Facebook's `data-ad-preview`. This
extension guesses the caption as the longest leaf text node inside the post
that isn't in the `<header>` (author byline) — a heuristic, not a
guarantee. If captions come through empty or wrong, that's the first place
to look.

**If capture stops working** (counter stuck at 0, no CSV appears, or
captions are consistently blank/wrong):

1. Open the widget's **Console** tab
2. Click **Probe /p//reel/ hrefs** — lists any shortcode-shaped links, so
   you can see if Instagram changed the URL shape
3. Or type any CSS selector (e.g. `article`, `article header a`, `time`)
   into the box and hit **Run** to see how many elements match and what
   they look like
4. Report the output back (there's a **Copy Output** button) so the
   selectors in `content.js` can be updated

There is no free-form JS console here — Instagram's own Content-Security-Policy
blocks `eval`/`Function()` even from a content script's isolated world, so
the Console tab only runs fixed, pre-written, read-only checks.

## About folder access (browser security, not a choice I made)

Same as the LinkedIn Clipper: the File System Access API only lets a page
write to a folder after you explicitly grant it via the picker. Chrome
remembers the grant per profile; if it ever forgets, the widget shows
"Grant Folder Access" instead of "Choose Folder".

## Notes / limitations

- The capture count and CSV are shared across all your Instagram tabs.
- Dedup is keyed by the shortcode-derived post id in storage itself, so
  reloading a tab or revisiting a page won't create duplicate CSV rows.
- Posts where no `/p/` or `/reel/` link can be found inside the `<article>`
  are skipped entirely (no fuzzy fallback id).
- This is scoped to what you personally scroll past; it is not a
  background/unattended scraper.
- Data lives in the extension's local storage and your chosen folder only;
  nothing is sent anywhere else.
