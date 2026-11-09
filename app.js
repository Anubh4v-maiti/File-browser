/* JEE File Browser — browser-only edition.
 *
 * Everything happens in this tab: files are read through the File System
 * Access API (or a file input), PDF text is pulled out with pdf.js, and
 * search runs over that in-memory index. No document and no search term is
 * ever sent anywhere — there is no backend at all.
 */

const MAX_PAGES = 25;
const MAX_CHARS_PER_FILE = 60_000;
const HISTORY_KEY = "jee.opened";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff"]);
const TEXT_EXTS = new Set(["txt", "md", "csv", "log", "json"]);

const state = {
  files: [],
  sourceName: "",
  query: "",
  sort: "opened",
  type: "all",
  selected: null,
  visible: [],
  selIndex: -1,
  indexing: { done: 0, total: 0, active: false },
  dirHandle: null,
  readText: true,
  pdfjs: null,
  pdfjsTried: false,
};

const $ = (id) => document.getElementById(id);
const resultsEl = $("results");
const previewEl = $("preview");

/* ------------------------------------------------------------------ utils */

function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const extOf = (n) => (n.includes(".") ? n.split(".").pop().toLowerCase() : "");
const kindOf = (n) => {
  const e = extOf(n);
  if (e === "pdf") return "pdf";
  if (IMAGE_EXTS.has(e)) return "image";
  if (TEXT_EXTS.has(e)) return "text";
  return "other";
};
const KIND_LABEL = { pdf: "PDF", image: "Image", text: "Text", other: "File" };

function fmtSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(0) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

function fmtDate(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function relTime(secs) {
  if (!secs) return "";
  const d = Date.now() / 1000 - secs;
  const table = [[60, "just now", 1], [3600, "min ago", 60], [86400, "h ago", 3600],
                 [2592000, "d ago", 86400], [31536000, "mo ago", 2592000]];
  if (d < 60) return "just now";
  for (const [limit, label, div] of table) if (d < limit) return Math.floor(d / div) + " " + label;
  return Math.floor(d / 31536000) + " y ago";
}

function highlight(text, q) {
  const frag = document.createDocumentFragment();
  if (!q) { frag.append(text); return frag; }
  const low = text.toLowerCase(), needle = q.toLowerCase();
  let i = 0;
  for (;;) {
    const at = low.indexOf(needle, i);
    if (at < 0) { frag.append(text.slice(i)); break; }
    if (at > i) frag.append(text.slice(i, at));
    frag.append(h("mark", { text: text.slice(at, at + needle.length) }));
    i = at + needle.length;
  }
  return frag;
}

function snippetNode(page, q) {
  const at = page.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return null;
  const R = 110;
  const start = Math.max(0, at - R);
  const end = Math.min(page.length, at + q.length + R);
  return h("div", { class: "snippet" },
    (start > 0 ? "…" : "") + page.slice(start, at),
    h("mark", { text: page.slice(at, at + q.length) }),
    page.slice(at + q.length, end) + (end < page.length ? "…" : ""));
}

/* ------------------------------------------------------------- open history */

function openHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}"); }
  catch { return {}; }
}

function recordOpen(name) {
  try {
    const hist = openHistory();
    hist[name] = Math.floor(Date.now() / 1000);
    const trimmed = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 200);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch { /* private mode: history just won't persist */ }
  const f = state.files.find((x) => x.name === name);
  if (f) f.openedAt = openHistory()[name] || null;
}

/* ---------------------------------------------------------------- indexeddb */

let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("jee-file-browser", 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("texts")) d.createObjectStore("texts");
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  return dbPromise;
}

async function idbGet(store, key) {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const req = d.transaction(store, "readonly").objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function idbSet(store, key, value) {
  const d = await db();
  if (!d) return;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch { resolve(false); }
  });
}

const cacheKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;

/* ------------------------------------------------------------------- pdf.js */

async function getPdfjs() {
  if (state.pdfjsTried) return state.pdfjs;
  state.pdfjsTried = true;
  try {
    const lib = await import("./vendor/pdf.min.mjs");
    lib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;
    state.pdfjs = lib;
  } catch (err) {
    console.warn("pdf.js could not be loaded — falling back to name-only search", err);
    state.pdfjs = null;
  }
  return state.pdfjs;
}

