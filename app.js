/* SIDリーダー v0.19 — Series Image Downloader のEPUBを読むPWA。
 * - PCの本を一覧/保存（IndexedDB）。保存した本はPCがオフでも読める
 * - EPUBはその場でZIPを部分読み（Blob.slice + DecompressionStream）するので、200MBでもメモリに全展開しない
 * - 読んだ位置は端末に保存し、つながっていればPCと同期
 */
"use strict";
const APP_VERSION = "0.20.0";
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------- 設定 ----------------
const LS = {
  get(k, d) { try { const v = localStorage.getItem("sid." + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem("sid." + k, JSON.stringify(v)); } catch (_) {} }
};
const prefs = { dir: LS.get("dir", "rtl"), spread: LS.get("spread", "auto"), coverSingle: LS.get("coverSingle", true), sync: LS.get("sync", true) };
let token = LS.get("token", "");
// v0.20: PCが出すQR/URLの「#t=合言葉&g=GistID&gh=GitHubトークン&pc=PCのURL」を取り込む
let apiBase = LS.get("pc", "");             // 空 = このページを配っているPC(helper)
const GH = { token: LS.get("gh", ""), gist: LS.get("gist", "") };
const deviceId = LS.get("deviceId", "") || (() => { const v = Math.random().toString(36).slice(2, 10); LS.set("deviceId", v); return v; })();
function applyPairing(text) {
  const raw = String(text || "").trim();
  const hash = raw.includes("#") ? raw.slice(raw.indexOf("#") + 1) : (/^[A-Za-z0-9]{8,64}$/.test(raw) ? `t=${raw}` : raw);
  const q = new URLSearchParams(hash);
  let changed = false;
  if (q.get("t")) { token = q.get("t"); LS.set("token", token); changed = true; }
  if (q.get("g") && q.get("gh")) { GH.gist = q.get("g"); GH.token = q.get("gh"); LS.set("gist", GH.gist); LS.set("gh", GH.token); changed = true; }
  if (q.has("pc")) { apiBase = q.get("pc").replace(/\/+$/, ""); LS.set("pc", apiBase); changed = true; }
  // 別のPCのURLを貼った場合（このページと違うオリジン）は、そのPCをAPIの相手にする
  try { const u = new URL(raw); if (/^https?:$/.test(u.protocol) && u.origin !== location.origin && q.get("t") && !q.has("pc")) { apiBase = u.origin; LS.set("pc", apiBase); } } catch (_) {}
  return changed;
}
if (location.hash.length > 1 && applyPairing(location.href)) history.replaceState(null, "", location.pathname + location.search);
const apiUrl = path => (apiBase || "") + path;
const deviceName = (() => { const ua = navigator.userAgent; return /iPad|Macintosh.*Mobile|Macintosh.*Safari.*Version/.test(ua) && "ontouchend" in document ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : "端末"; })();

// ---------------- IndexedDB ----------------
const DB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const rq = indexedDB.open("sid-reader", 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        db.createObjectStore("books", { keyPath: "key" });       // 本体(Blob)と情報
        db.createObjectStore("meta", { keyPath: "key" });        // 表紙・ページ表など軽い情報
        db.createObjectStore("progress", { keyPath: "key" });
        db.createObjectStore("kv", { keyPath: "k" });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode); const s = t.objectStore(store);
      let out; Promise.resolve(fn(s)).then(v => { out = v; });
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    get: (store, key) => tx(store, "readonly", s => req(s.get(key))),
    put: (store, val) => tx(store, "readwrite", s => req(s.put(val))),
    del: (store, key) => tx(store, "readwrite", s => req(s.delete(key))),
    all: store => tx(store, "readonly", s => req(s.getAll())),
    clear: store => tx(store, "readwrite", s => req(s.clear()))
  };
})();
async function kvGet(k, d) { try { const r = await DB.get("kv", k); return r ? r.v : d; } catch (_) { return d; } }
async function kvSet(k, v) { try { await DB.put("kv", { k, v }); } catch (_) {} }

