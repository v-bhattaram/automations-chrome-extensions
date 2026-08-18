# LinkedIn Clipper (personal use)

© Venkata Bhattaram

Captures posts that render on your screen as you manually scroll LinkedIn
(feed, a group, a company page, a profile). It does not navigate, paginate,
or scroll on its own — it only reads what's already in the DOM because you
put it there by browsing normally.

There is exactly one UI: an on-page widget (top-right corner), with two
tabs — **Usage** (folder, pause/resume, counts) and **Debug** (a live log
of captures/saves/failures, plus read-only DOM probes for when LinkedIn
changes its markup — see "If capture stops working" below). There is no
separate toolbar popup. The widget has three states:

- **Expanded** — full controls (folder, pause/resume, count)
- **Compact** — collapsed to just the header, via the "–" button
- **Hidden** — removed entirely, via the "×" button

Clicking the extension's toolbar icon toggles the widget between hidden and
expanded on whichever tab is active — that's the only thing the icon does
now (no popup opens).

## Load it

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" and select this `clipper-extension` folder

## Use it

1. Go to LinkedIn and browse to the group / feed / company page you want
2. The widget appears top-right. Click **Choose Folder** once — this opens
   your OS's real folder picker (via the File System Access API), so you
   pick an actual directory on disk, not just a name under Downloads
3. Click **Start** (or press **Alt+Shift+P**). Capturing never begins on
   its own just because the page loaded — it's a deliberate action, once
   per session. After that first click the button becomes **Pause**/
   **Resume** for the rest of this page's lifetime and never shows
   **Start** again until you reload the tab or reload the extension
4. Scroll normally — each post in view gets captured (auto-expanding
   "…see more" first) and tagged with its source: `group`, `company`, or
   `user`
5. About 3 seconds after each new batch of posts, the CSV is written
   directly into your chosen folder as `linkedin_<date>_<time>.csv`
   (e.g. `linkedin_2026-08-16_14-32-05.csv`), stamped with when *this*
   session started (i.e. when you clicked **Start**) and overwritten in
   place as more posts come in *during that session*. Reloading the tab
   starts a new session — and a new file — rather than overwriting the
   previous one; a post already captured in an earlier session (tracked in
   storage, not just in the file) never shows up again in a later
   session's file
6. Click **Pause** to stop capturing without losing anything already
   captured; click **Resume** to continue, or press **Alt+Shift+P** anytime
   (works even if the widget is hidden). The underlying "active" flag is
   shared across tabs, but each tab still needs its own **Start** click —
   pausing on one tab does not silently start capturing on another
7. Click "–" to collapse the widget to compact mode — it keeps capturing
   while compact
8. Click "×" to hide the widget entirely — capturing keeps running in the
   background; click the toolbar icon to bring the widget back
9. The widget shows two numbers: a total count (everything ever captured,
   across all tabs and visits) and a green "N new this visit" line — how
   many *this* tab has added since it loaded, so you can tell at a glance
   whether a re-visit to a group actually turned up anything new

The exported CSV is the input to the separate Python/Ollama classification
script (job-post detection, remote/onsite tagging, multi-position splitting,
email extraction, final CSV).

## About folder access (browser security, not a choice I made)

The File System Access API only lets a page write to a folder after you
explicitly grant it via the picker — there's no way around that prompt,
by design, for any website or extension. Chrome remembers the grant for
that folder per browser profile, so you normally only pick it once; if
Chrome ever forgets (profile restart, permission reset), the widget will
show "Grant Folder Access" instead of "Choose Folder" so you can re-approve
the same folder with one click, without picking it again.

## If capture stops working

LinkedIn's class names are short, obfuscated, and rotate often — as of this
version, post identification uses `[data-urn]`, `[data-id]`, or (the
current one, discovered after `data-urn` disappeared) any element whose
`componentkey` attribute contains a `urn:li:...` value. Text and author
extraction try the old fixed class names first, then fall back to
structural heuristics (longest non-link text block; first `/in/` or
`/company/` profile link) that don't depend on exact class names.

If the counter stalls again or a file stops appearing:

1. Open the widget's **Debug** tab — the live log shows exactly what's
   failing (no urn-bearing elements found at all vs. elements found but no
   text extracted, with an HTML snippet either way)
2. Use **Probe urn-like attrs** / **Probe urn componentkeys**, or type any
   CSS selector into the box and hit **Run**, to check candidate hooks
   directly against the live page
3. There's no free-form JS console — LinkedIn's CSP blocks `eval`/`Function()`
   even from a content script — so these are fixed, pre-written, read-only
   checks
4. **Copy Log** / **Copy Output** to report back what you're seeing, so
   `content.js`'s selectors in the "extraction" section can be updated

## Notes / limitations

- Source detection (`group` / `company` / `user`) is based on the current
  page URL and the post author's profile link; LinkedIn's markup for this
  can vary, so spot-check a few rows after export.
- The capture count and CSV are shared across all your LinkedIn tabs (they
  all write to the same local storage and, once granted, the same folder),
  so scrolling multiple tabs adds to one running total.
- Dedup is keyed by post URN in storage itself (not just in-memory per tab),
  so reloading a tab, reopening a group you already scraped, or having the
  same page open in two tabs will not create duplicate CSV rows — existing
  posts are recognized and skipped, only genuinely new ones are added.
- If you had captured data from before this update, it's auto-migrated
  from the old array format to the new keyed format the first time the
  widget loads — no action needed, nothing is lost.
- This is scoped to what you personally scroll past; it is not a
  background/unattended scraper and doesn't run when you're not actively on
  a LinkedIn tab.
- Data lives in the extension's local storage and your chosen folder only;
  nothing is sent anywhere else.