async function extractPdfText(file) {
  const lib = await getPdfjs();
  if (!lib) return { pages: [], error: "text reader unavailable" };

  let doc;
  try {
    const data = await file.arrayBuffer();
    doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
  } catch (err) {
    const name = String(err?.name || "");
    if (/password/i.test(name)) return { pages: [], error: "password protected" };
    if (/invalidpdf/i.test(name)) return { pages: [], error: "not a readable PDF" };
    return { pages: [], error: "cannot open" };
  }

  const pages = [];
  let total = 0;
  try {
    const count = Math.min(doc.numPages, MAX_PAGES);
    for (let i = 1; i <= count; i++) {
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map((it) => it.str || "").join(" ").replace(/\s+/g, " ").trim();
        pages.push(text);
        total += text.length;
        page.cleanup?.();
      } catch { pages.push(""); }
      if (total > MAX_CHARS_PER_FILE) break;
    }
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
  return { pages, error: null };
}

/* -------------------------------------------------------------- collecting */

async function filesFromDirectoryHandle(dirHandle) {
  const out = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== "file" || entry.name.startsWith(".")) continue;
    try { out.push(await entry.getFile()); } catch { /* skip unreadable */ }
  }
  return out;
}

async function walkEntry(entry, out) {
  if (!entry) return;
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
    if (f) out.push(f);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, out);
    }
  }
}

/* ------------------------------------------------------------------ loading */

let progressPaint = 0;

function paintProgress() {
  const { done, total, active } = state.indexing;
  const wrap = $("progressWrap");
  wrap.hidden = !active;
  $("indexPill").hidden = !active;
  if (!active) return;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("progressFill").style.width = pct + "%";
  const label = `Reading PDF text ${done}/${total}`;
  $("progressLabel").textContent = label;
  $("indexPill").textContent = label + "…";
}

async function loadFiles(fileList) {
  const files = fileList.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length) { alert("No files were found in that selection."); return; }

  releaseThumbs();
  state.selected = null;
  closePreview();

  state.files = files.map((f) => ({
    name: f.name,
    size: f.size,
    lastModified: f.lastModified,
    ext: extOf(f.name),
    kind: kindOf(f.name),
    file: f,
    pages: [],
    textReady: false,
    hasText: false,
    textError: null,
    openedAt: null,
  }));

  const hist = openHistory();
  for (const f of state.files) f.openedAt = hist[f.name] || null;

  $("connect").hidden = true;
  $("app").hidden = false;

  // Prefer the real source: the picked folder handle, then the relative path a
  // file input reports, and only then whatever a previous visit remembered.
  const rel = (files[0].webkitRelativePath || "").split("/")[0];
  const stored = (await idbGet("meta", "folder")) || {};
  state.sourceName = (state.dirHandle && state.dirHandle.name) || rel || stored.label || "selected folder";
  $("folderPath").textContent = state.sourceName;
  $("folderPath").title = state.sourceName;

  // Reuse cached text where the file is byte-for-byte the same.
  const store = (await idbGet("texts", "__all")) || {};
  const todo = [];
  for (const f of state.files) {
    if (f.kind !== "pdf" || !state.readText) { f.textReady = true; continue; }
    const hit = store[cacheKey(f)];
    if (hit) {
      f.pages = hit.pages || [];
      f.textError = hit.error || null;
      f.textReady = true;
      f.hasText = f.pages.some((p) => p.trim());
    } else {
      todo.push(f);
    }
  }

  state.indexing = { done: 0, total: todo.length, active: todo.length > 0 };
  render();
  paintProgress();
  if (todo.length) extractAll(todo);
}

async function extractAll(todo) {
  const store = (await idbGet("texts", "__all")) || {};
  const lib = await getPdfjs();
  if (!lib) {
    for (const f of todo) { f.textReady = true; f.textError = "text reader unavailable"; }
    state.indexing = { done: 0, total: 0, active: false };
    paintProgress();
    render();
    return;
  }

  let done = 0;
  for (const f of todo) {
    const result = await extractPdfText(f.file);
    f.pages = result.pages;
    f.textError = result.error;
    f.textReady = true;
    f.hasText = f.pages.some((p) => p.trim());

    store[cacheKey(f)] = { pages: result.pages, error: result.error };
    done++;
    state.indexing.done = done;

    const now = Date.now();
    if (now - progressPaint > 120 || done === todo.length) {
      progressPaint = now;
      paintProgress();
    }
  }

  await idbSet("texts", "__all", store);
  state.indexing = { done, total: todo.length, active: false };
  paintProgress();
  render();
}