// ---------------- サーバー ----------------
let online = false;
async function api(path, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 12000);
  try {
    const r = await fetch(apiUrl(path), { method: opts.method || "GET", headers: { "X-SID-Token": token, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ctl.signal, cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) throw Object.assign(new Error("トークンが違います（設定で入力）"), { auth: true });
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  } finally { clearTimeout(t); }
}
function setNet(state, text) {
  online = state === "on";
  const el = $("net"); el.className = "chip " + state; el.textContent = text;
}
let serverInfo = null;
async function checkServer() {
  if (!token) { setNet("", "PC 未設定"); return false; }
  if (!apiBase && /github\.io$/.test(location.hostname)) { setNet("", "PC なし"); return false; }
  try { serverInfo = await api("/api/info", { timeout: 6000 }); setNet("on", "PC"); flushPending(); return true; }
  catch (e) { setNet("off", e.auth ? "PC 合言葉違い" : "PC オフ"); return false; }
}

// ---------------- GitHub Gist（PCがオフでも依頼・読んだ位置を預ける） ----------------
const gistOn = () => !!(GH.token && GH.gist);
async function gh(method, path, body) {
  const r = await fetch("https://api.github.com" + path, { method, cache: "no-store",
    headers: { Authorization: `Bearer ${GH.token}`, Accept: "application/vnd.github+json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) throw new Error("GitHubのトークンが無効です（PCでQRを出し直してください）");
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.status === 204 ? {} : r.json();
}
async function gistFiles() {
  const g = await gh("GET", `/gists/${GH.gist}`);
  const out = {};
  for (const [n, f] of Object.entries(g.files || {})) {
    out[n] = f.truncated && f.raw_url ? await (await fetch(f.raw_url, { headers: { Authorization: `Bearer ${GH.token}` } })).text() : (f.content || "");
  }
  return out;
}
const jparse = (t, d) => { try { return JSON.parse(t || ""); } catch (_) { return d; } };
function setGhChip(state, text) { const c = $("ghNet"); c.classList.toggle("hidden", !gistOn()); c.className = "chip " + state + (gistOn() ? "" : " hidden"); c.textContent = text; }
async function gistSubmit(body) {
  const files = await gistFiles();
  const name = `sid-req-${deviceId}.json`;
  const mine = jparse(files[name], []);
  mine.push({ id: `${deviceId}-${Date.now().toString(36)}`, url: body.url, deliver: body.deliver, device: deviceName, createdAt: Date.now() / 1000 });
  await gh("PATCH", `/gists/${GH.gist}`, { files: { [name]: { content: JSON.stringify(mine.slice(-40)) } } });
}
async function gistRequests() {
  const files = await gistFiles();
  const status = jparse(files["sid-status.json"], {});
  const mine = jparse(files[`sid-req-${deviceId}.json`], []);
  const reqs = status.requests || {};
  const items = mine.slice().reverse().map(r => ({ ...(reqs[r.id] || {}), url: r.url, createdAt: r.createdAt, status: reqs[r.id]?.status || "queued", message: reqs[r.id]?.message || "PCが起動したら処理します" }));
  return { items, pcSeenAt: status.updatedAt || 0 };
}
let gistProgressDirty = false;
async function gistSyncProgress() {
  if (!gistOn() || !prefs.sync) return;
  try {
    const files = await gistFiles();
    const local = await DB.all("progress").catch(() => []);
    const byKey = new Map(local.map(p => [p.key, p]));
    let pulled = 0;
    for (const [n, c] of Object.entries(files)) {
      if (!/^sid-progress-.+\.json$/.test(n) || n === `sid-progress-${deviceId}.json`) continue;
      for (const [k, v] of Object.entries(jparse(c, {}))) {
        const cur = byKey.get(k);
        if (v && typeof v === "object" && (!cur || Number(v.at) > Number(cur.at))) { const rec = { key: k, ...v }; await DB.put("progress", rec).catch(() => {}); byKey.set(k, rec); pulled++; }
      }
    }
    const mine = {};
    for (const p of byKey.values()) mine[p.key] = { page: p.page, pages: p.pages, at: p.at, title: p.title, device: p.device };
    const text = JSON.stringify(mine);
    if (gistProgressDirty || files[`sid-progress-${deviceId}.json`] !== text) {
      await gh("PATCH", `/gists/${GH.gist}`, { files: { [`sid-progress-${deviceId}.json`]: { content: text } } });
      gistProgressDirty = false;
    }
    setGhChip("on", "GitHub");
    if (pulled && !$("view-library").classList.contains("hidden") && $("reader").classList.contains("hidden")) renderLibrary();
  } catch (e) { setGhChip("off", "GitHub"); }
}

function toast(msg, ms = 2600) {
  const el = $("toast"); el.textContent = msg; el.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}
const fmtMB = b => b >= 1e9 ? (b / 1e9).toFixed(2) + "GB" : (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + "MB";
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---------------- 表示切替 ----------------
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("hidden", v.id !== "view-" + name));
  document.querySelectorAll(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  if (name === "add") { loadRequests(); fillAddDefaults(); }
  if (name === "settings") renderSettings();
  if (name === "library") renderLibrary();
}
document.querySelectorAll(".navbtn").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));

// ---------------- 本棚 ----------------
let libMode = LS.get("libMode", "saved");
let pcLibrary = null;
const openSeries = new Set(LS.get("openSeries", []));
document.querySelectorAll(".tab[data-lib]").forEach(b => b.addEventListener("click", () => { libMode = b.dataset.lib; LS.set("libMode", libMode); renderLibrary(); }));
$("libFilter").addEventListener("input", () => renderLibrary(false));
$("showKindle").checked = LS.get("showKindle", false);
$("showKindle").addEventListener("change", () => { LS.set("showKindle", $("showKindle").checked); renderLibrary(false); });
$("libReload").addEventListener("click", async () => { await checkServer(); pcLibrary = null; renderLibrary(true); });

async function loadPcLibrary(force) {
  if (!online) { pcLibrary = await kvGet("pcLibrary", null); return pcLibrary; }
  try { pcLibrary = await api("/api/library" + (force ? "?force=1" : ""), { timeout: 30000 }); await kvSet("pcLibrary", pcLibrary); }
  catch (e) { toast(e.message); pcLibrary = await kvGet("pcLibrary", null); }
  return pcLibrary;
}

let renderSeq = 0;
async function renderLibrary(reload = false) {
  const seq = ++renderSeq;
  document.querySelectorAll(".tab[data-lib]").forEach(b => b.classList.toggle("active", b.dataset.lib === libMode));
  const list = $("libList"); const notice = $("libNotice");
  const saved = await DB.all("books").catch(() => []);
  const metaAll = await DB.all("meta").catch(() => []);
  const metaMap = new Map(metaAll.map(m => [m.key, m]));
  const progMap = new Map((await DB.all("progress").catch(() => [])).map(p => [p.key, p]));
  const savedKeys = new Set(saved.map(b => b.key));
  const filter = $("libFilter").value.trim().toLowerCase();
  const showKindle = $("showKindle").checked;
  let series = [];
  notice.classList.add("hidden");
  if (libMode === "saved") {
    const by = new Map();
    for (const b of saved) {
      const sk = b.series || "端末で読み込んだEPUB";
      if (!by.has(sk)) by.set(sk, { id: "s:" + sk, title: sk, files: [], local: true });
      by.get(sk).files.push({ key: b.key, id: b.fileId || "", name: b.name, variant: b.variant || "", size: b.size, range: b.range || "", savedAt: b.savedAt });
    }
    series = [...by.values()];
    series.forEach(s => s.files.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true })));
    series.sort((a, b) => Math.max(...b.files.map(f => f.savedAt || 0)) - Math.max(...a.files.map(f => f.savedAt || 0)));
    if (!series.length) {
      const empty = el("div", "empty");
      empty.append(el("b", "", "この端末にはまだ本がありません"));
      empty.append(document.createTextNode(online ? "「PCの本」から保存すると、PCがオフでも読めます。" : "下の「ファイルから追加」でGoogle ドライブのEPUBを保存できます。PCにつながると「PCの本」からも保存できます。"));
      list.textContent = ""; list.append(empty); renderContinue(saved, metaMap, progMap); renderStorageInfo(); return;
    }
  } else {
    if (reload || !pcLibrary) { list.textContent = ""; list.append(el("div", "muted", "読み込み中…")); await loadPcLibrary(reload); }
    if (seq !== renderSeq) return;
    if (!pcLibrary) { list.textContent = ""; notice.textContent = token ? "PCにつながっていません。PC（とFirefox・helper）が起動しているか、Tailscaleがつながっているか確認してください。" : "まず「設定」で接続トークンを入力してください。"; notice.classList.remove("hidden"); return; }
    if (!online) { notice.textContent = "オフラインです（前回取得した一覧を表示中）。保存済みの本だけ読めます。"; notice.classList.remove("hidden"); }
    series = (pcLibrary.series || []).map(s => ({ ...s, files: s.files.map(f => ({ ...f, key: f.rel })) }));
  }
  if (filter) series = series.filter(s => s.title.toLowerCase().includes(filter));
  list.textContent = "";
  renderContinue(saved, metaMap, progMap);
  for (const s of series) {
    let files = s.files;
    if (!s.local && !showKindle) {
      // 同じファイル名なら original を優先して表示（Kindle版しか無いものは出す）
      const hasOrig = new Set(files.filter(f => f.variant === "original").map(f => f.name));
      files = files.filter(f => f.variant !== "kindle" || !hasOrig.has(f.name));
    }
    if (!files.length) continue;
    const box = el("div", "series");
    const head = el("div", "series-head");
    const coverKey = files.find(f => savedKeys.has(f.key))?.key || files[0].key;
    const meta = metaMap.get(coverKey);
    let img;
    if (meta?.cover) { img = el("img"); img.src = URL.createObjectURL(meta.cover); img.onload = () => URL.revokeObjectURL(img.src); }
    else if (!s.local && online && files[0].id) { img = el("img"); img.loading = "lazy"; img.src = apiUrl(`/api/cover/${files[0].id}?t=${encodeURIComponent(token)}`); img.onerror = () => img.replaceWith(el("div", "noimg")); }
    else img = el("div", "noimg");
    const info = el("div");
    info.append(el("div", "series-title", s.title));
    const savedCount = files.filter(f => savedKeys.has(f.key)).length;
    info.append(el("div", "series-meta", `${files.length}冊${savedCount && !s.local ? `（保存済み${savedCount}）` : ""}${s.site ? ` ・ ${s.site}` : ""}`));
    head.append(img, info, el("span", "chev"));
    const isOpen = openSeries.has(s.id) || series.length === 1 || !!filter;
    const books = el("div", "books" + (isOpen ? "" : " hidden"));
    box.classList.toggle("open", isOpen);
    head.addEventListener("click", () => { books.classList.toggle("hidden"); const o = !books.classList.contains("hidden"); box.classList.toggle("open", o); o ? openSeries.add(s.id) : openSeries.delete(s.id); LS.set("openSeries", [...openSeries]); });
    for (const f of files) books.append(bookRow(s, f, savedKeys.has(f.key), progressFor({ key: f.key, name: f.name }, progMap)));
    box.append(head, books); list.append(box);
  }
  renderStorageInfo();
}

