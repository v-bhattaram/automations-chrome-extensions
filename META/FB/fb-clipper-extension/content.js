// Reacts only to what's already rendered in the page as you scroll.
// Does not navigate, paginate, or make requests beyond what Facebook's
// own UI would already do when you click "See more" yourself.
//
// Facebook's class names are short, obfuscated, and rotate constantly, so
// extraction leans on the few relatively stable hooks Facebook still
// exposes: role="article" for post containers, data-ad-preview="message"
// for post text, and permalink-shaped hrefs (/posts/, story_fbid=,
// /permalink/) for a stable per-post id. If Facebook changes markup again,
// use the widget's Console tab to find new hooks the same way this file's
// selectors were found.
(function () {
  const STORAGE_KEY = "clippedPosts"; // stored as { [id]: record } — a map, not an array
  const SETTINGS_KEY = "clipperSettings"; // { active: bool }
  const IDB_NAME = "fb-clipper-db";
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
    console.log("[FB Clipper]", ...args);
  }

  let warnedNoArticleNodes = false;
  const warnedNoText = new Set();

  // ---------- inline diagnostic console (inspect the live page, e.g. after a
  // Facebook markup change, without switching to DevTools). Facebook's own
  // page CSP blocks eval()/Function() even from a content script's isolated
  // world, so this deliberately runs only fixed, pre-written checks — never
  // a string of arbitrary JS. ----------

  let consoleSelector = '[role="article"]';
  let consoleOutput = "";

  // Scans permalink-shaped hrefs (/posts/123, story_fbid=123, /permalink/123)
  // across the page — useful when role="article" stops matching post
  // containers and a fresh id/permalink hook needs to be found.
  function probePermalinkHrefs() {
    const patterns = [/\/posts\/(\d+)/, /story_fbid=(\d+)/, /\/permalink\/(\d+)/, /\/videos\/(\d+)/];
    const matches = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      for (const re of patterns) {
        const m = a.href.match(re);
        if (m) {
          matches.push(`${m[0]} — ${a.href.slice(0, 120)}`);
          break;
        }
      }
    });
    if (!matches.length) return "No permalink-shaped hrefs (/posts/, story_fbid=, /permalink/, /videos/) found.";
    const unique = [...new Set(matches)].slice(0, 15);
    return `${matches.length} matching link(s), showing up to 15 unique:\n\n${unique.join("\n")}`;
  }

  // Facebook's class names are short obfuscated hashes that change often and
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

  const PERMALINK_PATTERNS = [
    { re: /\/posts\/(\d+)/, kind: "posts" },
    { re: /story_fbid=(\d+)/, kind: "story_fbid" },
    { re: /\/permalink\/(\d+)/, kind: "permalink" },
    { re: /\/videos\/(\d+)/, kind: "videos" },
  ];

  function getPostMeta(node) {
    const links = node.querySelectorAll("a[href]");
    for (const a of links) {
      for (const { re, kind } of PERMALINK_PATTERNS) {
        const m = a.href.match(re);
        if (m) {
          return { id: `fb:${kind}:${m[1]}`, permalink: a.href.split("?")[0] };
        }
      }
    }
    return null;
  }

  function extractText(node) {
    const textEl = node.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
    return textEl ? textEl.innerText.trim() : "";
  }

  function findSeeMoreButton(node) {
    const candidates = node.querySelectorAll('[role="button"], div, span');
    for (const el of candidates) {
      const label = (el.getAttribute("aria-label") || el.innerText || "").trim().toLowerCase();
      if (label === "see more" || label === "...see more" || label === "…see more") {
        return el;
      }
    }
    return null;
  }

  function isProfileLikeHref(href) {
    if (!href) return false;
    if (!href.includes("facebook.com/")) return false;
    return !/\/(photo|photos|videos|reactions|hashtag|posts|permalink)\b/.test(href) && !href.includes("#");
  }

  function extractAuthor(node) {
    const links = node.querySelectorAll("a[href]");
    for (const a of links) {
      const text = a.innerText.trim();
      if (text && isProfileLikeHref(a.href)) {
        return { name: text.split("\n")[0].trim(), profileUrl: a.href.split("?")[0] };
      }
    }
    return { name: "", profileUrl: "" };
  }

  function extractTimestamp(node) {
    const abbr = node.querySelector("abbr[title]");
    if (abbr) return abbr.getAttribute("title") || abbr.innerText.trim();
    for (const a of node.querySelectorAll("a[href]")) {
      const text = a.innerText.trim();
      if (text && text.length <= 20 && PERMALINK_PATTERNS.some(({ re }) => re.test(a.href))) {
        return text;
      }
    }
    return "";
  }

  function detectSource() {
    if (location.pathname.startsWith("/groups/")) return "group";
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
    const posts = document.querySelectorAll('[role="article"]');
    if (posts.length === 0) {
      if (!warnedNoArticleNodes) {
        warnedNoArticleNodes = true;
        log('no [role="article"] elements found on page — Facebook may have changed its markup');
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
    return `facebook_${months[d.getMonth()]}_${String(d.getDate()).padStart(2, "0")}.csv`;
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
    const el = document.getElementById("fb-clipper-saved");
    if (el) el.textContent = `Saved ${new Date().toLocaleTimeString()}`;
  }

  function updateSessionLabel() {
    const el = document.getElementById("fb-clipper-session");
    if (el) el.textContent = `${sessionCount} new this visit`;
  }

  // ---------- overlay UI ----------

  const STYLE = `
    #fb-clipper {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      font-family: system-ui, sans-serif; background: #1b1f23; color: #fff;
      border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      width: 230px; overflow: hidden;
    }
    #fb-clipper.minimized { width: auto; }
    #fb-clipper .fb-clipper-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px; background: #1877f2;
    }
    #fb-clipper .fb-clipper-title-group { display: flex; align-items: center; gap: 6px; min-width: 0; }
    #fb-clipper .fb-clipper-title { font-size: 12px; font-weight: 600; white-space: nowrap; }
    #fb-clipper .fb-clipper-led {
      width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: #8b96a1;
    }
    #fb-clipper .fb-clipper-led.good { background: #2ecc71; box-shadow: 0 0 5px 1px rgba(46,204,113,0.9); }
    #fb-clipper .fb-clipper-led.paused { background: #f2b90c; box-shadow: 0 0 5px 1px rgba(242,185,12,0.9); }
    #fb-clipper .fb-clipper-led.warn { background: #e74c3c; box-shadow: 0 0 5px 1px rgba(231,76,60,0.9); }
    #fb-clipper .fb-clipper-btns { display: flex; gap: 6px; }
    #fb-clipper button.fb-clipper-icon {
      background: rgba(255,255,255,0.15); border: none; color: #fff;
      width: 20px; height: 20px; border-radius: 4px; cursor: pointer; font-size: 12px; line-height: 1;
    }
    #fb-clipper button.fb-clipper-icon:hover { background: rgba(255,255,255,0.3); }
    #fb-clipper .fb-clipper-body { padding: 10px; }
    #fb-clipper.minimized .fb-clipper-body { display: none; }
    #fb-clipper .fb-clipper-count { font-size: 22px; font-weight: 700; }
    #fb-clipper .fb-clipper-label { font-size: 11px; color: #b8c2cc; }
    #fb-clipper .fb-clipper-session { font-size: 11px; color: #6fcf97; margin-bottom: 8px; }
    #fb-clipper .fb-clipper-row { display: flex; gap: 6px; margin-bottom: 6px; }
    #fb-clipper button.fb-clipper-action {
      flex: 1; background: #2d3339; color: #fff; border: 1px solid #444;
      border-radius: 4px; padding: 6px 4px; font-size: 11px; cursor: pointer;
    }
    #fb-clipper button.fb-clipper-action:hover { background: #3a4249; }
    #fb-clipper button.fb-clipper-action.paused { background: #6b4e00; border-color: #8a6600; }
    #fb-clipper .fb-clipper-sub { font-size: 10px; color: #8b96a1; margin-top: 4px; }
    #fb-clipper .fb-clipper-tabs { display: flex; gap: 4px; margin-bottom: 8px; }
    #fb-clipper button.fb-clipper-tab {
      flex: 1; background: #2d3339; color: #b8c2cc; border: 1px solid #444;
      border-radius: 4px; padding: 4px; font-size: 11px; cursor: pointer;
    }
    #fb-clipper button.fb-clipper-tab.active { background: #1877f2; color: #fff; border-color: #1877f2; }
    #fb-clipper input.fb-clipper-selector-input {
      flex: 1; box-sizing: border-box; background: #12161a; color: #d8e0e6;
      border: 1px solid #333; border-radius: 4px; font-family: ui-monospace, Consolas, monospace;
      font-size: 11px; padding: 6px;
    }
    #fb-clipper pre.fb-clipper-output {
      background: #12161a; color: #9be89b; border: 1px solid #333; border-radius: 4px;
      padding: 6px; font-family: ui-monospace, Consolas, monospace; font-size: 10px;
      max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0 0 6px;
    }
  `;

  function injectStyle() {
    if (document.getElementById("fb-clipper-style")) return;
    const style = document.createElement("style");
    style.id = "fb-clipper-style";
    style.textContent = STYLE;
    document.documentElement.appendChild(style);
  }

  async function renderOverlay() {
    injectStyle();
    document.getElementById("fb-clipper")?.remove();

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
    box.id = "fb-clipper";
    if (widgetState === "compact") box.classList.add("minimized");
    box.innerHTML = `
      <div class="fb-clipper-header">
        <span class="fb-clipper-title-group">
          <span class="fb-clipper-led ${ledState}" title="${ledTitle}"></span>
          <span class="fb-clipper-title">Facebook Clipper</span>
        </span>
        <div class="fb-clipper-btns">
          <button class="fb-clipper-icon" id="fb-clipper-min" title="Compact / expand">–</button>
          <button class="fb-clipper-icon" id="fb-clipper-close" title="Hide (reopen via toolbar icon)">×</button>
        </div>
      </div>
      <div class="fb-clipper-body">
        <div class="fb-clipper-tabs">
          <button class="fb-clipper-tab ${activeTab === "status" ? "active" : ""}" id="fb-clipper-tab-status">Status</button>
          <button class="fb-clipper-tab ${activeTab === "console" ? "active" : ""}" id="fb-clipper-tab-console">Console</button>
        </div>
        <div id="fb-clipper-panel"></div>
        <div class="fb-clipper-sub fb-clipper-copyright">© Venkata Bhattaram</div>
      </div>
    `;
    document.documentElement.appendChild(box);

    document.getElementById("fb-clipper-min").addEventListener("click", () => {
      widgetState = widgetState === "compact" ? "expanded" : "compact";
      box.classList.toggle("minimized");
    });

    document.getElementById("fb-clipper-close").addEventListener("click", () => {
      widgetState = "hidden";
      renderOverlay();
    });

    document.getElementById("fb-clipper-tab-status").addEventListener("click", () => {
      activeTab = "status";
      renderOverlay();
    });

    document.getElementById("fb-clipper-tab-console").addEventListener("click", () => {
      activeTab = "console";
      renderOverlay();
    });

    const panel = document.getElementById("fb-clipper-panel");

    if (activeTab === "status") {
      panel.innerHTML = `
        <div class="fb-clipper-count" id="fb-clipper-count">${await getCount()}</div>
        <div class="fb-clipper-label">total captured (all tabs)</div>
        <div class="fb-clipper-session" id="fb-clipper-session">${sessionCount} new this visit</div>
        <div class="fb-clipper-row">
          <button class="fb-clipper-action" id="fb-clipper-folder">
            ${folderHandle ? "Change Folder" : needsPermission ? "Grant Folder Access" : "Choose Folder"}
          </button>
        </div>
        <div class="fb-clipper-row">
          <button class="fb-clipper-action ${settings.active ? "" : "paused"}" id="fb-clipper-pause"
            title="Shortcut: Alt+Shift+F">
            ${settings.active ? "Pause" : "Resume"} <span class="fb-clipper-sub">(Alt+Shift+F)</span>
          </button>
        </div>
        <div class="fb-clipper-sub">${folderLabel}</div>
        <div class="fb-clipper-sub" id="fb-clipper-saved"></div>
      `;

      document.getElementById("fb-clipper-folder").addEventListener("click", async () => {
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

      document.getElementById("fb-clipper-pause").addEventListener("click", togglePause);
    } else {
      panel.innerHTML = `
        <div class="fb-clipper-row">
          <button class="fb-clipper-action" id="fb-clipper-probe-permalinks">Probe permalink hrefs</button>
        </div>
        <div class="fb-clipper-sub">Or check a CSS selector directly:</div>
        <div class="fb-clipper-row">
          <input type="text" class="fb-clipper-selector-input" id="fb-clipper-selector-input" spellcheck="false" />
          <button class="fb-clipper-action" id="fb-clipper-run" style="flex: 0 0 56px;">▶ Run</button>
        </div>
        <pre class="fb-clipper-output" id="fb-clipper-output"></pre>
        <div class="fb-clipper-row">
          <button class="fb-clipper-action" id="fb-clipper-copy-output">Copy Output</button>
        </div>
        <div class="fb-clipper-sub">Read-only page inspection (no code execution — Facebook's CSP blocks that). Run a check, then Copy Output to paste back when reporting a possible DOM change.</div>
      `;

      const selectorInput = document.getElementById("fb-clipper-selector-input");
      const output = document.getElementById("fb-clipper-output");
      selectorInput.value = consoleSelector; // set as a property, not HTML, so nothing needs escaping
      output.textContent = consoleOutput;

      selectorInput.addEventListener("input", () => {
        consoleSelector = selectorInput.value;
      });

      document.getElementById("fb-clipper-probe-permalinks").addEventListener("click", () => {
        consoleOutput = probePermalinkHrefs();
        output.textContent = consoleOutput;
      });

      document.getElementById("fb-clipper-run").addEventListener("click", () => {
        consoleSelector = selectorInput.value;
        consoleOutput = probeSelector(consoleSelector);
        output.textContent = consoleOutput;
      });

      document.getElementById("fb-clipper-copy-output").addEventListener("click", async (e) => {
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
      const el = document.getElementById("fb-clipper-count");
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