/* ----------------------------------------------------------------- search */

function matched() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.files.map((file) => ({ file }));

  const hits = [];
  for (const f of state.files) {
    const nameAt = f.name.toLowerCase().indexOf(q);
    const pageIdx = (f.pages || []).findIndex((p) => p.toLowerCase().includes(q));
    if (nameAt < 0 && pageIdx < 0) continue;
    hits.push({
      file: f,
      nameAt,
      page: pageIdx >= 0 ? pageIdx + 1 : null,
      rank: (nameAt >= 0 ? 0 : 1000) + (nameAt >= 0 ? nameAt : pageIdx),
    });
  }
  hits.sort((a, b) => a.rank - b.rank || a.file.name.localeCompare(b.file.name));
  return hits;
}

const byType = (hits) => (state.type === "all" ? hits : hits.filter((x) => x.file.kind === state.type));

function sortHits(hits) {
  if (state.query.trim() && state.sort === "opened") return hits; // keep relevance
  const cmp = {
    opened: (a, b) => (b.file.openedAt || 0) - (a.file.openedAt || 0) || b.file.lastModified - a.file.lastModified,
    newest: (a, b) => b.file.lastModified - a.file.lastModified,
    oldest: (a, b) => a.file.lastModified - b.file.lastModified,
    name: (a, b) => a.file.name.localeCompare(b.file.name),
    namedesc: (a, b) => b.file.name.localeCompare(a.file.name),
    size: (a, b) => b.file.size - a.file.size,
  }[state.sort];
  return [...hits].sort(cmp);
}

const SORT_LABEL = { opened: "recently opened", newest: "newest", oldest: "oldest",
                     name: "name", namedesc: "name (reverse)", size: "size" };

/* ----------------------------------------------------------------- render */

function renderChips() {
  const hits = matched();
  const counts = { all: hits.length, pdf: 0, image: 0 };
  for (const x of hits) if (counts[x.file.kind] !== undefined) counts[x.file.kind]++;
  for (const chip of document.querySelectorAll(".chip")) {
    const t = chip.dataset.type;
    chip.classList.toggle("active", t === state.type);
    chip.querySelector(".count").textContent = counts[t] ?? 0;
  }
}

/* Thumbnails reuse one blob URL per file: render() runs on every keystroke, so
   creating a fresh object URL each time would leak tens of them per render. */
const thumbUrls = new Map();

function thumbUrl(f) {
  if (!thumbUrls.has(f.name)) thumbUrls.set(f.name, URL.createObjectURL(f.file));
  return thumbUrls.get(f.name);
}

function releaseThumbs() {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
}

function badgeFor(f) {
  const badge = h("div", { class: "badge " + f.kind });
  if (f.kind === "image") {
    badge.append(h("img", { src: thumbUrl(f), loading: "lazy", alt: "" }));
  } else {
    badge.textContent = KIND_LABEL[f.kind] || "FILE";
  }
  return badge;
}

function fileRow(hit) {
  const f = hit.file;
  const q = state.query.trim();

  const tags = [];
  if (hit.nameAt >= 0) tags.push(h("span", { class: "tag" }, "name"));
  if (hit.page) tags.push(h("span", { class: "tag page" }, "page " + hit.page));
  else if (!q && f.hasText) tags.push(h("span", { class: "tag page" }, "text"));

  const main = h("div", { class: "row-main" },
    h("div", { class: "row-name" }, highlight(f.name, q)),
    h("div", { class: "row-sub" }, tags));

  if (hit.page) {
    const node = snippetNode(f.pages[hit.page - 1] || "", q);
    if (node) main.append(node);
  } else if (f.textError && f.kind === "pdf") {
    main.append(h("div", { class: "snippet" }, "no searchable text — " + f.textError));
  }

  return h("button", {
    class: "row" + (state.selected === f.name ? " sel" : ""),
    type: "button",
    "data-name": f.name,
    onclick: () => preview(f, hit.page || 1),
  },
    badgeFor(f),
    main,
    h("div", { class: "row-meta" },
      h("div", {}, fmtSize(f.size)),
      h("div", {}, f.openedAt ? "opened " + relTime(f.openedAt) : fmtDate(f.lastModified))));
}