// 続きを読む: 途中まで読んだ保存済みの本（新しい順）
function progressFor(rec, progMap) {
  let best = progMap.get(rec.key) || null;
  for (const p of progMap.values()) if (p.title && p.title === rec.name && (!best || p.at > best.at)) best = p;
  return best;
}
function renderContinue(saved, metaMap, progMap) {
  const shelf = $("continueShelf"); shelf.textContent = "";
  const items = saved.map(b => ({ b, p: progressFor(b, progMap) })).filter(x => x.p && x.p.pages && x.p.page > 0 && x.p.page < x.p.pages - 1)
    .sort((a, b) => b.p.at - a.p.at).slice(0, 12);
  $("continueBox").classList.toggle("hidden", !items.length || libMode !== "saved");
  for (const { b, p } of items) {
    const btn = el("button", "shelfItem"); btn.type = "button";
    const cv = el("span", "cover");
    const m = metaMap.get(b.key);
    if (m?.cover) { const img = el("img"); img.alt = ""; img.src = URL.createObjectURL(m.cover); img.onload = () => URL.revokeObjectURL(img.src); cv.append(img); }
    const bar = el("span", "tonebar"); const fill = el("i"); fill.style.width = `${Math.round((p.page + 1) / p.pages * 100)}%`; bar.append(fill);
    btn.append(cv, el("span", "t", b.series && b.series !== "端末で読み込んだEPUB" ? `${b.series}` : b.name), bar, el("span", "p", `${p.page + 1} / ${p.pages}`));
    btn.title = b.name;
    btn.addEventListener("click", () => openBook(b.key));
    shelf.append(btn);
  }
}

