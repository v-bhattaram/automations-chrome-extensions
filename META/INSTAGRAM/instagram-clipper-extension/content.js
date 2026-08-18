// Reacts only to what's already rendered in the page as you scroll.
// Does not navigate, paginate, or make requests beyond what Instagram's
// own UI would already do when you click "more" yourself.
//
// Instagram's class names are short, obfuscated, and rotate constantly, so
// extraction leans on the few relatively stable hooks Instagram still
// exposes: <article> for post containers, /p/<shortcode>/ or
// /reel/<shortcode>/ hrefs for a stable per-post id, and <time> for
// timestamps. If Instagram changes markup again, use the widget's Console
// tab to find new hooks the same way this file's selectors were found.
(function () {
  const STORAGE_KEY = "clippedPosts"; // stored as { [id]: record } — a map, not an array
  const SETTINGS_KEY = "clipperSettings"; // { active: bool }
  const IDB_NAME = "ig-clipper-db";
  const IDB_STORE = "handles";
  const IDB_HANDLE_KEY = "csvFolder";
  const DEBOUNCE_MS = 3000;

  const seen = new Set(); // every post id already known to storage (any tab, any visit)
  let scanQueued = false;
  let observer = null;
  let saveTimer = null;
  let folderHandle = null;
  let widgetState = "expanded"; // "expanded" | "compact" | "hidden"
  let sessionCount = 0; // posts captured by *this* tab since it loaded
  let activeTab = "status"; // "status" | "console"

  // ---------- debug logging (temporary — remove once capture is confirmed working) ----------

  function log(...args) {
    console.log("[IG Clipper]", ...args);
  }

  let warnedNoArticleNodes = false;
  const warnedNoText = new Set();

  // ---------- inline diagnostic console (inspect the live page, e.g. after an
  // Instagram markup change, without switching to DevTools). Instagram's own
  // page CSP blocks eval()/Function() even from a content script's isolated
  // world, so this deliberately runs only fixed, pre-written checks — never
  // a string of arbitrary JS. ----------

  let consoleSelector = "article";
  let consoleOutput = "";

  // Scans /p/<shortcode>/ and /reel/<shortcode>/ hrefs across the page —
  // useful when <article> stops matching post containers and a fresh
  // id/permalink hook needs to be found.
  function probeShortcodeHrefs() {
    const re = /\/(p|reel)\/([A-Za-z0-9_-]+)\//;
    const matches = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      const m = a.getAttribute("href").match(re);
      if (m) matches.push(`${m[0]} — ${a.getAttribute("href")}`);
    });
    if (!matches.length) return "No /p/<shortcode>/ or /reel/<shortcode>/ hrefs found.";
    const unique = [...new Set(matches)].slice(0, 15);
    return `${matches.length} matching link(s), showing up to 15 unique:\n\n${unique.join("\n")}`;
  }

  // Instagram's class names are short obfuscated hashes that change often and
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

  function getPostMeta(node) {
    const link = node.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    if (!link) return null;
    const m = link.getAttribute("href").match(/\/(p|reel)\/([A-Za-z0-9_-]+)\//);
    if (!m) return null;
    return { id: `ig:${m[1]}:${m[2]}`, permalink: `https://www.instagram.com/${m[1]}/${m[2]}/` };
  }

  function findSeeMoreButton(node) {
    const candidates = node.querySelectorAll('[role="button"], span, div');
    for (const el of candidates) {
      const label = (el.innerText || "").trim().toLowerCase();
      if (label === "more" || label === "... more" || label === "…more") {
        return el;
      }
    }
    return null;
  }

  // The caption tends to be the longest text block in the post that isn't
  // the header (author byline). Not exact, but a reasonable heuristic given
  // Instagram exposes no stable "this is the caption" hook.
  function extractText(node) {
    const header = node.querySelector("header");
    const spans = node.querySelectorAll("span, div[dir]");
    let best = "";
    spans.forEach((el) => {
      if (header && header.contains(el)) return;
      const text = (el.innerText || "").trim();
      if (text.length > best.length && el.children.length === 0) best = text;
    });
    return best;
  }

  function extractAuthor(node) {
    const header = node.querySelector("header") || node;
    const link = header.querySelector('a[href^="/"]');
    if (!link) return { name: "", profileUrl: "" };
    const href = link.getAttribute("href");
    const name = (link.innerText || href.replace(/\//g, "")).trim();
    return { name, profileUrl: `https://www.instagram.com${href}` };
  }

  function extractTimestamp(node) {
    const timeEl = node.querySelector("time");
    if (!timeEl) return "";
    return timeEl.getAttribute("datetime") || timeEl.innerText.trim();
  }

  function detectSource() {
    if (location.pathname.startsWith("/reels/")) return "reel";
    return "feed";
  }

  // ---------- storage (id-keyed map — avoids duplicate rows across tabs/reloads) ----------

  async function getPostsMap() {
    const { [STORAGE_KEY]: raw } = await chrome.storage.local.get(STORAGE_KEY);
    return raw || {};
  }

  // Concurrent captures (multiple posts scanned in the same animation frame)
  // must not read-modify-write storage in parallel, or the second write can
  // clobber the first and silently drop a capture. Chain writes through a
  // single promise so each one sees the previous write's result.
  let storageWriteChain = Promise.resolve();

  function saveRecord(record) {
    const run = async () => {
      const map = await getPostsMap();
      map[record.id] = record;
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

  async function getAllPosts() {
    const map = await getPostsMap();
    return Object.values(map);
  }

  async function primeSeenFromStorage() {
    const map = await getPostsMap();
    Object.keys(map).forEach((id) => seen.add(id));
  }

  // ---------- capture ----------

  async function capturePost(node) {
    const meta = getPostMeta(node);
    if (!meta || seen.has(meta.id)) return;
    seen.add(meta.id); // mark immediately so overlapping scans don't double-process this node

    const seeMore = findSeeMoreButton(node);
    if (seeMore) {
      seeMore.click();
      await new Promise((r) => setTimeout(r, 400));
    }

    const text = extractText(node);
    if (!text) {
      seen.delete(meta.id); // DOM wasn't ready — let a later scan retry this post
      if (!warnedNoText.has(meta.id)) {
        warnedNoText.add(meta.id);
        log("no text extracted for", meta.id, "— selectors may be stale. outerHTML snippet:", node.outerHTML.slice(0, 400));
      }
      return;
    }

    const author = extractAuthor(node);

    await saveRecord({
      id: meta.id,
      permalink: meta.permalink,
      source: detectSource(),
      author: author.name,
      authorProfileUrl: author.profileUrl,
      timestamp: extractTimestamp(node),
      text,
      pageUrl: location.href,
      capturedAt: new Date().toISOString(),
    });

    sessionCount += 1;
    updateSessionLabel();
    log("captured", meta.id, author.name || "(no author name found)");
  }

  function scan() {
    const posts = document.querySelectorAll("article");
    if (posts.length === 0) {
      if (!warnedNoArticleNodes) {
        warnedNoArticleNodes = true;
        log("no <article> elements found on page — Instagram may have changed its markup");
      }
      return;
    }
    warnedNoArticleNodes = false;
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

  // ---------- settings (pause/resume) ----------

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
    "id", "permalink", "source", "author", "authorProfileUrl",
    "timestamp", "text", "pageUrl", "capturedAt",
  ];

  function toCsv(posts) {
    const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = posts.map((p) => HEADERS.map((h) => escape(p[h])).join(","));
    return [HEADERS.join(","), ...rows].join("\n");
  }

  function csvFilename() {
    const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const d = new Date();
    return `instagram_${months[d.getMonth()]}_${String(d.getDate()).padStart(2, "0")}.csv`;
  }

  async function writeCsvNow() {
    if (!folderHandle) {
      log("writeCsvNow: no folder handle, skipping");
      return;
    }
    const posts = await getAllPosts();
    if (!posts.length) {
      log("writeCsvNow: 0 posts captured, nothing to write");
      return;
    }
    const fileHandle = await folderHandle.getFileHandle(csvFilename(), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(toCsv(posts));
    await writable.close();
    updateSavedLabel();
    log("wrote", posts.length, "posts to", csvFilename());
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeCsvNow, DEBOUNCE_MS);
  }

  function updateSavedLabel() {
    const el = document.getElementById("ig-clipper-saved");
    if (el) el.textContent = `Saved ${new Date().toLocaleTimeString()}`;
  }

  function updateSessionLabel() {
    const el = document.getElementById("ig-clipper-session");
    if (el) el.textContent = `${sessionCount} new this visit`;
  }

  // ---------- overlay UI ----------

  const STYLE = `
    #ig-clipper {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      font-family: system-ui, sans-serif; background: #1b1f23; color: #fff;
      border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      width: 230px; overflow: hidden;
    }
    #ig-clipper.minimized { width: auto; }
    #ig-clipper .ig-clipper-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px; background: linear-gradient(45deg, #833ab4, #fd1d1d, #f77737);
    }
    #ig-clipper .ig-clipper-title-group { display: flex; align-items: center; gap: 6px; min-width: 0; }
    #ig-clipper .ig-clipper-title { font-size: 12px; font-weight: 600; white-space: nowrap; }
    #ig-clipper .ig-clipper-led {
      width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: #8b96a1;
    }
    #ig-clipper .ig-clipper-led.good { background: #2ecc71; box-shadow: 0 0 5px 1px rgba(46,204,113,0.9); }
    #ig-clipper .ig-clipper-led.paused { background: #f2b90c; box-shadow: 0 0 5px 1px rgba(242,185,12,0.9); }
    #ig-clipper .ig-clipper-led.warn { background: #e74c3c; box-shadow: 0 0 5px 1px rgba(231,76,60,0.9); }
    #ig-clipper .ig-clipper-btns { display: flex; gap: 6px; }
    #ig-clipper button.ig-clipper-icon {
      background: rgba(255,255,255,0.15); border: none; color: #fff;
      width: 20px; height: 20px; border-radius: 4px; cursor: pointer; font-size: 12px; line-height: 1;
    }
    #ig-clipper button.ig-clipper-icon:hover { background: rgba(255,255,255,0.3); }
    #ig-clipper .ig-clipper-body { padding: 10px; }
    #ig-clipper.minimized .ig-clipper-body { display: none; }
    #ig-clipper .ig-clipper-count { font-size: 22px; font-weight: 700; }
    #ig-clipper .ig-clipper-label { font-size: 11px; color: #b8c2cc; }
    #ig-clipper .ig-clipper-session { font-size: 11px; color: #6fcf97; margin-bottom: 8px; }
    #ig-clipper .ig-clipper-row { display: flex; gap: 6px; margin-bottom: 6px; }
    #ig-clipper button.ig-clipper-action {
      flex: 1; background: #2d3339; color: #fff; border: 1px solid #444;
      border-radius: 4px; padding: 6px 4px; font-size: 11px; cursor: pointer;
    }
    #ig-clipper button.ig-clipper-action:hover { background: #3a4249; }
    #ig-clipper button.ig-clipper-action.paused { background: #6b4e00; border-color: #8a6600; }
    #ig-clipper .ig-clipper-sub { font-size: 10px; color: #8b96a1; margin-top: 4px; }
    #ig-clipper .ig-clipper-tabs { display: flex; gap: 4px; margin-bottom: 8px; }
    #ig-clipper button.ig-clipper-tab {
      flex: 1; background: #2d3339; color: #b8c2cc; border: 1px solid #444;
      border-radius: 4px; padding: 4px; font-size: 11px; cursor: pointer;
    }
    #ig-clipper button.ig-clipper-tab.active {
      background: linear-gradient(45deg, #833ab4, #fd1d1d, #f77737); color: #fff; border-color: transparent;
    }
    #ig-clipper input.ig-clipper-selector-input {
      flex: 1; box-sizing: border-box; background: #12161a; color: #d8e0e6;
      border: 1px solid #333; border-radius: 4px; font-family: ui-monospace, Consolas, monospace;
      font-size: 11px; padding: 6px;
    }
    #ig-clipper pre.ig-clipper-output {
      background: #12161a; color: #9be89b; border: 1px solid #333; border-radius: 4px;
      padding: 6px; font-family: ui-monospace, Consolas, monospace; font-size: 10px;
      max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0 0 6px;
    }
  `;

  function injectStyle() {
    if (document.getElementById("ig-clipper-style")) return;
    const style = document.createElement("style");
    style.id = "ig-clipper-style";
    style.textContent = STYLE;
    document.documentElement.appendChild(style);
  }

  async function renderOverlay() {
    injectStyle();
    document.getElementById("ig-clipper")?.remove();

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
    // Amber = paused (folder is fine, just not collecting right now).
    // Red = needs the user to pick/re-grant a folder.
    const ledState =
      needsPermission || !folderHandle ? "warn" : !settings.active ? "paused" : "good";
    const ledTitle =
      ledState === "good"
        ? "Capturing normally"
        : ledState === "paused"
        ? "Paused"
        : needsPermission
        ? "Folder access needs re-granting"
        : "No folder chosen yet";

    const box = document.createElement("div");
    box.id = "ig-clipper";
    if (widgetState === "compact") box.classList.add("minimized");
    box.innerHTML = `
      <div class="ig-clipper-header">
        <span class="ig-clipper-title-group">
          <span class="ig-clipper-led ${ledState}" title="${ledTitle}"></span>
          <span class="ig-clipper-title">Instagram Clipper</span>
        </span>
        <div class="ig-clipper-btns">
          <button class="ig-clipper-icon" id="ig-clipper-min" title="Compact / expand">–</button>
          <button class="ig-clipper-icon" id="ig-clipper-close" title="Hide (reopen via toolbar icon)">×</button>
        </div>
      </div>
      <div class="ig-clipper-body">
        <div class="ig-clipper-tabs">
          <button class="ig-clipper-tab ${activeTab === "status" ? "active" : ""}" id="ig-clipper-tab-status">Status</button>
          <button class="ig-clipper-tab ${activeTab === "console" ? "active" : ""}" id="ig-clipper-tab-console">Console</button>
        </div>
        <div id="ig-clipper-panel"></div>
        <div class="ig-clipper-sub ig-clipper-copyright">© Venkata Bhattaram</div>
      </div>
    `;
    document.documentElement.appendChild(box);

    document.getElementById("ig-clipper-min").addEventListener("click", () => {
      widgetState = widgetState === "compact" ? "expanded" : "compact";
      box.classList.toggle("minimized");
    });

    document.getElementById("ig-clipper-close").addEventListener("click", () => {
      widgetState = "hidden";
      renderOverlay();
    });

    document.getElementById("ig-clipper-tab-status").addEventListener("click", () => {
      activeTab = "status";
      renderOverlay();
    });

    document.getElementById("ig-clipper-tab-console").addEventListener("click", () => {
      activeTab = "console";
      renderOverlay();
    });

    const panel = document.getElementById("ig-clipper-panel");

    if (activeTab === "status") {
      panel.innerHTML = `
        <div class="ig-clipper-count" id="ig-clipper-count">${await getCount()}</div>
        <div class="ig-clipper-label">total captured (all tabs)</div>
        <div class="ig-clipper-session" id="ig-clipper-session">${sessionCount} new this visit</div>
        <div class="ig-clipper-row">
          <button class="ig-clipper-action" id="ig-clipper-folder">
            ${folderHandle ? "Change Folder" : needsPermission ? "Grant Folder Access" : "Choose Folder"}
          </button>
        </div>
        <div class="ig-clipper-row">
          <button class="ig-clipper-action ${settings.active ? "" : "paused"}" id="ig-clipper-pause"
            title="Shortcut: Alt+Shift+I">
            ${settings.active ? "Pause" : "Resume"} <span class="ig-clipper-sub">(Alt+Shift+I)</span>
          </button>
        </div>
        <div class="ig-clipper-sub">${folderLabel}</div>
        <div class="ig-clipper-sub" id="ig-clipper-saved"></div>
      `;

      document.getElementById("ig-clipper-folder").addEventListener("click", async () => {
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

      document.getElementById("ig-clipper-pause").addEventListener("click", togglePause);
    } else {
      panel.innerHTML = `
        <div class="ig-clipper-row">
          <button class="ig-clipper-action" id="ig-clipper-probe-shortcodes">Probe /p//reel/ hrefs</button>
        </div>
        <div class="ig-clipper-sub">Or check a CSS selector directly:</div>
        <div class="ig-clipper-row">
          <input type="text" class="ig-clipper-selector-input" id="ig-clipper-selector-input" spellcheck="false" />
          <button class="ig-clipper-action" id="ig-clipper-run" style="flex: 0 0 56px;">▶ Run</button>
        </div>
        <pre class="ig-clipper-output" id="ig-clipper-output"></pre>
        <div class="ig-clipper-row">
          <button class="ig-clipper-action" id="ig-clipper-copy-output">Copy Output</button>
        </div>
        <div class="ig-clipper-sub">Read-only page inspection (no code execution — Instagram's CSP blocks that). Run a check, then Copy Output to paste back when reporting a possible DOM change.</div>
      `;

      const selectorInput = document.getElementById("ig-clipper-selector-input");
      const output = document.getElementById("ig-clipper-output");
      selectorInput.value = consoleSelector; // set as a property, not HTML, so nothing needs escaping
      output.textContent = consoleOutput;

      selectorInput.addEventListener("input", () => {
        consoleSelector = selectorInput.value;
      });

      document.getElementById("ig-clipper-probe-shortcodes").addEventListener("click", () => {
        consoleOutput = probeShortcodeHrefs();
        output.textContent = consoleOutput;
      });

      document.getElementById("ig-clipper-run").addEventListener("click", () => {
        consoleSelector = selectorInput.value;
        consoleOutput = probeSelector(consoleSelector);
        output.textContent = consoleOutput;
      });

      document.getElementById("ig-clipper-copy-output").addEventListener("click", async (e) => {
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

    if (settings.active) startCapturing();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEY]) {
      const newMap = changes[STORAGE_KEY].newValue || {};
      Object.keys(newMap).forEach((id) => seen.add(id)); // stay aware of other tabs' captures
      const el = document.getElementById("ig-clipper-count");
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