function renderRecent() {
  const byOpen = state.files.filter((f) => f.openedAt)
    .sort((a, b) => b.openedAt - a.openedAt).slice(0, 12);

  const usingHistory = byOpen.length > 0;
  const items = usingHistory
    ? byOpen
    : state.files.slice().sort((a, b) => b.lastModified - a.lastModified).slice(0, 12);
  if (!items.length) return null;

  const shelf = h("div", { class: "shelf" });
  for (const f of items) {
    const thumb = h("div", { class: "thumb" });
    if (f.kind === "image") {
      thumb.append(h("img", { src: thumbUrl(f), loading: "lazy", alt: "" }));
    } else {
      thumb.append(h("span", { class: "badge " + f.kind, style: "width:34px;height:34px" },
        KIND_LABEL[f.kind] || "FILE"));
    }
    shelf.append(h("button", { class: "card", type: "button", onclick: () => preview(f, 1) },
      thumb,
      h("div", { class: "name", text: f.name }),
      h("div", { class: "when", text: usingHistory ? "opened " + relTime(f.openedAt) : fmtDate(f.lastModified) })));
  }

  return h("section", { class: "recent-section" },
    h("div", { class: "section-head" },
      h("h2", { text: usingHistory ? "Recently opened here" : "Recently modified" }),
      h("span", { class: "hint", text: usingHistory ? "files you opened in this app" : "newest files in the folder" })),
    shelf);
}

/* Rebuild just the shelf, so opening a file flips it to "Recently opened here"
   without rebuilding (and losing the selection in) the whole list. */
function refreshShelf() {
  const fresh = renderRecent();
  const existing = resultsEl.querySelector(".recent-section");
  if (existing) {
    if (fresh) existing.replaceWith(fresh);
    else existing.remove();
  } else if (fresh) {
    resultsEl.prepend(fresh);
  }
}

function render() {
  state.visible = [];
  state.selIndex = -1;
  resultsEl.replaceChildren();

  renderChips();
  const q = state.query.trim();
  const hits = byType(matched());

  if (q) {
    if (!hits.length) {
      resultsEl.append(h("div", { class: "empty" },
        `No file matches “${q}”.`,
        state.indexing.active ? h("div", { class: "dim small" }, "Text is still being read — results may grow.") : null));
      updateStatus(0, q);
      return;
    }
    resultsEl.append(h("div", { class: "section-head" },
      h("h2", { text: hits.length === 1 ? "1 match" : hits.length + " matches" }),
      h("span", { class: "hint", text: "name and document text" })));
    const list = h("div", { class: "list" });
    for (const hit of hits) { list.append(fileRow(hit)); state.visible.push(hit.file.name); }
    resultsEl.append(list);
    updateStatus(hits.length, q);
    return;
  }

  const recent = renderRecent();
  if (recent) resultsEl.append(recent);

  const ordered = sortHits(hits);
  resultsEl.append(h("div", { class: "section-head" },
    h("h2", { text: "All files" }),
    h("span", { class: "hint", text: `${ordered.length} shown · sorted by ${SORT_LABEL[state.sort]}` })));

  if (!ordered.length) {
    resultsEl.append(h("div", { class: "empty" }, "No files in this view."));
  } else {
    const list = h("div", { class: "list" });
    for (const hit of ordered) { list.append(fileRow(hit)); state.visible.push(hit.file.name); }
    resultsEl.append(list);
  }
  updateStatus(ordered.length, "");
}

function updateStatus(shown, q) {
  const total = state.files.length;
  const opened = state.files.filter((f) => f.openedAt).length;
  $("statusLeft").textContent = q
    ? `${shown} of ${total} files match “${q}”`
    : `${total} files · ${opened} opened here`;
}

/* ---------------------------------------------------------------- preview */

let previewUrl = null;

/* Object URLs inherit the Blob's MIME type. A File from the OS usually has one,
   but if it's empty Chrome renders raw bytes instead of the document, so fall
   back to the extension. */