const downloads = new Map(); // key -> {progressEl}
function bookRow(s, f, isSaved, prog) {
  const row = el("div", "book");
  const left = el("div");
  const name = el("div", "book-name");
  if (f.variant) name.append(el("span", "badge " + (f.variant === "original" ? "original" : f.variant === "kindle" ? "kindle" : ""), f.variant === "original" ? "オリジナル" : f.variant === "kindle" ? "Kindle版" : f.variant));
  if (isSaved && !s.local) name.append(el("span", "badge saved", "保存済み"));
  name.append(document.createTextNode(f.name));
  left.append(name);
  const pct = prog && prog.pages ? Math.round(((prog.page + 1) / prog.pages) * 100) : null;
  left.append(el("div", "book-meta", [f.range, f.size ? fmtMB(f.size) : "", pct != null ? `${pct}%` : ""].filter(Boolean).join(" ・ ")));
  if (pct != null) { const bar = el("div", "tonebar"); const i = el("i"); i.style.width = pct + "%"; bar.append(i); left.append(bar); }
  const act = el("div", "book-actions");
  if (isSaved) {
    const read = el("button", "primary small", pct ? "続きを読む" : "読む"); read.onclick = () => openBook(f.key);
    const del = el("button", "ghost small", "削除"); del.onclick = async () => { if (!confirm(`${f.name} をこの端末から削除しますか？（PCのファイルは消えません）`)) return; await DB.del("books", f.key); await DB.del("meta", f.key); renderLibrary(); };
    act.append(read, del);
  } else {
    const dl = el("button", "primary small", "保存して読む");
    const dlOnly = el("button", "ghost small", "保存だけ");
    const bar = el("progress"); bar.max = 1; bar.value = 0; bar.classList.add("hidden");
    const run = async openAfter => {
      dl.disabled = dlOnly.disabled = true; bar.classList.remove("hidden");
      try { await downloadBook(s, f, p => { bar.value = p; }); toast("保存しました"); if (openAfter) await openBook(f.key); else renderLibrary(); }
      catch (e) { toast("保存に失敗: " + (e.message || e), 5000); dl.disabled = dlOnly.disabled = false; bar.classList.add("hidden"); }
    };
    dl.onclick = () => run(true); dlOnly.onclick = () => run(false);
    if (!online) { dl.disabled = dlOnly.disabled = true; }
    act.append(dl, dlOnly); row.append(left, act, bar); return row;
  }
  row.append(left, act);
  return row;
}

async function downloadBook(s, f, onProgress) {
  if (!online) throw new Error("PCにつながっていません");
  const r = await fetch(apiUrl(`/api/file/${f.id}`), { headers: { "X-SID-Token": token }, cache: "no-store" });
  if (!r.ok) throw new Error(r.status === 401 ? "トークンが違います" : `HTTP ${r.status}`);
  const total = Number(r.headers.get("Content-Length")) || f.size || 0;
  const reader = r.body.getReader(); const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (total) onProgress(got / total);
  }
  const blob = new Blob(chunks, { type: "application/epub+zip" });
  if (total && blob.size !== total) throw new Error("途中で切れました。もう一度試してください");
  try { await navigator.storage?.persist?.(); } catch (_) {}
  // 表紙を先に作る（本棚に出すため）
  let cover = null;
  try { const rc = await fetch(apiUrl(`/api/cover/${f.id}?t=${encodeURIComponent(token)}`)); if (rc.ok) cover = await rc.blob(); } catch (_) {}
  await DB.put("books", { key: f.key, fileId: f.id, name: f.name, series: s.title, variant: f.variant || "", range: f.range || "", size: blob.size, savedAt: Date.now(), blob });
  await DB.put("meta", { key: f.key, cover });
}

$("importFile").addEventListener("change", async e => {
  const files = [...e.target.files]; e.target.value = "";
  for (const file of files) {
    try {
      const key = `local:${file.name}:${file.size}`;
      const blob = file.slice(0, file.size, "application/epub+zip");
      // Blobのままだと元ファイルへの参照になる端末があるので、読み込んでから保存
      const copy = new Blob([await blob.arrayBuffer()], { type: "application/epub+zip" });
      const m = file.name.match(/^(.*?)_\d{3,}_pack/);
      await DB.put("books", { key, name: file.name, series: m ? m[1] : "端末で読み込んだEPUB", variant: "", size: copy.size, savedAt: Date.now(), blob: copy });
      try { const book = await Book.open(copy); const c = await book.coverBlob(); await DB.put("meta", { key, cover: c, pages: book.pages, title: book.title }); book.close(); } catch (_) {}
      toast(`読み込みました: ${file.name}`);
    } catch (err) { toast(`読み込みに失敗: ${file.name} ${err.message || err}`, 5000); }
  }
  libMode = "saved"; LS.set("libMode", libMode); renderLibrary();
});

async function renderStorageInfo() {
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    const t = est ? `この端末の使用量 ${fmtMB(est.usage || 0)} / 上限の目安 ${fmtMB(est.quota || 0)}${persisted ? "（永続化済み）" : ""}` : "";
    $("storageInfo").textContent = t; $("storageDetail").textContent = t;
  } catch (_) {}
}

