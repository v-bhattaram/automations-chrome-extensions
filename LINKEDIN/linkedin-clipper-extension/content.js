// Reacts only to what's already rendered in the page as you scroll.
// Does not navigate, paginate, or make requests beyond what LinkedIn's
// own UI would already do when you click "see more" yourself.
(function () {
  const STORAGE_KEY = "clippedPosts"; // stored as { [urn]: record } — a map, not an array
  const SETTINGS_KEY = "clipperSettings"; // { active: bool }
  const IDB_NAME = "li-clipper-db";
  const IDB_STORE = "handles";
  const IDB_HANDLE_KEY = "csvFolder";
  const DEBOUNCE_MS = 3000;

  const seen = new Set(); // every urn already known to storage (any tab, any visit)
  let scanQueued = false;
  let observer = null;
  let saveTimer = null;
  let folderHandle = null;
  let widgetState = "expanded"; // "expanded" | "compact" | "hidden"
  let sessionCount = 0; // posts captured by *this* tab since it loaded
  let sessionRecords = []; // this tab's captures this session — what gets written to this session's CSV
  let sessionStartedAt = null; // set once at boot; stamps this session's CSV filename
  let activeTab = "status"; // "status" | "console"

  // ---------- debug logging, mirrored into the widget's Debug tab so
  // parsing failures are visible without opening DevTools ----------

  const DEBUG_LOG_MAX = 100;
  const debugLog = [];

  function formatLogArg(a) {
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }

  function refreshDebugLogPanel() {
    const el = document.getElementById("li-clipper-debug-log");
    if (!el) return;
    el.textContent = debugLog.length ? debugLog.join("\n") : "(no log entries yet)";
    el.scrollTop = el.scrollHeight;
  }

  function log(...args) {
    const line = `[${new Date().toLocaleTimeString()}] ${args.map(formatLogArg).join(" ")}`;
    debugLog.push(line);
    if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
    console.log("[LI Clipper]", ...args);
    refreshDebugLogPanel();
  }

  let warnedNoUrnNodes = false;
  const warnedNoText = new Set();

  // ---------- inline diagnostic console (inspect the live page, e.g. after a
  // LinkedIn markup change, without switching to DevTools). LinkedIn's own
  // page CSP (script-src without 'unsafe-eval') blocks eval()/Function() even
  // from a content script's isolated world, so this deliberately runs only
  // fixed, pre-written checks — never a string of arbitrary JS. ----------

  let consoleSelector = "[data-urn]";
  let consoleOutput = "";

  // Scans every element for any attribute whose name or value looks
  // urn-related — a starting point when the known [data-urn] hook disappears.
  function probeUrnAttributes() {
    const found = new Map();
    document.querySelectorAll("*").forEach((el) => {
      for (const attr of el.attributes) {
        if (/urn/i.test(attr.name) || /urn:li:/i.test(attr.value)) {
          found.set(attr.name, (found.get(attr.name) || 0) + 1);
        }
      }
    });
    const entries = [...found.entries()];
    return entries.length
      ? entries.map(([name, count]) => `${name}: ${count} element(s)`).join("\n")
      : "No urn-like attributes found anywhere on the page.";
  }

  // LinkedIn's class names are short obfuscated hashes that change often and
  // add noise without meaning, so leave "class"/"style" out of the summary
  // and show the attributes that might actually identify the element instead.
  function describeNode(node) {
    const attrs = Array.from(node.attributes)
      .filter((a) => a.name !== "class" && a.name !== "style")
      .map((a) => `${a.name}="${a.value}"`)
      .join(" ");
    const text = (node.innerText || "").trim().replace(/\s+/g, " ").slice(0, 200);
    return `<${node.tagName.toLowerCase()}${attrs ? " " + attrs : ""}>\n  text: ${text || "(none)"}`;
  }

  // Runs a plain CSS selector (not code) through querySelectorAll and shows
  // how many matched plus a readable summary of the first few, so you can
  // check candidate replacement selectors one at a time.
  function probeSelector(selector) {
    let nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch (err) {
      return "Invalid selector: " + (err && err.message ? err.message : String(err));
    }
    if (nodes.length === 0) return `0 matches for: ${selector}`;
    const lines = [`${nodes.length} matches for: ${selector}`, ""];
    Array.from(nodes)
      .slice(0, 5)
      .forEach((node, i) => {
        lines.push(`--- match ${i + 1} ---`);
        lines.push(describeNode(node));
        lines.push("");
      });
    return lines.join("\n");
  }

  // ---------- extraction ----------
  //
  // LinkedIn's class names (.update-components-text, .feed-shared-actor__name,
  // etc.) are short obfuscated hashes now and rotate frequently — the checks
  // below try those legacy names first (harmless if they never match, cheap
  // if LinkedIn ever reverts) and fall back to structural heuristics that
  // don't depend on any exact class name: the longest non-link text block
  // for post text, and the first /in/ or /company/ profile link for author.

  const POST_SELECTOR = '[data-urn], [data-id], [componentkey*="urn:li:"]';

  function extractUrnFromComponentKey(node) {
    const ck = node.getAttribute("componentkey");
    if (!ck) return null;
    const m = ck.match(/urn:li:[a-zA-Z]+:[\w-]+/);
    return m ? m[0] : null;
  }

  function getPostId(node) {
    return (
      node.getAttribute("data-urn") ||
      node.getAttribute("data-id") ||
      extractUrnFromComponentKey(node) ||
      null
    );
  }

  function extractText(node) {
    const legacy = node.querySelector(
      ".update-components-text, .feed-shared-update-v2__description, .feed-shared-text"
    );
    if (legacy && legacy.innerText.trim()) return legacy.innerText.trim();

    let best = "";
    node.querySelectorAll("span, div, p").forEach((el) => {
      if (el.children.length > 0) return; // leaf nodes only
      if (el.closest("a, button, [role='button']")) return; // skip links/buttons — author/actions, not body text
      const text = el.innerText ? el.innerText.trim() : "";
      if (text.length > best.length) best = text;
    });
    return best.length > 15 ? best : ""; // guard against grabbing a short label
  }

  // The urn-bearing element (especially a componentkey one) is sometimes a
  // small sub-component rather than the whole post — walk up until a
  // container that actually yields text shows up. Capped so a miss doesn't
  // wander into a neighboring post or the whole feed.
  function findContentContainer(node) {
    let el = node;
    for (let i = 0; i < 6 && el; i++) {
      if (extractText(el)) return el;
      el = el.parentElement;
    }
    return node;
  }

  function findSeeMoreButton(node) {
    const buttons = node.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const label = (btn.getAttribute("aria-label") || btn.innerText || "").toLowerCase();
      if (label.includes("see more") || label.includes("…more") || label.includes("...more")) {
        return btn;
      }
    }
    return null;
  }

  function extractAuthor(node) {
    const legacyName = node.querySelector(".update-components-actor__name, .feed-shared-actor__name");
    const legacyLink = node.querySelector(
      "a.update-components-actor__meta-link, a.feed-shared-actor__container-link"
    );
    if (legacyName || legacyLink) {
      return {
        name: legacyName ? legacyName.innerText.trim().split("\n")[0].trim() : "",
        profileUrl: legacyLink ? legacyLink.href : "",
      };
    }
    const link = node.querySelector('a[href*="/in/"], a[href*="/company/"]');
    if (link) {
      return { name: link.innerText.trim().split("\n")[0].trim(), profileUrl: link.href };
    }
    return { name: "", profileUrl: "" };
  }

  function extractTimestamp(node) {
    const subEl = node.querySelector(
      ".update-components-actor__sub-description, .feed-shared-actor__sub-description"
    );
    if (subEl && subEl.innerText.trim()) return subEl.innerText.trim();
    for (const el of node.querySelectorAll("span")) {
      const text = el.innerText ? el.innerText.trim() : "";
      if (/^\d+\s*(m|h|d|w|mo|yr)s?(\s*•.*)?$/i.test(text)) return text;
    }
    return "";
  }

  function buildPermalink(urn) {
    if (!urn) return "";
    const match = urn.match(/urn:li:(activity|share|ugcPost):(\d+)/);
    if (!match) return "";
    return `https://www.linkedin.com/feed/update/urn:li:${match[1]}:${match[2]}/`;
  }

  function detectSource(node, authorProfileUrl) {
    if (location.pathname.startsWith("/groups/")) return "group";
    if (authorProfileUrl.includes("/company/")) return "company";
    if (authorProfileUrl.includes("/in/")) return "user";
    return "unknown";
  }

  // ---------- storage (urn-keyed map — avoids duplicate rows across tabs/reloads) ----------

  async function getPostsMap() {
    const { [STORAGE_KEY]: raw } = await chrome.storage.local.get(STORAGE_KEY);
    if (!raw) return {};
    if (Array.isArray(raw)) {
      // migrate from the old array-based format
      const map = {};
      raw.forEach((r) => {
        if (r && r.urn) map[r.urn] = r;
      });
      await chrome.storage.local.set({ [STORAGE_KEY]: map });
      return map;
    }
    return raw;
  }

  // Concurrent captures (multiple posts scanned in the same animation frame)
  // must not read-modify-write storage in parallel, or the second write can
  // clobber the first and silently drop a capture. Chain writes through a
  // single promise so each one sees the previous write's result.
  let storageWriteChain = Promise.resolve();

  function saveRecord(record) {
    const run = async () => {
      const map = await getPostsMap();
      map[record.urn] = record;
      await chrome.storage.local.set({ [STORAGE_KEY]: map });
    };
    // Swallow prior failures so one bad write doesn't wedge the chain for
    // every capture after it; still runs sequentially, still awaitable.
    const next = storageWriteChain.catch(() => {}).then(run);
    storageWriteChain = next;
    return next;
  }

  async function getCount() {
    const map = await getPostsMap();
    return Object.keys(map).length;
  }

  async function primeSeenFromStorage() {
    const map = await getPostsMap();
    Object.keys(map).forEach((urn) => seen.add(urn));
  }

  // ---------- capture ----------

  async function capturePost(node) {
    const urn = getPostId(node);
    if (!urn || seen.has(urn)) return;
    seen.add(urn); // mark immediately so overlapping scans don't double-process this node

    const container = findContentContainer(node);

    const seeMore = findSeeMoreButton(container);
    if (seeMore) {
      seeMore.click();
      await new Promise((r) => setTimeout(r, 400));
    }

    const text = extractText(container);
    if (!text) {
      seen.delete(urn); // DOM wasn't ready — let a later scan retry this post
      if (!warnedNoText.has(urn)) {
        warnedNoText.add(urn);
        log("no text extracted for", urn, "— selectors may be stale. outerHTML snippet:", container.outerHTML.slice(0, 400));
      }
      return;
    }

    const author = extractAuthor(container);

    const record = {
      urn,
      permalink: buildPermalink(urn),
      source: detectSource(container, author.profileUrl),
      author: author.name,
      authorProfileUrl: author.profileUrl,
      timestamp: extractTimestamp(container),
      text,
      pageUrl: location.href,
      capturedAt: new Date().toISOString(),
    };

    await saveRecord(record);
    sessionRecords.push(record);

    sessionCount += 1;
    updateSessionLabel();
    log("captured", urn, author.name || "(no author name found)");
  }

  function scan() {
    const posts = document.querySelectorAll(POST_SELECTOR);
    if (posts.length === 0) {
      if (!warnedNoUrnNodes) {
        warnedNoUrnNodes = true;
        log('no post-identifying elements found (checked [data-urn], [data-id], [componentkey*="urn:li:"]) — LinkedIn may have changed its markup');
      }
      return;
    }
    warnedNoUrnNodes = false;
    posts.forEach((node) => {
      const rect = node.getBoundingClientRect();
      const inView = rect.top < window.innerHeight && rect.bottom > 0;
      if (inView) capturePost(node);
    });
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan();
    });
  }

  function startCapturing() {
    if (observer) return;
    observer = new MutationObserver(queueScan);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", queueScan, { passive: true });
    queueScan();
  }

  function stopCapturing() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    window.removeEventListener("scroll", queueScan);
  }

  // ---------- settings (start/pause/resume) ----------

  // Capturing never auto-starts just because a page (re)loaded — it must be
  // explicitly started once per session, via the button or Alt+Shift+P. This
  // is in-memory only (not persisted), so it always resets on reload/reinstall
  // and each tab requires its own explicit start regardless of what the
  // shared "active" flag in storage says.
  let hasStarted = false;

  async function getSettings() {
    const { [SETTINGS_KEY]: settings = {} } = await chrome.storage.local.get(SETTINGS_KEY);
    return { active: true, ...settings };
  }

  async function setSettings(patch) {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  async function togglePause() {
    if (!hasStarted) {
      hasStarted = true;
      sessionStartedAt = new Date();
      const next = await setSettings({ active: true });
      startCapturing();
      if (widgetState !== "hidden") renderOverlay();
      return next;
    }
    const current = await getSettings();
    const next = await setSettings({ active: !current.active });
    if (next.active) {
      startCapturing();
    } else {
      stopCapturing();
    }
    if (widgetState !== "hidden") renderOverlay();
    return next;
  }

  // ---------- folder handle (IndexedDB) ----------

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadStoredFolderHandle() {
    try {
      const handle = await idbGet(IDB_HANDLE_KEY);
      if (!handle) return null;
      const perm = await handle.queryPermission({ mode: "readwrite" });
      return perm === "granted" ? handle : { handle, needsPermission: true };
    } catch {
      return null;
    }
  }

  async function chooseFolder() {
    const handle = await window.showDirectoryPicker();
    await idbSet(IDB_HANDLE_KEY, handle);
    folderHandle = handle;
    return handle;
  }

  async function regrantFolder(handle) {
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm === "granted") {
      folderHandle = handle;
      return true;
    }
    return false;
  }

  // ---------- CSV writing ----------

  const HEADERS = [
    "urn", "permalink", "source", "author", "authorProfileUrl",
    "timestamp", "text", "pageUrl", "capturedAt",
  ];

  function toCsv(posts) {
    const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = posts.map((p) => HEADERS.map((h) => escape(p[h])).join(","));
    return [HEADERS.join(","), ...rows].join("\n");
  }

  // One file per run/session, named for when this session started (not
  // today's date alone) — so reloading the tab starts a fresh, separately
  // traceable file instead of overwriting the same one. The global `seen`
  // set (primed from all-time storage at boot) already guarantees a post
  // captured in an earlier session never gets re-added here, so each
  // session's file only ever contains genuinely new posts.
  function csvFilename() {
    const d = sessionStartedAt || new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `linkedin_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.csv`;
  }

  async function writeCsvNow() {
    if (!folderHandle) {
      log("writeCsvNow: no folder handle, skipping");
      return;
    }
    if (!sessionRecords.length) {
      log("writeCsvNow: 0 posts captured this session, nothing to write");
      return;
    }
    const fileHandle = await folderHandle.getFileHandle(csvFilename(), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(toCsv(sessionRecords));
    await writable.close();
    updateSavedLabel();
    log("wrote", sessionRecords.length, "posts to", csvFilename());
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeCsvNow, DEBOUNCE_MS);
  }

  function updateSavedLabel() {
    const el = document.getElementById("li-clipper-saved");
    if (el) el.textContent = `Saved ${new Date().toLocaleTimeString()}`;
  }

  function updateSessionLabel() {
    const el = document.getElementById("li-clipper-session");
    if (el) el.textContent = `${sessionCount} new this visit`;
  }

  // ---------- overlay UI ----------

  const STYLE = `
    #li-clipper {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      font-family: system-ui, sans-serif; background: #1b1f23; color: #fff;
      border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      width: 230px; overflow: hidden;
    }
    #li-clipper.minimized { width: auto; }
    #li-clipper .li-clipper-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px; background: #0a66c2;
    }
    #li-clipper .li-clipper-title-group { display: flex; align-items: center; gap: 6px; min-width: 0; }
    #li-clipper .li-clipper-title { font-size: 12px; font-weight: 600; white-space: nowrap; }
    #li-clipper .li-clipper-led {
      width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: #8b96a1;
    }
    #li-clipper .li-clipper-led.good { background: #2ecc71; box-shadow: 0 0 5px 1px rgba(46,204,113,0.9); }
    #li-clipper .li-clipper-led.paused { background: #f2b90c; box-shadow: 0 0 5px 1px rgba(242,185,12,0.9); }
    #li-clipper .li-clipper-led.warn { background: #e74c3c; box-shadow: 0 0 5px 1px rgba(231,76,60,0.9); }
    #li-clipper .li-clipper-btns { display: flex; gap: 6px; }
    #li-clipper button.li-clipper-icon {
      background: rgba(255,255,255,0.15); border: none; color: #fff;
      width: 20px; height: 20px; border-radius: 4px; cursor: pointer; font-size: 12px; line-height: 1;
    }
    #li-clipper button.li-clipper-icon:hover { background: rgba(255,255,255,0.3); }
    #li-clipper .li-clipper-body { padding: 10px; }
    #li-clipper.minimized .li-clipper-body { display: none; }
    #li-clipper .li-clipper-count { font-size: 22px; font-weight: 700; }
    #li-clipper .li-clipper-label { font-size: 11px; color: #b8c2cc; }
    #li-clipper .li-clipper-session { font-size: 11px; color: #6fcf97; margin-bottom: 8px; }
    #li-clipper .li-clipper-row { display: flex; gap: 6px; margin-bottom: 6px; }
    #li-clipper button.li-clipper-action {
      flex: 1; background: #2d3339; color: #fff; border: 1px solid #444;
      border-radius: 4px; padding: 6px 4px; font-size: 11px; cursor: pointer;
    }
    #li-clipper button.li-clipper-action:hover { background: #3a4249; }
    #li-clipper button.li-clipper-action.paused { background: #6b4e00; border-color: #8a6600; }
    #li-clipper .li-clipper-sub { font-size: 10px; color: #8b96a1; margin-top: 4px; }
    #li-clipper .li-clipper-tabs { display: flex; gap: 4px; margin-bottom: 8px; }
    #li-clipper button.li-clipper-tab {
      flex: 1; background: #2d3339; color: #b8c2cc; border: 1px solid #444;
      border-radius: 4px; padding: 4px; font-size: 11px; cursor: pointer;
    }
    #li-clipper button.li-clipper-tab.active { background: #0a66c2; color: #fff; border-color: #0a66c2; }
    #li-clipper input.li-clipper-selector-input {
      flex: 1; box-sizing: border-box; background: #12161a; color: #d8e0e6;
      border: 1px solid #333; border-radius: 4px; font-family: ui-monospace, Consolas, monospace;
      font-size: 11px; padding: 6px;
    }
    #li-clipper pre.li-clipper-output {
      background: #12161a; color: #9be89b; border: 1px solid #333; border-radius: 4px;
      padding: 6px; font-family: ui-monospace, Consolas, monospace; font-size: 10px;
      max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0 0 6px;
    }
  `;

  function injectStyle() {
    if (document.getElementById("li-clipper-style")) return;
    const style = document.createElement("style");
    style.id = "li-clipper-style";
    style.textContent = STYLE;
    document.documentElement.appendChild(style);
  }

  async function renderOverlay() {
    injectStyle();
    document.getElementById("li-clipper")?.remove();

    if (widgetState === "hidden") return;

    const settings = await getSettings();
    const stored = await loadStoredFolderHandle();
    const needsPermission = stored && stored.needsPermission;
    if (stored && !needsPermission) folderHandle = stored;

    const folderLabel = folderHandle
      ? `Saving to: ${folderHandle.name}/`
      : needsPermission
      ? "Folder access needs re-granting"
      : "No folder chosen yet";

    // Green = capturing, folder chosen, nothing needs attention.
    // Amber = paused, or started-but-not-yet-clicked-Start (folder is fine,
    // just not collecting right now).
    // Red = needs the user to pick/re-grant a folder.
    let ledState;
    let ledTitle;
    if (needsPermission) {
      ledState = "warn";
      ledTitle = "Folder access needs re-granting";
    } else if (!folderHandle) {
      ledState = "warn";
      ledTitle = "No folder chosen yet";
    } else if (!hasStarted) {
      ledState = "paused";
      ledTitle = "Not started yet — click Start";
    } else if (!settings.active) {
      ledState = "paused";
      ledTitle = "Paused";
    } else {
      ledState = "good";
      ledTitle = "Capturing normally";
    }

    const box = document.createElement("div");
    box.id = "li-clipper";
    if (widgetState === "compact") box.classList.add("minimized");
    box.innerHTML = `
      <div class="li-clipper-header">
        <span class="li-clipper-title-group">
          <span class="li-clipper-led ${ledState}" title="${ledTitle}"></span>
          <span class="li-clipper-title">LinkedIn Clipper</span>
        </span>
        <div class="li-clipper-btns">
          <button class="li-clipper-icon" id="li-clipper-min" title="Compact / expand">–</button>
          <button class="li-clipper-icon" id="li-clipper-close" title="Hide (reopen via toolbar icon)">×</button>
        </div>
      </div>
      <div class="li-clipper-body">
        <div class="li-clipper-tabs">
          <button class="li-clipper-tab ${activeTab === "status" ? "active" : ""}" id="li-clipper-tab-status">Usage</button>
          <button class="li-clipper-tab ${activeTab === "console" ? "active" : ""}" id="li-clipper-tab-console">Debug</button>
        </div>
        <div id="li-clipper-panel"></div>
        <div class="li-clipper-sub li-clipper-copyright">© Venkata Bhattaram</div>
      </div>
    `;
    document.documentElement.appendChild(box);

    document.getElementById("li-clipper-min").addEventListener("click", () => {
      widgetState = widgetState === "compact" ? "expanded" : "compact";
      box.classList.toggle("minimized");
    });

    document.getElementById("li-clipper-close").addEventListener("click", () => {
      widgetState = "hidden";
      renderOverlay();
    });

    document.getElementById("li-clipper-tab-status").addEventListener("click", () => {
      activeTab = "status";
      renderOverlay();
    });

    document.getElementById("li-clipper-tab-console").addEventListener("click", () => {
      activeTab = "console";
      renderOverlay();
    });

    const panel = document.getElementById("li-clipper-panel");

    if (activeTab === "status") {
      panel.innerHTML = `
        <div class="li-clipper-count" id="li-clipper-count">${await getCount()}</div>
        <div class="li-clipper-label">total captured (all tabs)</div>
        <div class="li-clipper-session" id="li-clipper-session">${sessionCount} new this visit</div>
        <div class="li-clipper-row">
          <button class="li-clipper-action" id="li-clipper-folder">
            ${folderHandle ? "Change Folder" : needsPermission ? "Grant Folder Access" : "Choose Folder"}
          </button>
        </div>
        <div class="li-clipper-row">
          <button class="li-clipper-action ${hasStarted && !settings.active ? "paused" : ""}" id="li-clipper-pause"
            title="Shortcut: Alt+Shift+P">
            ${!hasStarted ? "Start" : settings.active ? "Pause" : "Resume"} <span class="li-clipper-sub">(Alt+Shift+P)</span>
          </button>
        </div>
        <div class="li-clipper-sub">${folderLabel}</div>
        <div class="li-clipper-sub" id="li-clipper-saved"></div>
      `;

      document.getElementById("li-clipper-folder").addEventListener("click", async () => {
        try {
          if (needsPermission && stored) {
            const ok = await regrantFolder(stored.handle);
            if (!ok) return;
          } else {
            await chooseFolder();
          }
          renderOverlay();
          queueSave();
        } catch (err) {
          // user cancelled the picker — nothing to do
        }
      });

      document.getElementById("li-clipper-pause").addEventListener("click", togglePause);
    } else {
      panel.innerHTML = `
        <div class="li-clipper-sub" style="margin-top: 0;">Live log — captures, saves, and failures as they happen</div>
        <pre class="li-clipper-output" id="li-clipper-debug-log" style="max-height: 110px;"></pre>
        <div class="li-clipper-row">
          <button class="li-clipper-action" id="li-clipper-scan-now">Scan Now</button>
        </div>
        <div class="li-clipper-row">
          <button class="li-clipper-action" id="li-clipper-clear-log">Clear Log</button>
          <button class="li-clipper-action" id="li-clipper-copy-log">Copy Log</button>
        </div>
        <div class="li-clipper-row">
          <button class="li-clipper-action" id="li-clipper-probe-urn">Probe urn-like attrs</button>
          <button class="li-clipper-action" id="li-clipper-probe-componentkey">Probe urn componentkeys</button>
        </div>
        <div class="li-clipper-sub">Or check a CSS selector directly:</div>
        <div class="li-clipper-row">
          <input type="text" class="li-clipper-selector-input" id="li-clipper-selector-input" spellcheck="false" />
          <button class="li-clipper-action" id="li-clipper-run" style="flex: 0 0 56px;">▶ Run</button>
        </div>
        <pre class="li-clipper-output" id="li-clipper-output"></pre>
        <div class="li-clipper-row">
          <button class="li-clipper-action" id="li-clipper-copy-output">Copy Output</button>
        </div>
        <div class="li-clipper-sub">Read-only page inspection (no code execution — LinkedIn's CSP blocks that). Run a check, then Copy Output to paste back when reporting a possible DOM change.</div>
      `;

      refreshDebugLogPanel();

      document.getElementById("li-clipper-scan-now").addEventListener("click", () => {
        log("manual scan triggered");
        scan();
      });

      document.getElementById("li-clipper-clear-log").addEventListener("click", () => {
        debugLog.length = 0;
        refreshDebugLogPanel();
      });

      document.getElementById("li-clipper-copy-log").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        try {
          await navigator.clipboard.writeText(debugLog.join("\n") || "(no log entries yet)");
          const original = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(() => {
            btn.textContent = original;
          }, 1200);
        } catch {
          // clipboard write blocked — log is still visible and selectable
        }
      });

      const selectorInput = document.getElementById("li-clipper-selector-input");
      const output = document.getElementById("li-clipper-output");
      selectorInput.value = consoleSelector; // set as a property, not HTML, so nothing needs escaping
      output.textContent = consoleOutput;

      selectorInput.addEventListener("input", () => {
        consoleSelector = selectorInput.value;
      });

      document.getElementById("li-clipper-probe-urn").addEventListener("click", () => {
        consoleOutput = probeUrnAttributes();
        output.textContent = consoleOutput;
      });

      document.getElementById("li-clipper-probe-componentkey").addEventListener("click", () => {
        // [componentkey] alone matches ~400 UI elements with random UUID
        // keys; filtering for an actual urn:li: value narrows it down to
        // the handful that correspond to real posts.
        consoleSelector = '[componentkey*="urn:li:"]';
        selectorInput.value = consoleSelector;
        consoleOutput = probeSelector(consoleSelector);
        output.textContent = consoleOutput;
      });

      document.getElementById("li-clipper-run").addEventListener("click", () => {
        consoleSelector = selectorInput.value;
        consoleOutput = probeSelector(consoleSelector);
        output.textContent = consoleOutput;
      });

      document.getElementById("li-clipper-copy-output").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        try {
          await navigator.clipboard.writeText(consoleOutput);
          const original = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(() => {
            btn.textContent = original;
          }, 1200);
        } catch {
          // clipboard write blocked — output is still visible and selectable
        }
      });
    }

    if (hasStarted && settings.active) startCapturing();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEY]) {
      const newMap = changes[STORAGE_KEY].newValue || {};
      Object.keys(newMap).forEach((urn) => seen.add(urn)); // stay aware of other tabs' captures
      const el = document.getElementById("li-clipper-count");
      if (el) el.textContent = Object.keys(newMap).length;
      queueSave();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TOGGLE_WIDGET") {
      widgetState = widgetState === "hidden" ? "expanded" : "hidden";
      renderOverlay();
    } else if (msg.type === "TOGGLE_PAUSE") {
      togglePause();
    }
  });

  // ---------- boot ----------

  (async function init() {
    await primeSeenFromStorage();
    renderOverlay();
  })();
})();