const MIME_BY_EXT = {
  pdf: "application/pdf",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  txt: "text/plain", md: "text/plain", log: "text/plain",
  csv: "text/csv", json: "application/json",
};

function typedBlob(f) {
  const wanted = MIME_BY_EXT[f.ext];
  if (f.file.type || !wanted) return f.file;
  return new Blob([f.file], { type: wanted });
}

function preview(f, page) {
  state.selected = f.name;
  recordOpen(f.name);

  $("pvName").textContent = f.name;
  const bits = [KIND_LABEL[f.kind] || "File", fmtSize(f.size), fmtDate(f.lastModified)];
  if (f.hasText && !f.textError) bits.push("searchable text");
  if (f.textError) bits.push(f.textError);
  $("pvMeta").textContent = bits.join("  ·  ");

  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }

  const body = $("pvBody");
  body.replaceChildren();

  if (f.kind === "image" || f.kind === "pdf") {
    previewUrl = URL.createObjectURL(typedBlob(f));
    if (f.kind === "image") {
      body.append(h("img", { src: previewUrl, alt: f.name }));
    } else {
      body.append(h("iframe", { src: previewUrl + "#page=" + (page || 1) + "&view=FitH", title: f.name }));
    }
  } else if (f.kind === "text") {
    const pre = h("pre", { class: "preview-note", style: "text-align:left;max-width:100%;white-space:pre-wrap" }, "loading…");
    body.append(pre);
    f.file.text().then((t) => { pre.textContent = t.slice(0, 200000); })
      .catch(() => { pre.textContent = "Could not read this file."; });
  } else {
    body.append(h("div", { class: "preview-note" }, "No preview for this file type — use “Save copy”."));
  }

  previewEl.hidden = false;
  for (const row of resultsEl.querySelectorAll(".row")) {
    row.classList.toggle("sel", row.dataset.name === f.name);
  }
  updateRowMeta(f);
  refreshShelf();
  updateStatus(state.visible.length, state.query.trim());
}

/* Refresh just the size/date text of one row (used after recording an open). */
function updateRowMeta(f) {
  const row = resultsEl.querySelector(`.row[data-name="${CSS.escape(f.name)}"]`);
  const meta = row?.querySelector(".row-meta");
  if (!meta) return;
  meta.replaceChildren(
    h("div", {}, fmtSize(f.size)),
    h("div", {}, f.openedAt ? "opened " + relTime(f.openedAt) : fmtDate(f.lastModified)));
}

function closePreview() {
  previewEl.hidden = true;
  state.selected = null;
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  $("pvBody").replaceChildren();
  for (const row of resultsEl.querySelectorAll(".row.sel")) row.classList.remove("sel");
}