// ---------------- ZIP（部分読み） ----------------
class ZipReader {
  constructor(blob) { this.blob = blob; this.entries = new Map(); }
  async open() {
    const size = this.blob.size;
    const tailLen = Math.min(size, 65557 + 20);
    const tailStart = size - tailLen;
    const tail = new DataView(await this.blob.slice(tailStart).arrayBuffer());
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("EPUB(ZIP)として読めません");
    let count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
    if ((cdOff === 0xFFFFFFFF || count === 0xFFFF || cdSize === 0xFFFFFFFF) && eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
      const z64off = Number(tail.getBigUint64(eocd - 20 + 8, true));
      const z = new DataView(await this.blob.slice(z64off, z64off + 56).arrayBuffer());
      count = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
    }
    const cd = new DataView(await this.blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const dec = new TextDecoder("utf-8");
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
      if (cd.getUint32(p, true) !== 0x02014b50) break;
      const method = cd.getUint16(p + 10, true);
      let comp = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true);
      const nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
      let local = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl));
      // zip64拡張
      let x = p + 46 + nl; const xe = x + xl;
      while (x + 4 <= xe) {
        const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xFFFFFFFF) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (comp === 0xFFFFFFFF) { comp = Number(cd.getBigUint64(q, true)); q += 8; }
          if (local === 0xFFFFFFFF) { local = Number(cd.getBigUint64(q, true)); q += 8; }
        }
        x += 4 + len;
      }
      this.entries.set(name, { method, comp, usize, local });
      p += 46 + nl + xl + cl;
    }
    return this;
  }
  has(name) { return this.entries.has(name); }
  async blobOf(name, type = "") {
    const e = this.entries.get(name);
    if (!e) throw new Error("EPUB内にありません: " + name);
    const lh = new DataView(await this.blob.slice(e.local, e.local + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error("ZIPの中身が壊れています");
    const start = e.local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = this.blob.slice(start, start + e.comp);
    if (e.method === 0) return type ? new Blob([raw], { type }) : raw;
    if (e.method === 8) {
      if (typeof DecompressionStream === "undefined") throw new Error("このブラウザは圧縮EPUBの展開に対応していません（iPadOS 16.4以降が必要）");
      const out = await new Response(raw.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
      return type ? new Blob([out], { type }) : out;
    }
    throw new Error("未対応の圧縮形式です: " + e.method);
  }
  async text(name) { return (await this.blobOf(name)).text(); }
}

// ---------------- EPUB ----------------
const posixJoin = (base, rel) => {
  if (/^[a-z]+:/i.test(rel)) return rel;
  const parts = (base ? base.split("/") : []).concat(decodeURI(rel.split("#")[0]).split("/"));
  const out = [];
  for (const s of parts) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }
  return out.join("/");
};
const dirOf = p => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml" };

const Book = {
  async open(blob, cachedPages = null) {
    const zip = await new ZipReader(blob).open();
    const container = await zip.text("META-INF/container.xml");
    const opfPath = (container.match(/full-path\s*=\s*"([^"]+)"/) || [])[1];
    if (!opfPath) throw new Error("EPUBの目次ファイルが見つかりません");
    const opf = new DOMParser().parseFromString(await zip.text(opfPath), "application/xml");
    const opfDir = dirOf(opfPath);
    const items = new Map();
    let coverHref = "";
    for (const it of opf.getElementsByTagName("item")) {
      const href = posixJoin(opfDir, it.getAttribute("href") || "");
      items.set(it.getAttribute("id"), { href, type: it.getAttribute("media-type") || "", props: it.getAttribute("properties") || "" });
      if (/\bcover-image\b/.test(it.getAttribute("properties") || "") && !/svg/.test(it.getAttribute("media-type") || "")) coverHref = href;
    }
    if (!coverHref) {
      const metaCover = [...opf.getElementsByTagName("meta")].find(m => m.getAttribute("name") === "cover");
      const it = metaCover && items.get(metaCover.getAttribute("content"));
      if (it && !/svg/.test(it.type)) coverHref = it.href;
    }
    const spineEl = opf.getElementsByTagName("spine")[0];
    const rtl = (spineEl?.getAttribute("page-progression-direction") || "") === "rtl";
    const title = (opf.getElementsByTagName("dc:title")[0] || opf.getElementsByTagNameNS("*", "title")[0])?.textContent || "";
    let pages = cachedPages;
    if (!pages) {
      const docs = [...(spineEl?.getElementsByTagName("itemref") || [])].map(r => items.get(r.getAttribute("idref"))).filter(Boolean);
      pages = [];
      const results = new Array(docs.length);
      let i = 0;
      const worker = async () => {
        while (i < docs.length) {
          const k = i++; const d = docs[k];
          if (/^image\//.test(d.type)) { results[k] = [d.href]; continue; }
          try {
            const html = await zip.text(d.href);
            const found = [];
            const re = /<(?:img|image)\b[^>]*?(?:\bsrc|xlink:href|\bhref)\s*=\s*"([^"]+)"/gi;
            let m; while ((m = re.exec(html))) found.push(posixJoin(dirOf(d.href), m[1]));
            results[k] = found;
          } catch (_) { results[k] = []; }
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      for (const r of results) for (const p of (r || [])) if (zip.has(p)) pages.push(p);
    }
    if (!pages.length) throw new Error("このEPUBには漫画のページ画像がありません");
    const urls = new Map();
    return {
      title, rtl, pages, zip,
      async url(i) {
        if (urls.has(i)) return urls.get(i);
        const p = pages[i]; const ext = (p.split(".").pop() || "").toLowerCase();
        const b = await zip.blobOf(p, MIME[ext] || "");
        const u = URL.createObjectURL(b); urls.set(i, u); return u;
      },
      trim(center, keep = 8) { for (const [i, u] of urls) if (Math.abs(i - center) > keep) { URL.revokeObjectURL(u); urls.delete(i); } },
      async coverBlob() {
        const p = coverHref && zip.has(coverHref) ? coverHref : pages[0];
        const ext = (p.split(".").pop() || "").toLowerCase();
        return zip.blobOf(p, MIME[ext] || "image/jpeg");
      },
      close() { for (const u of urls.values()) URL.revokeObjectURL(u); urls.clear(); }
    };
  }
};

// ---------------- 読書画面 ----------------
const R = { book: null, key: "", page: 0, views: [], vi: 0, ui: false, title: "" };
async function openBook(key) {
  const rec = await DB.get("books", key);
  if (!rec?.blob) { toast("この本はまだ保存されていません"); return; }
  $("reader").classList.remove("hidden"); $("reader").setAttribute("aria-hidden", "false");
  $("rLoading").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  try {
    const meta = await DB.get("meta", key).catch(() => null);
    const book = await Book.open(rec.blob, meta?.pages || null);
    if (!meta?.pages) { try { await DB.put("meta", { ...(meta || { key }), key, pages: book.pages, title: book.title, cover: meta?.cover || await book.coverBlob().catch(() => null) }); } catch (_) {} }
    R.book = book; R.key = key; R.title = rec.name;
    $("rTitle").textContent = `${rec.series ? rec.series + " / " : ""}${rec.name}`;
    let start = 0;
    if (prefs.sync && gistOn()) await Promise.race([gistSyncProgress(), sleep(2500)]);
    const progMap = new Map((await DB.all("progress").catch(() => [])).map(p => [p.key, p]));
    let best = progressFor(rec, progMap);
    if (prefs.sync && online && !key.startsWith("local:")) {
      try { const all = (await api("/api/progress", { timeout: 5000 })).progress || {}; for (const [k, sp] of Object.entries(all)) if ((k === key || sp.title === rec.name) && (!best || sp.at > best.at)) best = sp; } catch (_) {}
    }
    if (best && best.pages === book.pages.length) start = Math.min(best.page, book.pages.length - 1);
    else if (best && best.pages) start = Math.min(book.pages.length - 1, Math.round((best.page / best.pages) * book.pages.length));
    layout(start);
    if (start > 0) toast(`前回の続き（${start + 1}ページ）から`);
  } catch (e) {
    toast("開けませんでした: " + (e.message || e), 6000); closeReader();
  } finally { $("rLoading").classList.add("hidden"); }
}
function useSpread() {
  if (prefs.spread === "on") return true;
  if (prefs.spread === "off") return false;
  return innerWidth > innerHeight * 1.05;
}
function layout(page) {
  const n = R.book.pages.length; const views = [];
  if (useSpread()) {
    let i = 0;
    if (prefs.coverSingle) { views.push([0]); i = 1; }
    for (; i < n; i += 2) views.push(i + 1 < n ? [i, i + 1] : [i]);
  } else for (let i = 0; i < n; i++) views.push([i]);
  R.views = views;
  R.vi = Math.max(0, views.findIndex(v => v.includes(page)));
  $("rSlider").max = String(views.length); $("rSlider").classList.toggle("ltr", prefs.dir !== "rtl");
  $("rSpread").textContent = "見開き: " + ({ auto: "自動", on: "あり", off: "なし" })[prefs.spread];
  $("rDir").textContent = prefs.dir === "rtl" ? "右開き" : "左開き";
  show();
}
let showSeq = 0;
async function show() {
  const seq = ++showSeq;
  const v = R.views[R.vi]; if (!v) return;
  const stage = $("stage"); const A = $("pgA"), B = $("pgB");
  const spread = v.length === 2;
  stage.classList.toggle("spread", spread);
  // 右開きの見開きは、若いページが右側
  const order = spread ? (prefs.dir === "rtl" ? [v[1], v[0]] : [v[0], v[1]]) : [v[0]];
  const urls = await Promise.all(order.map(i => R.book.url(i)));
  if (seq !== showSeq) return;
  A.src = urls[0]; A.classList.remove("hidden");
  if (spread) { B.src = urls[1]; B.classList.remove("hidden"); } else { B.removeAttribute("src"); B.classList.add("hidden"); }
  R.page = v[0];
  $("rPage").textContent = `${v.map(i => i + 1).join("-")} / ${R.book.pages.length}`;
  $("rSlider").value = String(R.vi + 1);
  saveProgress();
  // 先読み
  const near = [];
  for (let d = 1; d <= 3; d++) { const a = R.views[R.vi + d], b = R.views[R.vi - d]; if (a) near.push(...a); if (b && d <= 1) near.push(...b); }
  near.forEach(i => R.book.url(i).catch(() => {}));
  R.book.trim(R.page, 10);
}
function go(delta) {
  if (!R.book) return;
  const ni = R.vi + delta;
  if (ni < 0) { toast("最初のページです"); return; }
  if (ni >= R.views.length) { toast("最後のページです"); return; }
  R.vi = ni; show();
}
const next = () => go(1), prev = () => go(-1);
let progTimer = null;
function saveProgress() {
  clearTimeout(progTimer);
  progTimer = setTimeout(async () => {
    const p = { key: R.key, page: R.page, pages: R.book.pages.length, at: Date.now() / 1000, title: R.title, device: deviceName };
    await DB.put("progress", p).catch(() => {});
    if (prefs.sync && online) api("/api/progress", { method: "POST", body: { progress: { [R.key]: p } }, timeout: 5000 }).catch(() => {});
    if (prefs.sync && gistOn()) { gistProgressDirty = true; clearTimeout(saveProgress.gt); saveProgress.gt = setTimeout(gistSyncProgress, 15000); }
  }, 700);
}
async function syncAllProgress() {
  if (!prefs.sync || !online) return;
  try {
    const local = await DB.all("progress");
    const map = {}; local.forEach(p => { map[p.key] = p; });
    const merged = (await api("/api/progress", { method: "POST", body: { progress: map }, timeout: 8000 })).progress || {};
    for (const [k, v] of Object.entries(merged)) { const l = local.find(x => x.key === k); if (l && v.at > l.at) await DB.put("progress", { key: k, ...v }); }
  } catch (_) {}
}
function closeReader() {
  $("reader").classList.add("hidden"); $("reader").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  if (R.book) { R.book.close(); R.book = null; }
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  setUi(false); renderLibrary();
  if (gistProgressDirty) gistSyncProgress();
}
function setUi(on) { R.ui = on; $("rTop").classList.toggle("hidden", !on); $("rBottom").classList.toggle("hidden", !on); }

// 操作: タップ(左右で送る/中央でメニュー)、スワイプ、キー、ホイール
(function bindReader() {
  const rd = $("reader");
  let sx = 0, sy = 0, st = 0, moved = false;
  rd.addEventListener("pointerdown", e => { if (e.target.closest(".r-bar")) return; sx = e.clientX; sy = e.clientY; st = Date.now(); moved = false; });
  rd.addEventListener("pointermove", e => { if (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12) moved = true; });
  rd.addEventListener("pointerup", e => {
    if (e.target.closest(".r-bar") || !R.book) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (moved && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      // 右開き: 指を右へ動かす(左から右へめくる)と次へ
      const forward = prefs.dir === "rtl" ? dx > 0 : dx < 0;
      forward ? next() : prev(); return;
    }
    if (moved || Date.now() - st > 600) return;
    const x = e.clientX / innerWidth;
    if (x > 0.3 && x < 0.7) { setUi(!R.ui); return; }
    const leftSide = x <= 0.3;
    (prefs.dir === "rtl" ? leftSide : !leftSide) ? next() : prev();
    if (R.ui) setUi(false);
  });
  addEventListener("keydown", e => {
    if (!R.book || $("reader").classList.contains("hidden")) return;
    if (e.key === "ArrowLeft") (prefs.dir === "rtl" ? next : prev)();
    else if (e.key === "ArrowRight") (prefs.dir === "rtl" ? prev : next)();
    else if (e.key === " " || e.key === "PageDown" || e.key === "ArrowDown") next();
    else if (e.key === "PageUp" || e.key === "ArrowUp") prev();
    else if (e.key === "Escape") closeReader();
    else return;
    e.preventDefault();
  });
  let wheelAt = 0;
  rd.addEventListener("wheel", e => { if (Date.now() - wheelAt < 250) return; wheelAt = Date.now(); e.deltaY > 0 ? next() : prev(); }, { passive: true });
  $("rBack").addEventListener("click", closeReader);
  $("rSlider").addEventListener("input", () => { R.vi = Number($("rSlider").value) - 1; show(); });
  $("rSpread").addEventListener("click", () => { prefs.spread = { auto: "on", on: "off", off: "auto" }[prefs.spread]; LS.set("spread", prefs.spread); layout(R.page); });
  $("rDir").addEventListener("click", () => { prefs.dir = prefs.dir === "rtl" ? "ltr" : "rtl"; LS.set("dir", prefs.dir); layout(R.page); });
  $("rFull").addEventListener("click", () => { if (document.fullscreenElement) document.exitFullscreen?.(); else (document.documentElement.requestFullscreen?.() || Promise.reject()).catch(() => toast("このブラウザは全画面に対応していません（iPadはホーム画面から開くと全画面）")); });
  let rt = null;
  addEventListener("resize", () => { if (!R.book) return; clearTimeout(rt); rt = setTimeout(() => layout(R.page), 200); });
})();

// ---------------- 追加（URL送信） ----------------
function extractUrl(text) { const m = String(text || "").match(/https?:\/\/[^\s<>"']+/); return m ? m[0] : ""; }
function fillAddDefaults() {
  if (fillAddDefaults.done || !serverInfo) return;
  $("addDrive").checked = !!serverInfo.deliverDefaultDrive; $("addKindle").checked = !!serverInfo.deliverDefaultKindle;
  fillAddDefaults.done = true;
}
$("addSubmit").addEventListener("click", async () => {
  const url = extractUrl($("addUrl").value);
  if (!url) { $("addMsg").textContent = "URLが見つかりません"; return; }
  const body = { url, deliver: { drive: $("addDrive").checked, kindle: $("addKindle").checked }, device: deviceName };
  $("addSubmit").disabled = true;
  try {
    if (!online && gistOn()) {
      await gistSubmit(body);
      $("addMsg").textContent = "GitHubに預けました。PCが起動していれば1分ほどで処理が始まります。";
      $("addUrl").value = ""; loadRequests(); return;
    }
    if (!online) throw Object.assign(new Error("offline"), { offline: true });
    const r = await api("/api/submit", { method: "POST", body });
    $("addMsg").textContent = r.duplicate ? "同じURLがすでに処理待ちです" : "PCへ送りました。PCのFirefoxが順番に処理します。";
    $("addUrl").value = ""; loadRequests();
  } catch (e) {
    if (e.offline || !online || e.name === "AbortError" || e instanceof TypeError) {
      const pend = await kvGet("pending", []); pend.push({ ...body, at: Date.now() }); await kvSet("pending", pend);
      $("addMsg").textContent = "PCにつながらないため、この端末に保存しました。つながったら自動で送ります。"; $("addUrl").value = "";
      renderPending();
    } else $("addMsg").textContent = "送れませんでした: " + (e.message || e);
  } finally { $("addSubmit").disabled = false; }
});
async function renderPending() {
  const pend = await kvGet("pending", []);
  const box = $("pendingBox");
  box.classList.toggle("hidden", !pend.length);
  box.textContent = pend.length ? `未送信 ${pend.length}件（PCにつながったら送ります）: ${pend.map(p => p.url).join("  ")}` : "";
}
let flushing = false;
async function flushPending() {
  if (flushing) return; flushing = true;
  try {
    const pend = await kvGet("pending", []);
    const left = [];
    for (const p of pend) { try { await api("/api/submit", { method: "POST", body: p }); } catch (_) { left.push(p); } }
    await kvSet("pending", left);
    if (pend.length && left.length < pend.length) toast(`保存していた依頼を${pend.length - left.length}件PCへ送りました`);
    renderPending();
  } finally { flushing = false; }
}
const ST = { queued: "待機", taken: "受付", running: "処理中", done: "完了", error: "失敗" };
async function loadRequests() {
  renderPending();
  const ul = $("reqList");
  if (!online && !gistOn()) { ul.innerHTML = "<li class='muted'>PCにつながると表示されます</li>"; return; }
  try {
    const r = online ? await api("/api/requests") : await gistRequests();
    ul.textContent = "";
    for (const it of r.items || []) {
      const li = el("li");
      li.append(el("span", "st " + it.status, ST[it.status] || it.status), document.createTextNode(`${it.seriesTitle || it.url}`));
      li.append(el("div", "muted small", `${it.message || ""} ・ ${new Date(((it.updatedAt || it.createdAt) || 0) * 1000).toLocaleString("ja-JP")}`));
      ul.append(li);
    }
    if (!(r.items || []).length) ul.innerHTML = "<li class='muted'>まだありません</li>";
  } catch (e) { ul.innerHTML = `<li class='muted'>${e.message}</li>`; }
}
$("reqReload").addEventListener("click", loadRequests);
setInterval(() => { if (!$("view-add").classList.contains("hidden")) loadRequests(); }, 10000);

// ---------------- 設定 ----------------
function renderConn() {
  const ul = $("connState"); ul.textContent = "";
  const row = (ok, title, note) => { const li = el("li"); const mk = el("span", "mk " + (ok === true ? "ok" : ok === false ? "ng" : ""), ok === true ? "✓" : ok === false ? "!" : ""); const t = el("div", "", title); if (note) t.append(el("small", "", note)); li.append(mk, t); ul.append(li); };
  row(online ? true : token ? false : null, "PC（本の一覧と保存）", online ? `つながっています${apiBase ? `（${apiBase.replace(/^https?:\/\//, "")}）` : ""}` : token ? "いまはつながっていません。PC・Firefox・Tailscaleを確認" : "PCの「スマホ連携」のQRコードを読むとつながります");
  row(gistOn() ? true : null, "GitHub（PCが切れていても依頼・同期）", gistOn() ? "設定済み" : "PCで「GitHubでつなぐ」を設定してからQRを読み直すと使えます");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  row(standalone ? true : null, "ホーム画面のアプリ", standalone ? "アプリとして開いています" : /iPad|iPhone/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "共有ボタン → ホーム画面に追加" : "メニュー → アプリをインストール（またはホーム画面に追加）");
}
function renderSettings() {
  renderConn();
  $("tokenInput").value = "";
  $("prefDir").value = prefs.dir; $("prefSpread").value = prefs.spread;
  $("prefCoverSingle").checked = !!prefs.coverSingle; $("prefSync").checked = !!prefs.sync;
  $("appVersion").textContent = `SIDリーダー v${APP_VERSION}${serverInfo ? ` ／ PC helper v${serverInfo.version}` : ""}`;
  renderStorageInfo();
}
$("tokenSave").addEventListener("click", async () => {
  if (!applyPairing($("tokenInput").value)) { $("tokenMsg").textContent = "PCの「スマホ連携」に出るURLを貼ってください"; return; }
  const ok = await checkServer();
  $("tokenMsg").textContent = ok ? "PCにつながりました" : gistOn() ? "GitHubを設定しました（PCは今はつながっていません）" : "つながりません（Tailscale・PCの起動を確認）";
  if (ok) { pcLibrary = null; syncAllProgress(); }
  gistSyncProgress(); renderConn();
});
$("pasteBtn").addEventListener("click", async () => { try { const t = await navigator.clipboard.readText(); const u = extractUrl(t); if (u) $("addUrl").value = u; else toast("クリップボードにURLがありません"); } catch (_) { toast("貼り付けできませんでした（長押しで貼り付けてください）"); } });
// Android: 「アプリにする」ボタン
let installEvt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("installBtn").classList.remove("hidden"); });
$("installBtn").addEventListener("click", async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (_) {} installEvt = null; $("installBtn").classList.add("hidden"); });
$("prefDir").addEventListener("change", () => { prefs.dir = $("prefDir").value; LS.set("dir", prefs.dir); });
$("prefSpread").addEventListener("change", () => { prefs.spread = $("prefSpread").value; LS.set("spread", prefs.spread); });
$("prefCoverSingle").addEventListener("change", () => { prefs.coverSingle = $("prefCoverSingle").checked; LS.set("coverSingle", prefs.coverSingle); });
$("prefSync").addEventListener("change", () => { prefs.sync = $("prefSync").checked; LS.set("sync", prefs.sync); });
$("persistBtn").addEventListener("click", async () => {
  try { const ok = await navigator.storage.persist(); toast(ok ? "永続化されました（容量不足でも消されにくくなります）" : "ブラウザに断られました。ホーム画面に追加して開くと許可されやすくなります"); }
  catch (_) { toast("このブラウザは対応していません"); }
  renderStorageInfo();
});
$("clearAll").addEventListener("click", async () => {
  if (!confirm("この端末に保存した本・読んだ位置をすべて削除します。PCのファイルは消えません。よいですか？")) return;
  await DB.clear("books"); await DB.clear("meta"); await DB.clear("progress");
  toast("削除しました"); renderStorageInfo();
});

// ---------------- 起動 ----------------
(async function boot() {
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
  } else if (location.protocol === "http:") {
    console.info("HTTPのためオフライン起動は使えません（Tailscale serve のHTTPS URLを使ってください）");
  }
  const params = new URLSearchParams(location.search);
  const shared = extractUrl(params.get("url") || "") || extractUrl(params.get("text") || "") || extractUrl(params.get("title") || "");
  await checkServer();
  setGhChip("", "GitHub");
  if (!token && !gistOn()) { showView("settings"); $("tokenMsg").textContent = "PCの拡張機能の「スマホ連携」でQRコードを出して、このページを開き直してください。"; return; }
  if (gistOn()) { gistSyncProgress(); setInterval(gistSyncProgress, 120000); }
  if (shared) { $("addUrl").value = shared; history.replaceState(null, "", location.pathname); showView("add"); return; }
  if (libMode === "pc" && !online) libMode = "saved";
  showView("library");
  syncAllProgress();
  setInterval(checkServer, 30000);
  addEventListener("online", checkServer);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkServer(); });
})();