function setSelection(index) {
  state.selIndex = Math.max(0, Math.min(state.visible.length - 1, index));
  const name = state.visible[state.selIndex];
  for (const row of resultsEl.querySelectorAll(".row")) {
    row.classList.toggle("sel", row.dataset.name === name);
  }
  const row = resultsEl.querySelector(`.row[data-name="${CSS.escape(name)}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}

/* ------------------------------------------------------------- connecting */

async function connectDirectory(handle) {
  try {
    const files = await filesFromDirectoryHandle(handle);
    state.dirHandle = handle;
    await idbSet("meta", "dir", handle);
    await idbSet("meta", "folder", { label: handle.name });
    await loadFiles(files);
  } catch (err) {
    console.error(err);
    alert("Could not read that folder: " + (err?.message || err));
  }
}

async function pickDirectory() {
  if (!window.showDirectoryPicker) return;
  try {
    const handle = await window.showDirectoryPicker({ id: "jee-folder", mode: "read" });
    await connectDirectory(handle);
  } catch (err) {
    if (err?.name !== "AbortError") { console.error(err); alert("Could not open that folder: " + err); }
  }
}

async function offerReconnect() {
  const handle = await idbGet("meta", "dir");
  if (!handle?.queryPermission) return;
  try {
    const perm = await handle.queryPermission({ mode: "read" });
    const wrap = $("reconnectWrap");
    $("reconnect").textContent = `Reconnect to “${handle.name}”`;
    wrap.hidden = false;
    if (perm === "granted") connectDirectory(handle); // already allowed: go straight in
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ wiring */

$("pickDir").addEventListener("click", pickDirectory);

$("reconnect").addEventListener("click", async () => {
  const handle = await idbGet("meta", "dir");
  if (!handle) return;
  try {
    const perm = await handle.queryPermission({ mode: "read" });
    if (perm !== "granted") {
      const asked = await handle.requestPermission({ mode: "read" });
      if (asked !== "granted") { alert("Permission was not granted."); return; }
    }
    await connectDirectory(handle);
  } catch (err) { alert("Could not reconnect: " + (err?.message || err)); }
});

$("optText").addEventListener("change", (e) => { state.readText = e.target.checked; });

$("fileInput").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length) {
    state.dirHandle = null; // this selection is not the remembered folder
    loadFiles(files);
  }
});

$("changeBtn").addEventListener("click", async () => {
  closePreview();
  state.files = [];
  $("app").hidden = true;
  $("connect").hidden = false;
  location.reload();
});

let debounce;
$("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  $("clearBtn").hidden = !state.query;
  clearTimeout(debounce);
  debounce = setTimeout(render, 90);
});

$("clearBtn").addEventListener("click", () => {
  $("search").value = ""; state.query = ""; $("clearBtn").hidden = true;
  render(); $("search").focus();
});

$("sortSel").addEventListener("change", (e) => { state.sort = e.target.value; render(); });

$("typeChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.type = chip.dataset.type;
  render();
});

$("pvClose").addEventListener("click", closePreview);

$("pvOpen").addEventListener("click", () => {
  const f = state.files.find((x) => x.name === state.selected);
  if (!f) return;
  const url = URL.createObjectURL(typedBlob(f));
  const win = window.open(url, "_blank");
  if (!win) alert("Your browser blocked the new tab. Allow pop-ups for this site.");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

$("pvSave").addEventListener("click", () => {
  const f = state.files.find((x) => x.name === state.selected);
  if (!f) return;
  const url = URL.createObjectURL(f.file);
  const a = h("a", { href: url, download: f.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (e.key === "/" && !typing && !$("app").hidden) { e.preventDefault(); $("search").focus(); return; }
  if (e.key === "Escape") {
    if (!typing && !previewEl.hidden) closePreview();
    else if (typing && state.query) { $("search").value = ""; state.query = ""; $("clearBtn").hidden = true; render(); }
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (state.visible.length && !$("app").hidden) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSelection(state.selIndex < 0 ? (step > 0 ? 0 : state.visible.length - 1) : state.selIndex + step);
    }
    return;
  }
  if (e.key === "Enter" && state.selIndex >= 0) {
    const f = state.files.find((x) => x.name === state.visible[state.selIndex]);
    if (f) preview(f, 1);
  }
});

/* ------------------------------------------------------------- drag & drop */

const dropzone = $("dropzone");
let dragDepth = 0;

window.addEventListener("dragenter", (e) => {
  if ($("app").hidden === false) return;
  e.preventDefault();
  dragDepth++;
  dropzone.hidden = false;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dropzone.hidden = true; } });
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.hidden = true;
  if (!$("app").hidden) return;

  const items = Array.from(e.dataTransfer?.items || []);
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  let files = [];
  if (entries.length) {
    for (const entry of entries) await walkEntry(entry, files);
  } else {
    files = Array.from(e.dataTransfer?.files || []);
  }
  if (files.length) {
    state.dirHandle = null;
    await idbSet("meta", "folder", { label: (files[0].webkitRelativePath || "").split("/")[0] || "dropped files" });
    loadFiles(files);
  }
});

/* -------------------------------------------------------------------- init */

(function init() {
  if (location.protocol === "file:") {
    $("support").textContent =
      "This page must be served over http(s) — ES modules and folder access need it. " +
      "Upload the folder to Vercel, or run a quick local server.";
    $("pickDir").disabled = true;
    return;
  }

  const hasPicker = typeof window.showDirectoryPicker === "function";
  const hasInput = "webkitdirectory" in document.createElement("input");

  if (!hasPicker) {
    $("pickDir").hidden = true;
    $("support").textContent = hasInput
      ? "This browser has no folder-picker support, so use “Select files instead”."
      : "This browser can't read folders. Try Chrome, Edge or Brave.";
  } else if (!hasInput) {
    $("support").textContent = "Use “Choose folder”.";
  }

  offerReconnect();
})();
