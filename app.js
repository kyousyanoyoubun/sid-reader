/* ℜ Reader v0.21 — PC（D:\epub）の本を読む・端末に保存する・PCへ依頼する PWA
 * - 本棚は「PCの本」が基本。端末に保存した本もPCの本として（✓付きで）表示する
 * - 漫画（画像EPUB）と小説（文章EPUB・縦書き/横書き）を読める
 * - EPUBはZIPを部分読み（Blob.slice + DecompressionStream）するので、200MBでもメモリに全展開しない
 * - 読んだ位置はGitHub(Gist)で端末どうし直接同期（PCがオフでも）。つながっていればPCとも同期
 */
"use strict";
const APP_VERSION = "0.21.0";
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const svgUse = (id, cls) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); if (cls) s.setAttribute("class", cls); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#" + id); s.append(u); return s; };
const fmtMB = b => b >= 1e9 ? (b / 1e9).toFixed(2) + "GB" : (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + "MB";
const jparse = (t, d) => { try { return JSON.parse(t || ""); } catch (_) { return d; } };

// ---------------- 設定 ----------------
const LS = {
  get(k, d) { try { const v = localStorage.getItem("sid." + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem("sid." + k, JSON.stringify(v)); } catch (_) {} }
};
const prefs = {
  dir: LS.get("dir", "rtl"), spread: LS.get("spread", "auto"), coverSingle: LS.get("coverSingle", true), sync: LS.get("sync", true),
  tap: LS.get("tap", "left"), wm: LS.get("wm", "auto"), font: LS.get("font", 19), theme: LS.get("theme", "auto")
};
function setPref(k, v) { prefs[k] = v; LS.set(k, v); }
function applyTheme() {
  if (prefs.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", prefs.theme);
}
const isDark = () => prefs.theme === "dark" || (prefs.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
applyTheme();

let token = LS.get("token", "");
// PCが出すQR/URLの「#t=合言葉&g=GistID&gh=GitHubトークン&pc=PCのURL」を取り込む
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
        db.createObjectStore("books", { keyPath: "key" });
        db.createObjectStore("meta", { keyPath: "key" });
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
    keys: store => tx(store, "readonly", s => req(s.getAllKeys())),
    clear: store => tx(store, "readwrite", s => req(s.clear()))
  };
})();
async function kvGet(k, d) { try { const r = await DB.get("kv", k); return r ? r.v : d; } catch (_) { return d; } }
async function kvSet(k, v) { try { await DB.put("kv", { k, v }); } catch (_) {} }
/** 保存した本の一覧（本体Blobを読まない軽い版）。kv "savedIndex" に持つ */
let savedIndex = null;
async function getSaved() {
  if (savedIndex) return savedIndex;
  let idx = await kvGet("savedIndex", null);
  if (!idx) {
    idx = {};
    try { for (const b of await DB.all("books")) { const { blob, ...rest } = b; idx[b.key] = rest; } } catch (_) {}
    await kvSet("savedIndex", idx);
  }
  savedIndex = idx; return idx;
}
async function setSaved(rec) { const idx = await getSaved(); const { blob, ...rest } = rec; idx[rec.key] = rest; await kvSet("savedIndex", idx); }
async function unsetSaved(key) { const idx = await getSaved(); delete idx[key]; await kvSet("savedIndex", idx); }

// ---------------- サーバー（PC） ----------------
let online = false;
let checkedOnce = false;
let serverInfo = null;
async function api(path, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 12000);
  try {
    const r = await fetch(apiUrl(path), { method: opts.method || "GET", headers: { "X-SID-Token": token, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ctl.signal, cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) throw Object.assign(new Error("合言葉が違います（設定でPCのURLを貼り直してください）"), { auth: true });
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  } finally { clearTimeout(t); }
}
let netState = { pc: "", pcText: "" };
async function checkServer() {
  const before = online;
  if (!token) { online = false; netState = { pc: "none", pcText: "未設定" }; }
  else if (!apiBase && /github\.io$/.test(location.hostname)) { online = false; netState = { pc: "none", pcText: "PCのURLなし" }; }
  else {
    try { serverInfo = await api("/api/info", { timeout: 6000 }); online = true; netState = { pc: "on", pcText: "つながっています" }; flushPending(); }
    catch (e) { online = false; netState = { pc: "off", pcText: e.auth ? "合言葉が違います" : "いまはつながっていません" }; }
  }
  $("setDot").classList.toggle("hidden", online || !token);
  const first = !checkedOnce; checkedOnce = true;
  if ((first || before !== online) && currentView === "library") renderLibrary(false);
  return online;
}

// ---------------- GitHub Gist（PCを通さずに 依頼・読んだ位置 を預ける/同期） ----------------
const gistOn = () => !!(GH.token && GH.gist);
let ghState = { ok: null, at: 0, err: "" };
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
async function gistSubmit(body) {
  const files = await gistFiles();
  const name = `sid-req-${deviceId}.json`;
  const mine = jparse(files[name], []);
  mine.push({ id: `${deviceId}-${Date.now().toString(36)}`, url: body.url, deliver: body.deliver, device: deviceName, createdAt: Date.now() / 1000,
    ...(body.selection ? { selection: body.selection } : {}), ...(body.title ? { title: body.title } : {}) });
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
let gistSyncing = null;
async function gistSyncProgress() {
  if (!gistOn() || !prefs.sync) return;
  if (gistSyncing) return gistSyncing;
  gistSyncing = (async () => {
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
      for (const p of byKey.values()) mine[p.key] = { page: p.page, pages: p.pages, at: p.at, title: p.title, device: p.device, ...(p.d != null ? { d: p.d, f: p.f } : {}) };
      const text = JSON.stringify(mine);
      if (gistProgressDirty || files[`sid-progress-${deviceId}.json`] !== text) {
        await gh("PATCH", `/gists/${GH.gist}`, { files: { [`sid-progress-${deviceId}.json`]: { content: text } } });
        gistProgressDirty = false;
      }
      ghState = { ok: true, at: Date.now(), err: "" };
      if (pulled && R.book == null) { if (currentView === "library") renderLibrary(false); if (currentView === "continue") renderContinue(); }
      return pulled;
    } catch (e) { ghState = { ok: false, at: Date.now(), err: e.message || String(e) }; throw e; }
    finally { gistSyncing = null; }
  })();
  return gistSyncing;
}

// ---------------- 表示の基本 ----------------
function toast(msg, ms = 2600) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
const VIEW_TITLES = { library: "本棚", continue: "続き", requests: "依頼", settings: "設定" };
let currentView = "library";
function showView(name) {
  currentView = name;
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("hidden", v.id !== "view-" + name));
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b.dataset.view === name));
  $("viewTitle").textContent = VIEW_TITLES[name] || "";
  $("searchBox").classList.toggle("hidden", name !== "library");
  moveIndicator();
  scrollTo({ top: 0 });
  $("topbar").classList.remove("hide");
  if (name === "library") renderLibrary(false);
  if (name === "continue") renderContinue();
  if (name === "requests") loadRequests();
  if (name === "settings") renderSettings();
  LS.set("view", name);
}
function moveIndicator() {
  const on = document.querySelector(".tab.on"); const ind = $("pillInd");
  if (!on) return;
  ind.style.width = on.offsetWidth + "px";
  ind.style.transform = `translateX(${on.offsetLeft - 6}px)`;
}
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => { closeFab(); showView(b.dataset.view); }));
addEventListener("resize", moveIndicator);

// 上のバーはスクロールで隠す（上へ戻すと出る）
(() => {
  let lastY = scrollY, acc = 0;
  addEventListener("scroll", () => {
    const y = scrollY, dy = y - lastY; lastY = y;
    $("topbar").classList.toggle("scrolled", y > 4);
    if (y < 40) { $("topbar").classList.remove("hide"); acc = 0; return; }
    acc = Math.sign(dy) === Math.sign(acc) ? acc + dy : dy;
    if (acc > 24) $("topbar").classList.add("hide");
    else if (acc < -24) $("topbar").classList.remove("hide");
  }, { passive: true });
})();

// ＋メニュー（ピルが消えてメニューに変わる）
function openFab() { $("dock").classList.add("open"); $("fab").setAttribute("aria-expanded", "true"); $("fabMenu").setAttribute("aria-hidden", "false"); updateThemeTile(); }
function closeFab() { $("dock").classList.remove("open"); $("fab").setAttribute("aria-expanded", "false"); $("fabMenu").setAttribute("aria-hidden", "true"); }
$("fab").addEventListener("click", () => $("dock").classList.contains("open") ? closeFab() : openFab());
document.addEventListener("pointerdown", e => { if ($("dock").classList.contains("open") && !e.target.closest(".fabWrap")) closeFab(); });
function updateThemeTile() { const b = document.querySelector('[data-act="theme"] span'); if (b) b.textContent = isDark() ? "ライト" : "ダーク"; }
$("fabMenu").addEventListener("click", async e => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const act = b.dataset.act; closeFab();
  if (act === "add") openAdd();
  else if (act === "paste") { const u = await readClipboardUrl(); openAdd(u); }
  else if (act === "file") $("importFile").click();
  else if (act === "reload") { toast("一覧を読み直しています…"); await checkServer(); await loadPcLibrary(true); showView("library"); }
  else if (act === "sync") syncNow();
  else if (act === "theme") { setPref("theme", isDark() ? "light" : "dark"); applyTheme(); updateThemeTile(); }
});
async function syncNow() {
  const parts = [];
  if (gistOn()) { try { const n = await gistSyncProgress(); parts.push(`GitHub ✓${n ? `（${n}件更新）` : ""}`); } catch (e) { parts.push("GitHub ×"); } }
  await checkServer();
  if (online) { await syncAllProgress(); parts.push("PC ✓"); }
  toast(parts.length ? `同期しました: ${parts.join(" / ")}` : "同期先がありません（設定でつないでください）");
  if (currentView === "continue") renderContinue();
}
async function readClipboardUrl() {
  try { const t = await navigator.clipboard.readText(); const u = extractUrl(t); if (!u) toast("クリップボードにURLがありません"); return u; }
  catch (_) { toast("貼り付けできませんでした（長押しで貼り付けてください）"); return ""; }
}

// ---------------- 本棚（PCの本が基本） ----------------
let pcLibrary = null;
let shelf = LS.get("shelf", "all");
async function loadPcLibrary(force) {
  if (!online) { if (!pcLibrary) pcLibrary = await kvGet("pcLibrary", null); return pcLibrary; }
  try { pcLibrary = await api("/api/library" + (force ? "?force=1" : ""), { timeout: 30000 }); await kvSet("pcLibrary", pcLibrary); await reconcileSaved(); }
  catch (e) { toast(e.message); if (!pcLibrary) pcLibrary = await kvGet("pcLibrary", null); }
  return pcLibrary;
}
/** v0.20以前に保存したPCの本（キー=旧パス）を、いまのPCの一覧のキーへ付け替える（同じ作品名・ファイル名） */
async function reconcileSaved() {
  if (!pcLibrary?.series) return;
  const idx = await getSaved();
  const byName = new Map();
  for (const s of pcLibrary.series) for (const f of s.files) byName.set(`${s.title}\n${f.name}`, { s, f });
  const nowKeys = new Set(pcLibrary.series.flatMap(s => s.files.map(f => f.rel)));
  for (const rec of Object.values(idx)) {
    if (rec.key.startsWith("local:") || nowKeys.has(rec.key)) continue;
    const hit = byName.get(`${rec.series}\n${rec.name}`);
    if (!hit) continue;
    try {
      const full = await DB.get("books", rec.key); if (!full) continue;
      const nk = hit.f.rel;
      await DB.put("books", { ...full, key: nk, fileId: hit.f.id, shelf: hit.s.shelf, kind: hit.s.kind, pc: true });
      const m = await DB.get("meta", rec.key); if (m) { await DB.put("meta", { ...m, key: nk }); await DB.del("meta", rec.key); }
      const p = await DB.get("progress", rec.key); if (p) { await DB.put("progress", { ...p, key: nk }); }
      await DB.del("books", rec.key); await unsetSaved(rec.key); await setSaved({ ...full, key: nk, fileId: hit.f.id, shelf: hit.s.shelf, kind: hit.s.kind, pc: true });
    } catch (_) {}
  }
}

/** 本棚のモデル: PCの作品 + この端末だけにある本（ファイルから読み込んだ本・PCの一覧から消えた本） */
async function libraryModel() {
  const idx = await getSaved();
  const prog = new Map((await DB.all("progress").catch(() => [])).map(p => [p.key, p]));
  const pcSeries = (pcLibrary?.series || []).map(s => ({ ...s, pc: true, files: s.files.map(f => ({ ...f, key: f.rel })) }));
  const known = new Set(pcSeries.flatMap(s => s.files.map(f => f.key)));
  const local = new Map();
  for (const rec of Object.values(idx)) {
    if (known.has(rec.key)) continue;
    const pcGone = !rec.key.startsWith("local:");
    const t = rec.series || "端末で読み込んだEPUB";
    const id = "local:" + t;
    if (!local.has(id)) local.set(id, { id, title: t, site: "", shelf: pcGone ? (rec.shelf || "漫画") : "この端末", kind: rec.kind || "", local: true, files: [] });
    local.get(id).files.push({ key: rec.key, id: rec.fileId || "", name: rec.name, variant: rec.variant || "", size: rec.size, range: rec.range || "", localOnly: true });
  }
  const all = pcSeries.concat([...local.values()]);
  for (const s of all) {
    s.savedCount = s.files.filter(f => idx[f.key]).length;
    let best = null;
    for (const f of s.files) { const p = progressFor({ key: f.key, name: f.name }, prog); if (p && (!best || p.at > best.at)) best = { ...p, file: f }; }
    s.lastRead = best;
  }
  return { series: all, idx, prog };
}
function progressFor(rec, progMap) {
  let best = progMap.get(rec.key) || null;
  for (const p of progMap.values()) if (p.title && p.title === rec.name && (!best || p.at > best.at)) best = p;
  return best;
}
const coverCache = new Map(); // key -> objectURL（端末の表紙）
async function coverUrlFor(s, idx) {
  const savedFile = s.files.find(f => idx[f.key]);
  if (savedFile) {
    if (coverCache.has(savedFile.key)) return coverCache.get(savedFile.key);
    const m = await DB.get("meta", savedFile.key).catch(() => null);
    if (m?.cover) { const u = URL.createObjectURL(m.cover); coverCache.set(savedFile.key, u); return u; }
  }
  if (online && s.files[0]?.id) return apiUrl(`/api/cover/${s.files[0].id}?t=${encodeURIComponent(token)}`);
  return "";
}
function coverEl(url, title, kind) {
  const cv = el("div", "cv");
  const ph = el("div", "ph" + (kind === "novel" ? " novel" : ""), title || "");
  cv.append(ph);
  if (url) {
    const img = el("img"); img.alt = ""; img.loading = "lazy"; img.decoding = "async";
    img.onload = () => ph.remove(); img.onerror = () => img.remove();
    img.src = url; cv.append(img);
  }
  return cv;
}

let renderSeq = 0;
let lastModel = null;
async function renderLibrary(reload = false) {
  const seq = ++renderSeq;
  if (reload || !pcLibrary) await loadPcLibrary(reload);
  if (seq !== renderSeq) return;
  const model = await libraryModel(); lastModel = model;
  if (seq !== renderSeq) return;
  const filter = $("libFilter").value.trim().toLowerCase();
  // 棚
  const shelves = ["all"];
  for (const s of model.series) if (!shelves.includes(s.shelf)) shelves.push(s.shelf);
  if (!shelves.includes(shelf)) shelf = "all";
  const chips = $("shelfChips"); chips.textContent = "";
  for (const sh of shelves) {
    const n = sh === "all" ? model.series.length : model.series.filter(s => s.shelf === sh).length;
    const c = el("button", "chip" + (sh === shelf ? " on" : "")); c.type = "button"; c.setAttribute("role", "tab");
    c.append(document.createTextNode(sh === "all" ? "すべて" : sh), el("b", "", String(n)));
    c.addEventListener("click", () => { shelf = sh; LS.set("shelf", sh); renderLibrary(false); });
    chips.append(c);
  }
  chips.classList.toggle("hidden", shelves.length <= 2);
  // お知らせ
  const notice = $("libNotice");
  notice.classList.add("hidden");
  if (!token && !pcLibrary) { notice.textContent = "PCの本を見るには、PCの拡張機能の「スマホ連携」でQRコードを読んでください（設定にURLを貼っても大丈夫です）。"; notice.classList.remove("hidden"); }
  else if (!checkedOnce) { /* 接続確認中 */ }
  else if (!online && pcLibrary) { notice.textContent = "PCにつながっていません。保存した本（✓）だけ読めます。一覧は前回のものです。"; notice.classList.remove("hidden"); }
  else if (!online && token) { notice.textContent = "PCにつながっていません。PC・Firefox・helperの起動と、Tailscaleを確認してください。"; notice.classList.remove("hidden"); }
  // グリッド
  let list = model.series.filter(s => shelf === "all" || s.shelf === shelf);
  if (filter) list = list.filter(s => (s.title + " " + (s.site || "")).toLowerCase().includes(filter));
  const grid = $("seriesGrid"); grid.textContent = "";
  $("libEmpty").classList.toggle("hidden", !!list.length);
  if (!list.length) {
    $("libEmpty").textContent = "";
    $("libEmpty").append(el("b", "", filter ? "見つかりません" : "まだ本がありません"), document.createTextNode(filter ? "別の言葉でさがしてください。" : online ? "PCの D:\\epub にEPUBを置くか、＋から作品を追加してください。" : "PCにつながると、PCの本が並びます。"));
  }
  const frag = document.createDocumentFragment();
  for (const s of list) {
    const t = el("button", "tile" + (!online && s.pc && !s.savedCount ? " off" : "")); t.type = "button";
    const cv = coverEl("", s.title, s.kind);
    coverUrlFor(s, model.idx).then(u => { if (u) { const img = el("img"); img.alt = ""; img.loading = "lazy"; img.onload = () => cv.querySelector(".ph")?.remove(); img.onerror = () => img.remove(); img.src = u; cv.append(img); } });
    if (s.savedCount) { const b = el("span", "badgeSaved"); if (s.savedCount === s.files.length) b.append(svgUse("i-check")); else b.textContent = `${s.savedCount}/${s.files.length}`; cv.append(b); }
    if (s.lastRead?.pages) { const pr = el("span", "tProg"); const i = el("i"); i.style.width = `${Math.round((s.lastRead.page + 1) / s.lastRead.pages * 100)}%`; pr.append(i); cv.append(pr); }
    t.append(cv, el("span", "tTitle", s.title), el("span", "tMeta", [s.site, `${s.files.length}冊`].filter(Boolean).join(" · ")));
    t.addEventListener("click", () => openSeries(s));
    frag.append(t);
  }
  grid.append(frag);
}
$("libFilter").addEventListener("input", () => renderLibrary(false));

// ---------------- 作品の詳細シート ----------------
let sheetSeries = null;
function openSheet(id) {
  $("scrim").classList.remove("hidden");
  const sh = $(id); sh.classList.remove("hidden", "closing");
  document.body.style.overflow = "hidden";
}
function closeSheets() {
  document.querySelectorAll(".sheet:not(.hidden)").forEach(sh => {
    sh.classList.add("closing");
    setTimeout(() => { sh.classList.add("hidden"); sh.classList.remove("closing"); }, 260);
  });
  $("scrim").classList.add("hidden");
  document.body.style.overflow = "";
  sheetSeries = null;
  stopPreviewPoll();
}
$("scrim").addEventListener("click", closeSheets);
document.querySelectorAll(".sheetClose").forEach(b => b.addEventListener("click", closeSheets));
// シートを下へドラッグで閉じる
document.querySelectorAll(".sheet .grab").forEach(g => {
  let y0 = null; const sh = g.parentElement;
  g.addEventListener("pointerdown", e => { y0 = e.clientY; g.setPointerCapture(e.pointerId); });
  g.addEventListener("pointermove", e => { if (y0 == null) return; const dy = Math.max(0, e.clientY - y0); sh.style.transform = `translateY(${dy}px)`; });
  g.addEventListener("pointerup", e => { if (y0 == null) return; const dy = e.clientY - y0; y0 = null; sh.style.transform = ""; if (dy > 90) closeSheets(); });
});

/** 「作品名 + 巻の名前」（作品名と本の名前が同じなら1回だけ） */
function bookTitle(series, name) {
  const L = volLabel(name);
  const v = [L.no, L.text].filter(Boolean).join(" ");
  if (!series) return v || name;
  return !v || v === series ? series : `${series}  ${v}`;
}
function volLabel(name) {
  const base = name.replace(/\.epub$/i, "");
  let m = base.match(/_(\d{3,})_pack\[([\d.]+)-([\d.]+)\]$/);
  if (m) return { no: m[1], text: `第${m[2]}〜${m[3]}話` };
  m = base.match(/_vol\.?(\d+)(?:_pack(\d+))?$/i);
  if (m) return { no: `${Number(m[1])}巻`, text: m[2] ? `その${Number(m[2])}` : "" };
  m = base.match(/_(\d{3,})$/);
  if (m) return { no: m[1], text: "" };
  return { no: "", text: base };
}
async function openSeries(s) {
  sheetSeries = s;
  const model = lastModel || await libraryModel();
  $("ssShelf").textContent = [s.shelf, s.site].filter(Boolean).join(" · ");
  $("ssTitle").textContent = s.title;
  const cvBox = $("ssCover"); cvBox.textContent = "";
  const cv = coverEl("", s.title, s.kind); cvBox.append(cv);
  coverUrlFor(s, model.idx).then(u => { if (u) { const img = el("img"); img.alt = ""; img.onload = () => cv.querySelector(".ph")?.remove(); img.src = u; cv.append(img); } });
  await renderSeriesList();
  openSheet("seriesSheet");
}
async function renderSeriesList() {
  const s = sheetSeries; if (!s) return;
  const idx = await getSaved();
  const prog = new Map((await DB.all("progress").catch(() => [])).map(p => [p.key, p]));
  const saved = s.files.filter(f => idx[f.key]);
  const total = s.files.reduce((a, f) => a + (f.size || 0), 0);
  $("ssMeta").textContent = `${s.files.length}冊 · ${fmtMB(total)}${saved.length ? ` · 端末に${saved.length}冊` : ""}`;
  $("ssSaveAll").classList.toggle("hidden", !s.pc || saved.length === s.files.length);
  $("ssSaveAll").disabled = !online;
  $("ssDelAll").classList.toggle("hidden", !saved.length);
  const ul = $("ssList"); ul.textContent = "";
  for (const f of s.files) ul.append(volRow(s, f, !!idx[f.key], progressFor({ key: f.key, name: f.name }, prog)));
}
const dl = new Map(); // key -> {p, el}
function volRow(s, f, isSaved, p) {
  const li = el("li", "vol" + (!isSaved && !online ? " off" : ""));
  const left = el("div");
  const L = volLabel(f.name);
  const n = el("div", "n"); if (L.no) n.append(el("span", "no", L.no)); n.append(el("span", "", L.text || f.range || f.name));
  const pct = p?.pages ? Math.round((p.page + 1) / p.pages * 100) : null;
  left.append(n, el("div", "m", [L.text && f.range && !L.text.includes("話") ? f.range : "", f.size ? fmtMB(f.size) : "", pct != null ? `${pct}%` : "", isSaved ? "端末に保存済み" : ""].filter(Boolean).join(" · ")));
  if (pct != null) { const b = el("div", "bar"); const i = el("i"); i.style.width = pct + "%"; b.append(i); left.append(b); }
  const act = el("button", "act" + (isSaved ? " saved" : "")); act.type = "button";
  act.setAttribute("aria-label", isSaved ? "端末から削除" : "端末に保存");
  act.append(svgUse(isSaved ? "i-check" : "i-down"));
  const job = dl.get(f.key);
  if (job) attachRing(act, job);
  act.addEventListener("click", async e => {
    e.stopPropagation();
    if (isSaved) {
      if (!confirm(`「${f.name}」をこの端末から削除しますか？\n（PCのファイルは消えません）`)) return;
      await removeLocal(f.key); renderSeriesList(); if (currentView === "library") renderLibrary(false);
    } else saveBook(s, f, false);
  });
  li.append(left, act);
  li.addEventListener("click", () => { if (isSaved) openBook(f.key); else if (online && s.pc) saveBook(s, f, true); else toast("PCにつながっていないため開けません"); });
  return li;
}
function attachRing(act, job) {
  act.classList.add("busy");
  let ring = act.querySelector(".ring");
  if (!ring) {
    ring = document.createElementNS("http://www.w3.org/2000/svg", "svg"); ring.setAttribute("class", "ring"); ring.setAttribute("viewBox", "0 0 40 40");
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle"); c.setAttribute("cx", "20"); c.setAttribute("cy", "20"); c.setAttribute("r", "18.5");
    c.setAttribute("stroke-dasharray", String(2 * Math.PI * 18.5)); ring.append(c); act.append(ring);
  }
  job.els.add(ring);
  setRing(ring, job.p);
}
function setRing(ring, p) { const c = ring.querySelector("circle"); const L = 2 * Math.PI * 18.5; c.setAttribute("stroke-dashoffset", String(L * (1 - Math.max(0.02, p)))); }
async function saveBook(s, f, openAfter) {
  if (dl.has(f.key)) { if (openAfter) toast("保存中です。終わったら開きます"); dl.get(f.key).openAfter ||= openAfter; return; }
  if (!online) { toast("PCにつながっていません"); return; }
  const job = { p: 0, els: new Set(), openAfter };
  dl.set(f.key, job);
  renderSeriesList();
  try {
    await downloadBook(s, f, p => { job.p = p; job.els.forEach(r => setRing(r, p)); });
    toast(`保存しました: ${volLabel(f.name).text || f.name}`);
    dl.delete(f.key);
    if (job.openAfter) await openBook(f.key);
  } catch (e) { dl.delete(f.key); toast("保存に失敗: " + (e.message || e), 5000); }
  renderSeriesList(); if (currentView === "library") renderLibrary(false);
}
$("ssSaveAll").addEventListener("click", async () => {
  const s = sheetSeries; if (!s) return;
  const idx = await getSaved();
  const todo = s.files.filter(f => !idx[f.key]);
  const total = todo.reduce((a, f) => a + (f.size || 0), 0);
  if (todo.length > 1 && !confirm(`${todo.length}冊（${fmtMB(total)}）をこの端末に保存します。よいですか？`)) return;
  for (const f of todo) { if (sheetSeries !== s) break; await saveBook(s, f, false); }
});
$("ssDelAll").addEventListener("click", async () => {
  const s = sheetSeries; if (!s) return;
  const idx = await getSaved();
  const keys = s.files.filter(f => idx[f.key]).map(f => f.key);
  if (!confirm(`この作品の${keys.length}冊を、この端末から削除しますか？\n（PCのファイルは消えません。読んだ位置は残ります）`)) return;
  for (const k of keys) await removeLocal(k);
  toast("端末から削除しました"); renderSeriesList(); renderLibrary(false);
});
async function removeLocal(key) {
  await DB.del("books", key); await DB.del("meta", key).catch(() => {}); await unsetSaved(key);
  if (coverCache.has(key)) { URL.revokeObjectURL(coverCache.get(key)); coverCache.delete(key); }
}

async function downloadBook(s, f, onProgress) {
  if (!online) throw new Error("PCにつながっていません");
  const r = await fetch(apiUrl(`/api/file/${f.id}`), { headers: { "X-SID-Token": token }, cache: "no-store" });
  if (!r.ok) throw new Error(r.status === 401 ? "合言葉が違います" : `HTTP ${r.status}`);
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
  let cover = null;
  try { const rc = await fetch(apiUrl(`/api/cover/${f.id}?t=${encodeURIComponent(token)}`)); if (rc.ok) cover = await rc.blob(); } catch (_) {}
  const rec = { key: f.key, fileId: f.id, name: f.name, series: s.title, shelf: s.shelf || "", kind: s.kind || "", site: s.site || "", variant: f.variant || "", range: f.range || "", size: blob.size, savedAt: Date.now(), pc: true, blob };
  await DB.put("books", rec);
  await DB.put("meta", { key: f.key, cover });
  await setSaved(rec);
}

$("importFile").addEventListener("change", async e => {
  const files = [...e.target.files]; e.target.value = "";
  for (const file of files) {
    try {
      const key = `local:${file.name}:${file.size}`;
      const copy = new Blob([await file.arrayBuffer()], { type: "application/epub+zip" });
      const m = file.name.match(/^(.*?)_\d{3,}_pack/);
      let kind = "", cover = null, info = null;
      try { const book = await Book.open(copy); kind = book.kind; cover = await book.coverBlob().catch(() => null); info = { pages: book.pages, kind: book.kind, title: book.title }; book.close(); } catch (_) {}
      const rec = { key, name: file.name, series: m ? m[1] : (info?.title || "端末で読み込んだEPUB"), shelf: "この端末", kind, variant: "", size: copy.size, savedAt: Date.now(), blob: copy };
      await DB.put("books", rec); await setSaved(rec);
      await DB.put("meta", { key, cover, ...(info || {}) });
      toast(`読み込みました: ${file.name}`);
    } catch (err) { toast(`読み込みに失敗: ${file.name} ${err.message || err}`, 5000); }
  }
  shelf = "この端末"; LS.set("shelf", shelf); showView("library");
});

// ---------------- 続き・保存済み ----------------
async function renderContinue() {
  const idx = await getSaved();
  const prog = new Map((await DB.all("progress").catch(() => [])).map(p => [p.key, p]));
  const recs = Object.values(idx);
  const items = recs.map(b => ({ b, p: progressFor(b, prog) })).filter(x => x.p && x.p.pages && x.p.page > 0 && x.p.page < x.p.pages - 1).sort((a, b) => b.p.at - a.p.at).slice(0, 24);
  const box = $("contList"); box.textContent = "";
  if (!items.length) box.append(el("div", "muted small", "途中まで読んだ本はここに並びます。"));
  for (const { b, p } of items) {
    const it = el("button", "contItem glass"); it.type = "button";
    const cv = coverEl("", b.series || b.name, b.kind);
    DB.get("meta", b.key).then(m => { if (m?.cover) { const img = el("img"); img.alt = ""; img.src = URL.createObjectURL(m.cover); img.onload = () => { cv.querySelector(".ph")?.remove(); URL.revokeObjectURL(img.src); }; cv.append(img); } }).catch(() => {});
    const L = volLabel(b.name);
    const sub = [L.no, L.text].filter(Boolean).join(" ");
    const txt = el("div");
    txt.append(el("div", "t", b.series || b.name), el("div", "s", (sub && sub !== b.series ? sub + " · " : "") + `${Math.round((p.page + 1) / p.pages * 100)}%${p.device && p.device !== deviceName ? ` · ${p.device}で` : ""}`));
    const bar = el("div", "bar"); const i = el("i"); i.style.width = `${Math.round((p.page + 1) / p.pages * 100)}%`; bar.append(i); txt.append(bar);
    it.append(cv, txt);
    it.addEventListener("click", () => openBook(b.key));
    box.append(it);
  }
  const sl = $("savedList"); sl.textContent = "";
  const sorted = recs.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  $("savedHead").textContent = `この端末に保存した本（${sorted.length}冊・${fmtMB(sorted.reduce((a, b) => a + (b.size || 0), 0))}）`;
  for (const b of sorted) {
    const row = el("div", "savedRow");
    const cv = coverEl("", "", b.kind);
    DB.get("meta", b.key).then(m => { if (m?.cover) { const img = el("img"); img.alt = ""; img.src = URL.createObjectURL(m.cover); img.onload = () => { cv.querySelector(".ph")?.remove(); URL.revokeObjectURL(img.src); }; cv.append(img); } }).catch(() => {});
    const t = el("div"); t.append(el("div", "n", bookTitle(b.series, b.name)), el("div", "m", `${fmtMB(b.size || 0)}${b.pc ? " · PCの本" : " · 端末のファイル"}`));
    t.style.minWidth = "0"; t.style.cursor = "pointer"; t.addEventListener("click", () => openBook(b.key));
    const del = el("button", "act"); del.type = "button"; del.setAttribute("aria-label", "端末から削除"); del.append(svgUse("i-trash"));
    del.addEventListener("click", async () => { if (!confirm(`「${b.name}」をこの端末から削除しますか？${b.pc ? "\n（PCのファイルは消えません）" : ""}`)) return; await removeLocal(b.key); renderContinue(); });
    row.append(cv, t, del); sl.append(row);
  }
  renderStorageInfo();
}
async function renderStorageInfo() {
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    const t = est ? `使用量 ${fmtMB(est.usage || 0)} / 上限の目安 ${fmtMB(est.quota || 0)}${persisted ? "（消されにくい設定）" : ""}` : "";
    $("storageInfo").textContent = t; $("storageDetail").textContent = t;
  } catch (_) {}
}

// ---------------- ZIP（部分読み） ----------------
class ZipReader {
  constructor(blob) { this.blob = blob; this.entries = new Map(); }
  async open() {
    const size = this.blob.size;
    const tailLen = Math.min(size, 65557 + 20);
    const tail = new DataView(await this.blob.slice(size - tailLen).arrayBuffer());
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
  let r = rel.split("#")[0];
  try { r = decodeURI(r); } catch (_) {}
  const parts = (base ? base.split("/") : []).concat(r.split("/"));
  const out = [];
  for (const s of parts) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }
  return out.join("/");
};
const dirOf = p => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
  css: "text/css", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", xhtml: "application/xhtml+xml", html: "text/html" };
const mimeOf = p => MIME[(p.split(".").pop() || "").toLowerCase()] || "";
const visibleText = html => { const b = html.match(/<body[^>]*>([\s\S]*)<\/body>/i); return (b ? b[1] : html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<rt>[\s\S]*?<\/rt>/gi, "").replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, "x").replace(/\s+/g, ""); };

const Book = {
  async open(blob, cached = null) {
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
    const docs = [...(spineEl?.getElementsByTagName("itemref") || [])].map(r => items.get(r.getAttribute("idref"))).filter(Boolean);
    let kind = cached?.kind || "";
    let pages = cached?.pages || null;
    if (!kind || (kind === "manga" && !pages)) {
      // 文章が入っていれば小説（文章）として、画像だけなら漫画として読む
      const results = new Array(docs.length);
      let textChars = 0, i = 0;
      const worker = async () => {
        while (i < docs.length) {
          const k = i++; const d = docs[k];
          if (/^image\//.test(d.type)) { results[k] = [d.href]; continue; }
          try {
            const html = await zip.text(d.href);
            if (k < 40) textChars += visibleText(html).length;
            const found = [];
            const re = /<(?:img|image)\b[^>]*?(?:\bsrc|xlink:href|\bhref)\s*=\s*"([^"]+)"/gi;
            let m; while ((m = re.exec(html))) found.push(posixJoin(dirOf(d.href), m[1]));
            results[k] = found;
          } catch (_) { results[k] = []; }
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      kind = textChars > 400 ? "text" : "manga";
      if (kind === "manga") { pages = []; for (const r of results) for (const p of (r || [])) if (zip.has(p)) pages.push(p); }
    }
    if (kind === "manga" && !pages?.length) throw new Error("このEPUBには表示できるページがありません");
    const urls = new Map();
    const res = new Map(); // 小説: 中の画像・CSS
    return {
      title, rtl, kind, pages: kind === "manga" ? pages : null, zip,
      docs: docs.filter(d => /x?html/.test(d.type) || /\.x?html?$/i.test(d.href)),
      async url(i) {
        if (urls.has(i)) return urls.get(i);
        const p = pages[i];
        const u = URL.createObjectURL(await zip.blobOf(p, mimeOf(p)));
        urls.set(i, u); return u;
      },
      async res(path) {
        if (res.has(path)) return res.get(path);
        const pr = (async () => {
          if (!zip.has(path)) return "";
          if (/\.css$/i.test(path)) {
            let css = await zip.text(path);
            const urlsIn = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
            for (const m of urlsIn) {
              if (/^(data|blob|https?):/i.test(m[2])) continue;
              const u = await this.res(posixJoin(dirOf(path), m[2]));
              if (u) css = css.split(m[0]).join(`url("${u}")`);
            }
            return URL.createObjectURL(new Blob([css], { type: "text/css" }));
          }
          return URL.createObjectURL(await zip.blobOf(path, mimeOf(path)));
        })();
        res.set(path, pr); return pr;
      },
      trim(center, keep = 8) { for (const [i, u] of urls) if (Math.abs(i - center) > keep) { URL.revokeObjectURL(u); urls.delete(i); } },
      async coverBlob() {
        const p = coverHref && zip.has(coverHref) ? coverHref : pages?.[0];
        if (!p) {
          const anyImg = [...items.values()].find(x => /^image\/(jpeg|png|webp|gif)/.test(x.type) && zip.has(x.href));
          if (!anyImg) throw new Error("表紙なし");
          return zip.blobOf(anyImg.href, anyImg.type);
        }
        return zip.blobOf(p, mimeOf(p) || "image/jpeg");
      },
      close() {
        for (const u of urls.values()) URL.revokeObjectURL(u); urls.clear();
        for (const pr of res.values()) pr.then(u => { if (u) URL.revokeObjectURL(u); }).catch(() => {}); res.clear();
      }
    };
  }
};

// ---------------- 読書画面 ----------------
const R = { book: null, key: "", rec: null, page: 0, views: [], vi: 0, ui: false, title: "",
  // 小説
  di: 0, pi: 0, pn: 1, vertical: false, step: 0, loading: false };
async function openBook(key) {
  const rec = await DB.get("books", key);
  if (!rec?.blob) { toast("この本はまだ保存されていません"); return; }
  closeSheets(); closeFab();
  $("reader").classList.remove("hidden"); $("reader").setAttribute("aria-hidden", "false");
  $("rLoading").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  try {
    const meta = await DB.get("meta", key).catch(() => null);
    const book = await Book.open(rec.blob, meta?.kind ? { kind: meta.kind, pages: meta.pages } : (meta?.pages ? { kind: "manga", pages: meta.pages } : null));
    if (!meta?.kind) { try { await DB.put("meta", { ...(meta || { key }), key, pages: book.pages, kind: book.kind, title: book.title, cover: meta?.cover || await book.coverBlob().catch(() => null) }); } catch (_) {} }
    R.book = book; R.key = key; R.rec = rec; R.title = rec.name;
    $("rTitle").textContent = bookTitle(rec.series, rec.name);
    if (prefs.sync && gistOn()) await Promise.race([gistSyncProgress().catch(() => {}), sleep(2500)]);
    const progMap = new Map((await DB.all("progress").catch(() => [])).map(p => [p.key, p]));
    let best = progressFor(rec, progMap);
    if (prefs.sync && online && !key.startsWith("local:")) {
      try { const all = (await api("/api/progress", { timeout: 5000 })).progress || {}; for (const [k, sp] of Object.entries(all)) if ((k === key || sp.title === rec.name) && (!best || sp.at > best.at)) best = sp; } catch (_) {}
    }
    const textMode = book.kind === "text";
    $("stage").classList.toggle("textMode", textMode); $("textFrame").classList.toggle("hidden", !textMode);
    ["rWm", "rFontDn", "rFontUp"].forEach(id => $(id).classList.toggle("hidden", !textMode));
    ["rSpread", "rDir"].forEach(id => $(id).classList.toggle("hidden", textMode));
    if (textMode) {
      let d = 0, f = 0;
      if (best && best.d != null) { d = Math.min(book.docs.length - 1, best.d); f = best.f || 0; }
      else if (best && best.pages) { const pos = best.page / best.pages * book.docs.length; d = Math.min(book.docs.length - 1, Math.floor(pos)); f = pos - d; }
      await textLoad(d, { frac: f });
      if (d > 0 || f > 0.01) toast("前回の続きから");
    } else {
      let start = 0;
      if (best && best.pages === book.pages.length) start = Math.min(best.page, book.pages.length - 1);
      else if (best && best.pages) start = Math.min(book.pages.length - 1, Math.round((best.page / best.pages) * book.pages.length));
      layout(start);
      if (start > 0) toast(`前回の続き（${start + 1}ページ）から`);
    }
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
  $("rSlider").min = "1"; $("rSlider").max = String(views.length); $("rSlider").classList.toggle("ltr", prefs.dir !== "rtl");
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
  const order = spread ? (prefs.dir === "rtl" ? [v[1], v[0]] : [v[0], v[1]]) : [v[0]];
  const urls = await Promise.all(order.map(i => R.book.url(i)));
  if (seq !== showSeq) return;
  A.src = urls[0]; A.classList.remove("hidden");
  if (spread) { B.src = urls[1]; B.classList.remove("hidden"); } else { B.removeAttribute("src"); B.classList.add("hidden"); }
  R.page = v[0];
  $("rPage").textContent = `${v.map(i => i + 1).join("-")} / ${R.book.pages.length}`;
  $("rSlider").value = String(R.vi + 1);
  saveProgress({ page: R.page, pages: R.book.pages.length });
  const near = [];
  for (let d = 1; d <= 3; d++) { const a = R.views[R.vi + d], b = R.views[R.vi - d]; if (a) near.push(...a); if (b && d <= 1) near.push(...b); }
  near.forEach(i => R.book.url(i).catch(() => {}));
  R.book.trim(R.page, 10);
}
function go(delta) {
  if (!R.book) return;
  if (R.book.kind === "text") { textGo(delta); return; }
  const ni = R.vi + delta;
  if (ni < 0) { toast("最初のページです"); return; }
  if (ni >= R.views.length) { toast("最後のページです"); return; }
  R.vi = ni; show();
}
const next = () => go(1), prev = () => go(-1);

// ---- 小説（文章EPUB）: iframeに1章ずつ出し、段組みでページに分ける ----
const SERIF = `"Hiragino Mincho ProN","Yu Mincho","YuMincho","Noto Serif JP","Noto Serif CJK JP",serif`;
function textColors() { return isDark() ? { bg: "#141518", fg: "#d9d9d6", link: "#9ab" } : { bg: "#f6f4ef", fg: "#1c1c1c", link: "#246" }; }
async function buildDocHtml(di) {
  const d = R.book.docs[di];
  const raw = await R.book.zip.text(d.href);
  let doc = new DOMParser().parseFromString(raw, "application/xhtml+xml");
  if (doc.getElementsByTagName("parsererror").length) doc = new DOMParser().parseFromString(raw, "text/html");
  const base = dirOf(d.href);
  doc.querySelectorAll("script").forEach(s => s.remove());
  for (const img of [...doc.querySelectorAll("img[src]")]) { const u = await R.book.res(posixJoin(base, img.getAttribute("src"))); if (u) img.setAttribute("src", u); }
  for (const im of [...doc.getElementsByTagNameNS("*", "image")]) {
    const a = im.getAttribute("xlink:href") != null ? "xlink:href" : "href";
    const v = im.getAttribute(a) || im.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    if (v) { const u = await R.book.res(posixJoin(base, v)); if (u) { im.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", u); im.setAttribute("href", u); } }
  }
  for (const ln of [...doc.querySelectorAll('link[href]')]) {
    if (!/stylesheet/i.test(ln.getAttribute("rel") || "")) continue;
    const u = await R.book.res(posixJoin(base, ln.getAttribute("href"))); if (u) ln.setAttribute("href", u); else ln.remove();
  }
  const head = doc.querySelector("head") || doc.documentElement.insertBefore(doc.createElementNS(doc.documentElement.namespaceURI, "head"), doc.documentElement.firstChild);
  const meta = doc.createElementNS(doc.documentElement.namespaceURI, "meta"); meta.setAttribute("charset", "utf-8"); head.prepend(meta);
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}
function frameLoad(html) {
  return new Promise(res => {
    const f = $("textFrame");
    const done = () => { f.removeEventListener("load", done); res(); };
    f.addEventListener("load", done);
    f.srcdoc = html;
  });
}
const PAD = () => Math.round(Math.min(innerWidth, innerHeight) * 0.06) + 8;
function textStyle(vertical, forced) {
  const c = textColors(); const P = PAD();
  const W = innerWidth, H = innerHeight;
  const wm = forced ? `html,body{writing-mode:${vertical ? "vertical-rl" : "horizontal-tb"}!important;-webkit-writing-mode:${vertical ? "vertical-rl" : "horizontal-tb"}!important}` : "";
  const cols = vertical
    ? `body{width:${W}px!important;height:${H}px!important;column-width:${H - 2 * P}px!important;column-gap:${2 * P}px!important;}`
    : `body{width:${W}px!important;height:${H}px!important;column-width:${W - 2 * P}px!important;column-gap:${2 * P}px!important;}`;
  return `${wm}
html{margin:0!important;padding:0!important;overflow:hidden!important;background:${c.bg}!important;color:${c.fg}!important;-webkit-text-size-adjust:100%!important}
body{margin:0!important;padding:${P}px!important;box-sizing:border-box!important;column-fill:auto!important;background:transparent!important;color:inherit!important;
 font-family:${SERIF};font-size:${prefs.font}px!important;line-height:1.85!important;word-break:normal;line-break:strict;overflow-wrap:anywhere}
${cols}
body *{max-width:none}
img,svg,video{max-width:${(vertical ? W : W) - 2 * P}px!important;max-height:${H - 2 * P}px!important;object-fit:contain;break-inside:avoid}
p,div{background:transparent!important}
a{color:${c.link}!important}
::selection{background:rgba(120,140,180,.35)}`;
}
async function textLoad(di, where = {}) {
  if (!R.book) return;
  R.loading = true;
  try {
    R.di = Math.max(0, Math.min(R.book.docs.length - 1, di));
    const html = await buildDocHtml(R.di);
    await frameLoad(html);
    const fd = $("textFrame").contentDocument;
    if (!fd) throw new Error("本文を表示できません");
    // 書き方向: 設定（本のまま=本のCSS / OPFのページ送り方向）
    let vertical;
    if (prefs.wm === "vertical") vertical = true;
    else if (prefs.wm === "horizontal") vertical = false;
    else {
      const wmHtml = getComputedStyle(fd.documentElement).writingMode, wmBody = fd.body ? getComputedStyle(fd.body).writingMode : "";
      vertical = /vertical/.test(wmHtml) || /vertical/.test(wmBody);
    }
    R.vertical = vertical;
    const st = fd.createElement("style"); st.id = "__rstyle"; st.textContent = textStyle(vertical, prefs.wm !== "auto" || (vertical && !/vertical/.test(getComputedStyle(fd.documentElement).writingMode)));
    (fd.head || fd.documentElement).append(st);
    await (fd.fonts?.ready || Promise.resolve());
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const imgs = [...fd.images].filter(i => !i.complete);
    if (imgs.length) await Promise.race([Promise.all(imgs.map(i => new Promise(r => { i.onload = i.onerror = r; }))), sleep(1500)]);
    textMeasure();
    let pi = 0;
    if (where.end) pi = R.pn - 1;
    else if (where.frac) pi = Math.min(R.pn - 1, Math.round(where.frac * R.pn));
    else if (where.page != null) pi = Math.min(R.pn - 1, where.page);
    textShow(pi);
    $("rWm").textContent = { auto: "書き方向: 本のまま", vertical: "縦書き", horizontal: "横書き" }[prefs.wm];
    $("rSlider").classList.toggle("ltr", !(vertical || R.book.rtl));
  } finally { R.loading = false; }
}
function textMeasure() {
  const fd = $("textFrame").contentDocument; const se = fd.scrollingElement || fd.documentElement;
  if (R.vertical) { R.step = innerHeight; R.pn = Math.max(1, Math.round(se.scrollHeight / R.step)); }
  else { R.step = innerWidth; R.pn = Math.max(1, Math.round(se.scrollWidth / R.step)); }
}
function textShow(pi) {
  const fd = $("textFrame").contentDocument; const se = fd?.scrollingElement || fd?.documentElement; if (!se) return;
  R.pi = Math.max(0, Math.min(R.pn - 1, pi));
  if (R.vertical) se.scrollTop = R.pi * R.step; else se.scrollLeft = R.pi * R.step;
  const n = R.book.docs.length;
  const pos = (R.di + (R.pn > 1 ? R.pi / R.pn : 0)) / n;
  $("rPage").textContent = `${Math.round(pos * 100)}%  ·  ${R.pi + 1}/${R.pn}`;
  $("rSlider").min = "0"; $("rSlider").max = "1000"; $("rSlider").value = String(Math.round(pos * 1000));
  saveProgress({ page: Math.round(pos * 1000), pages: 1000, d: R.di, f: R.pn > 1 ? R.pi / R.pn : 0 });
}
async function textGo(delta) {
  if (R.loading) return;
  const np = R.pi + delta;
  if (np >= 0 && np < R.pn) { textShow(np); return; }
  if (delta > 0) { if (R.di + 1 >= R.book.docs.length) { toast("最後のページです"); return; } await textLoad(R.di + 1, {}); }
  else { if (R.di <= 0) { toast("最初のページです"); return; } await textLoad(R.di - 1, { end: true }); }
}
async function textJumpFrac(pos) {
  const n = R.book.docs.length; const x = Math.max(0, Math.min(0.9999, pos)) * n;
  const d = Math.floor(x);
  if (d === R.di) { textShow(Math.round((x - d) * R.pn)); return; }
  await textLoad(d, { frac: x - d });
}

let progTimer = null;
function saveProgress(pos) {
  clearTimeout(progTimer);
  const key = R.key, title = R.title;
  progTimer = setTimeout(async () => {
    const p = { key, ...pos, at: Date.now() / 1000, title, device: deviceName };
    await DB.put("progress", p).catch(() => {});
    if (prefs.sync && online) api("/api/progress", { method: "POST", body: { progress: { [key]: p } }, timeout: 5000 }).catch(() => {});
    if (prefs.sync && gistOn()) { gistProgressDirty = true; clearTimeout(saveProgress.gt); saveProgress.gt = setTimeout(() => gistSyncProgress().catch(() => {}), 15000); }
  }, 700);
}
async function syncAllProgress() {
  if (!prefs.sync || !online) return;
  try {
    const local = await DB.all("progress");
    const map = {}; local.forEach(p => { map[p.key] = p; });
    const merged = (await api("/api/progress", { method: "POST", body: { progress: map }, timeout: 8000 })).progress || {};
    for (const [k, v] of Object.entries(merged)) { const l = local.find(x => x.key === k); if (!l || v.at > l.at) await DB.put("progress", { key: k, ...v }); }
  } catch (_) {}
}
function closeReader() {
  $("reader").classList.add("hidden"); $("reader").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  if (R.book) { R.book.close(); R.book = null; }
  $("textFrame").srcdoc = ""; $("pgA").removeAttribute("src"); $("pgB").removeAttribute("src");
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  setUi(false);
  if (currentView === "library") renderLibrary(false); else if (currentView === "continue") renderContinue();
  if (gistProgressDirty) gistSyncProgress().catch(() => {});
}
function setUi(on) { R.ui = on; $("rTop").classList.toggle("hidden", !on); $("rBottom").classList.toggle("hidden", !on); }

// 操作: タップ（既定: 左で次へ／中央でメニュー）、スワイプ、キー、ホイール
(function bindReader() {
  const tl = $("tapLayer");
  let sx = 0, sy = 0, st = 0, moved = false, down = false;
  tl.addEventListener("pointerdown", e => { down = true; sx = e.clientX; sy = e.clientY; st = Date.now(); moved = false; });
  tl.addEventListener("pointermove", e => { if (down && (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12)) moved = true; });
  tl.addEventListener("pointerup", e => {
    if (!down || !R.book) return; down = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (moved && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      // 指を右へ動かす（左から右へめくる）と次へ ＝ 左タップで次へ と同じ向き
      const forward = prefs.tap === "left" ? dx > 0 : dx < 0;
      forward ? next() : prev(); if (R.ui) setUi(false); return;
    }
    if (moved && R.book?.kind === "text" && R.vertical && Math.abs(dy) > 40) { dy < 0 ? next() : prev(); return; }
    if (moved || Date.now() - st > 650) return;
    const x = e.clientX / innerWidth;
    if (x > 0.36 && x < 0.64) { setUi(!R.ui); return; }
    const leftSide = x <= 0.36;
    (prefs.tap === "left" ? leftSide : !leftSide) ? next() : prev();
    if (R.ui) setUi(false);
  });
  addEventListener("keydown", e => {
    if (!R.book || $("reader").classList.contains("hidden")) return;
    const leftNext = R.book.kind === "text" ? (R.vertical || R.book.rtl) : prefs.dir === "rtl";
    if (e.key === "ArrowLeft") (leftNext ? next : prev)();
    else if (e.key === "ArrowRight") (leftNext ? prev : next)();
    else if (e.key === " " || e.key === "PageDown" || e.key === "ArrowDown") next();
    else if (e.key === "PageUp" || e.key === "ArrowUp") prev();
    else if (e.key === "Escape") closeReader();
    else return;
    e.preventDefault();
  });
  let wheelAt = 0;
  tl.addEventListener("wheel", e => { if (Date.now() - wheelAt < 250) return; wheelAt = Date.now(); e.deltaY > 0 ? next() : prev(); }, { passive: true });
  $("rBack").addEventListener("click", closeReader);
  $("rSlider").addEventListener("input", () => {
    if (!R.book) return;
    if (R.book.kind === "text") { clearTimeout(bindReader.st); bindReader.st = setTimeout(() => textJumpFrac(Number($("rSlider").value) / 1000), 120); return; }
    R.vi = Number($("rSlider").value) - 1; show();
  });
  $("rSpread").addEventListener("click", () => { setPref("spread", { auto: "on", on: "off", off: "auto" }[prefs.spread]); layout(R.page); });
  $("rDir").addEventListener("click", () => { setPref("dir", prefs.dir === "rtl" ? "ltr" : "rtl"); layout(R.page); });
  $("rWm").addEventListener("click", () => { setPref("wm", { auto: "vertical", vertical: "horizontal", horizontal: "auto" }[prefs.wm]); textLoad(R.di, { frac: R.pn > 1 ? R.pi / R.pn : 0 }); });
  const font = d => { setPref("font", Math.max(14, Math.min(30, prefs.font + d))); textLoad(R.di, { frac: R.pn > 1 ? R.pi / R.pn : 0 }); };
  $("rFontDn").addEventListener("click", () => font(-1)); $("rFontUp").addEventListener("click", () => font(1));
  $("rFull").addEventListener("click", () => { if (document.fullscreenElement) document.exitFullscreen?.(); else (document.documentElement.requestFullscreen?.() || Promise.reject()).catch(() => toast("このブラウザは全画面に対応していません（iPadはホーム画面から開くと全画面）")); });
  let rt = null;
  addEventListener("resize", () => {
    if (!R.book) return; clearTimeout(rt);
    rt = setTimeout(() => { if (R.book.kind === "text") textLoad(R.di, { frac: R.pn > 1 ? R.pi / R.pn : 0 }); else layout(R.page); }, 220);
  });
})();

// ---------------- 作品を追加（話を選んでPCへ） ----------------
function extractUrl(text) { const m = String(text || "").match(/https?:\/\/[^\s<>"']+/); return m ? m[0] : ""; }
let pick = null;     // { url, title, items:[{url,label,chapterKey,saved,unchecked,reason,sel}] }
let addDefaultsDone = false;
function openAdd(url = "") {
  closeFab();
  if (url) $("addUrl").value = url;
  if (!addDefaultsDone && serverInfo) { $("addDrive").checked = !!serverInfo.deliverDefaultDrive; $("addKindle").checked = !!serverInfo.deliverDefaultKindle; addDefaultsDone = true; }
  $("addMsg").textContent = "";
  updateAddState();
  openSheet("addSheet");
  if (!url && !$("addUrl").value) setTimeout(() => $("addUrl").focus(), 350);
}
function updateAddState() {
  const conn = online ? "PCにつながっています" : gistOn() ? "PCはオフ（GitHubに預けます）" : "PCにつながっていません";
  $("addConn").textContent = conn;
  $("previewBtn").disabled = !online;
  $("previewBtn").title = online ? "" : "話を選ぶにはPCにつながっている必要があります";
  const n = pick ? pick.items.filter(x => x.sel).length : null;
  $("addSubmit").textContent = pick ? (n ? `${n}話をPCへ送る` : "話が選ばれていません") : online ? "新しい話を全部PCへ送る" : gistOn() ? "GitHubに預ける" : "PCへ送る";
  $("addSubmit").disabled = pick ? !n : false;
}
$("pasteBtn").addEventListener("click", async () => { const u = await readClipboardUrl(); if (u) { $("addUrl").value = u; resetPick(); } });
$("addUrl").addEventListener("input", () => { if (pick && extractUrl($("addUrl").value) !== pick.url) resetPick(); });
$("reqAdd").addEventListener("click", () => openAdd());
$("modeSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; });
function resetPick() { pick = null; $("pickBox").classList.add("hidden"); updateAddState(); }
const keyTuple = k => { const m = String(k || "").match(/^(\d+)(?:\.(\d+))?$/); return m ? [Number(m[1]), m[2] ? Number(m[2]) : -1] : null; };
const keyCmp = (a, b) => a[0] - b[0] || a[1] - b[1];
function mergeByChapter(list) {
  // ルールで外したURLは、話番号の位置へ差し込む（チェックを入れ直しても順番どおり）
  const main = list.filter(x => !x.unchecked);
  for (const x of list.filter(x => x.unchecked)) {
    const k = keyTuple(x.chapterKey);
    let at = main.length;
    if (k) { const i = main.findIndex(y => { const yk = keyTuple(y.chapterKey); return yk && keyCmp(yk, k) > 0; }); if (i >= 0) at = i; }
    main.splice(at, 0, x);
  }
  return main;
}
let previewTimer = null;
function stopPreviewPoll() { clearTimeout(previewTimer); previewTimer = null; }
$("previewBtn").addEventListener("click", async () => {
  const url = extractUrl($("addUrl").value);
  if (!url) { $("addMsg").textContent = "URLが見つかりません"; return; }
  if (!online) { $("addMsg").textContent = "話を選ぶにはPCにつながっている必要があります"; return; }
  $("previewBtn").disabled = true;
  $("addMsg").textContent = "PCのFirefoxが一覧ページを読んでいます…（数十秒かかることがあります）";
  try {
    const r = await api("/api/preview", { method: "POST", body: { url, device: deviceName } });
    const id = r.id; const t0 = Date.now();
    stopPreviewPoll();
    const poll = async () => {
      try {
        const g = await api(`/api/preview?id=${encodeURIComponent(id)}`, { timeout: 8000 });
        const it = g.item || {};
        if (it.status === "done" && it.list) {
          const L = it.list;
          pick = { url, title: L.title || "", items: mergeByChapter((L.links || []).map(x => ({ ...x, sel: !x.saved && !x.completed && !x.unchecked }))) };
          $("pickTitle").value = pick.title;
          renderPick(); $("pickBox").classList.remove("hidden");
          $("addMsg").textContent = [L.orderNote, L.ruleHidden ? `ルールで${L.ruleHidden}件を非表示` : ""].filter(Boolean).join(" ・ ");
          $("previewBtn").disabled = false; $("previewBtn").textContent = "一覧を読み直す";
          return;
        }
        if (it.status === "error") throw new Error(it.message || "一覧を読めませんでした");
        $("addMsg").textContent = `${it.message || "待っています"}…（${Math.round((Date.now() - t0) / 1000)}秒）`;
        if (Date.now() - t0 > 200000) throw new Error("時間切れです。PCのFirefoxが起動しているか確認してください");
        previewTimer = setTimeout(poll, 1500);
      } catch (e) { $("addMsg").textContent = "一覧を読めませんでした: " + (e.message || e); $("previewBtn").disabled = !online; }
    };
    poll();
  } catch (e) { $("addMsg").textContent = "送れませんでした: " + (e.message || e); $("previewBtn").disabled = !online; }
});
function renderPick() {
  const ol = $("pickList"); ol.textContent = "";
  let no = 0;
  const items = pick.items;
  const nNew = items.filter(x => !x.saved && !x.completed).length;
  $("pickStats").textContent = `全${items.length}話 ・ 新しい話 ${nNew} ・ 保存済み ${items.length - nNew}`;
  items.forEach((x, i) => {
    const li = el("li", "pk" + (x.sel ? "" : " off"));
    const cb = el("input"); cb.type = "checkbox"; cb.checked = !!x.sel; cb.disabled = !!x.completed; cb.setAttribute("aria-label", x.label);
    cb.addEventListener("change", () => { x.sel = cb.checked; renderPick(); });
    if (x.sel) no++;
    const o = el("span", "o", x.sel ? String(no).padStart(2, "0") : "—");
    const l = el("div", "l");
    const b = el("b");
    if (x.completed) b.append(el("span", "tag", "完結"));
    else if (x.saved) b.append(el("span", "tag", x.savedBy === "epub" ? "EPUB済" : "済"));
    else if (x.unchecked) { const t = el("span", "tag warn", "外"); t.title = x.reason || ""; b.append(t); }
    else b.append(el("span", "tag new", "新"));
    const no2 = x.chapterKey && !String(x.label || "").includes(`${x.chapterKey}話`) ? `第${x.chapterKey}話 ` : "";
    b.append(document.createTextNode(no2 + (x.label || x.url)));
    l.append(b, el("small", "", x.unchecked && x.reason ? `${x.reason} ・ ${x.url}` : x.url));
    const mv = el("div", "mv");
    const up = el("button"); up.type = "button"; up.append(svgUse("i-up")); up.disabled = i === 0; up.setAttribute("aria-label", "上へ");
    const dn = el("button"); dn.type = "button"; dn.append(svgUse("i-dn")); dn.disabled = i === items.length - 1; dn.setAttribute("aria-label", "下へ");
    up.addEventListener("click", () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; renderPick(); });
    dn.addEventListener("click", () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; renderPick(); });
    mv.append(up, dn);
    li.append(cb, o, l, mv); ol.append(li);
  });
  updateAddState();
}
document.querySelectorAll("[data-sel]").forEach(b => b.addEventListener("click", () => {
  if (!pick) return; const m = b.dataset.sel;
  pick.items.forEach(x => { if (x.completed) return; x.sel = m === "all" ? true : m === "none" ? false : (!x.saved && !x.unchecked); });
  renderPick();
}));
$("addSubmit").addEventListener("click", async () => {
  const url = extractUrl($("addUrl").value);
  if (!url) { $("addMsg").textContent = "URLが見つかりません"; return; }
  const body = { url, deliver: { drive: $("addDrive").checked, kindle: $("addKindle").checked }, device: deviceName, mode: "list" };
  if (pick && pick.url === url) {
    body.selection = pick.items.filter(x => x.sel).map(x => ({ url: x.url, label: x.label, chapterKey: x.chapterKey || "" }));
    const t = $("pickTitle").value.trim(); if (t && t !== pick.title) body.title = t;
  }
  $("addSubmit").disabled = true;
  try {
    if (!online && gistOn()) {
      await gistSubmit(body);
      toast("GitHubに預けました。PCが起動したら処理します");
    } else {
      if (!online) throw Object.assign(new Error("offline"), { offline: true });
      const r = await api("/api/submit", { method: "POST", body });
      toast(r.duplicate ? "同じURLがすでに処理待ちです" : r.updated ? "処理待ちの依頼を、選んだ話で置き換えました" : "PCへ送りました");
    }
    $("addUrl").value = ""; resetPick(); closeSheets(); showView("requests");
  } catch (e) {
    if (e.offline || !online || e.name === "AbortError" || e instanceof TypeError) {
      const pend = await kvGet("pending", []); pend.push({ ...body, at: Date.now() }); await kvSet("pending", pend);
      toast("PCにつながらないため、この端末に保存しました。つながったら送ります", 4200);
      $("addUrl").value = ""; resetPick(); closeSheets(); showView("requests");
    } else $("addMsg").textContent = "送れませんでした: " + (e.message || e);
  } finally { $("addSubmit").disabled = false; updateAddState(); }
});

// ---------------- 依頼の状況 ----------------
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
  if (!online && !gistOn()) { ul.innerHTML = "<li class='muted small'>PCにつながると表示されます</li>"; return; }
  try {
    const r = online ? await api("/api/requests") : await gistRequests();
    ul.textContent = "";
    let running = false;
    for (const it of r.items || []) {
      const li = el("li", "glass");
      const t = el("div", "t"); t.append(el("span", "st " + it.status, ST[it.status] || it.status), el("span", "", it.seriesTitle || it.url));
      li.append(t, el("div", "m", `${it.message || ""}${it.selectionCount && !String(it.message || "").includes("話を指定") ? ` ・ ${it.selectionCount}話を指定` : ""} ・ ${new Date(((it.updatedAt || it.createdAt) || 0) * 1000).toLocaleString("ja-JP")}`));
      ul.append(li);
      if (["queued", "taken", "running"].includes(it.status)) running = true;
    }
    $("reqDot").classList.toggle("hidden", !running);
    if (!(r.items || []).length) ul.innerHTML = "<li class='muted small'>まだありません。＋の「URLで追加」から送れます。</li>";
  } catch (e) { ul.innerHTML = ""; ul.append(el("li", "muted small", e.message)); }
}
setInterval(() => { if (currentView === "requests" && !document.hidden) loadRequests(); }, 10000);

// ---------------- 設定 ----------------
function renderConn() {
  const ul = $("connState"); ul.textContent = "";
  const row = (ok, title, note) => { const li = el("li"); const mk = el("span", "mk " + (ok === true ? "ok" : ok === false ? "ng" : ""), ok === true ? "✓" : ok === false ? "!" : ""); const t = el("div", "", title); if (note) t.append(el("small", "", note)); li.append(mk, t); ul.append(li); };
  const pcHost = apiBase ? apiBase.replace(/^https?:\/\//, "") : location.host;
  row(online ? true : token ? false : null, "PC（本の一覧と保存）", online ? `つながっています（${pcHost}）${serverInfo?.readerRoot ? `\n本棚: ${serverInfo.readerRoot}` : ""}` : token ? `${netState.pcText}。PC・Firefox・helperの起動と、Tailscaleを確認` : "PCの「スマホ連携」のQRコードを読むとつながります");
  if (online && serverInfo) row(true, "PCへの道", serverInfo.publicMode === "public" ? "インターネットから（このスマホにTailscaleは不要）" : "Tailscale（このスマホにもTailscaleが必要）");
  row(gistOn() ? (ghState.ok === false ? false : true) : null, "GitHub（PCを通さずに同期・依頼）", gistOn() ? (ghState.ok === false ? ghState.err : ghState.at ? `最終同期 ${new Date(ghState.at).toLocaleTimeString("ja-JP")}` : "設定済み") : "PCで「GitHubでつなぐ」を設定してからQRを読み直すと使えます");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  row(standalone ? true : null, "ホーム画面のアプリ", standalone ? "アプリとして開いています" : /iPad|iPhone/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "共有ボタン → ホーム画面に追加" : "メニュー → アプリをインストール（またはホーム画面に追加）");
}
function renderSegs() {
  document.querySelectorAll(".seg[data-pref]").forEach(seg => seg.querySelectorAll("button").forEach(b => b.classList.toggle("on", String(prefs[seg.dataset.pref]) === b.dataset.v)));
  $("prefCoverSingle").checked = !!prefs.coverSingle; $("prefSync").checked = !!prefs.sync;
  $("prefFont").value = String(prefs.font); $("fontSizeVal").textContent = `${prefs.font}px`;
}
function renderSettings() {
  renderConn(); renderSegs();
  $("tokenInput").value = "";
  $("appVersion").textContent = `ℜ Reader v${APP_VERSION}${serverInfo ? ` ／ PC helper v${serverInfo.version}` : ""}`;
  renderStorageInfo();
  if (gistOn() && !ghState.at) gistSyncProgress().then(() => currentView === "settings" && renderConn()).catch(() => currentView === "settings" && renderConn());
}
document.querySelectorAll(".seg[data-pref]").forEach(seg => seg.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  setPref(seg.dataset.pref, b.dataset.v);
  if (seg.dataset.pref === "theme") applyTheme();
  renderSegs();
}));
$("prefCoverSingle").addEventListener("change", () => setPref("coverSingle", $("prefCoverSingle").checked));
$("prefSync").addEventListener("change", () => setPref("sync", $("prefSync").checked));
$("prefFont").addEventListener("input", () => { setPref("font", Number($("prefFont").value)); $("fontSizeVal").textContent = `${prefs.font}px`; });
$("tokenSave").addEventListener("click", async () => {
  if (!applyPairing($("tokenInput").value)) { $("tokenMsg").textContent = "PCの「スマホ連携」に出るURLを貼ってください"; return; }
  const ok = await checkServer();
  $("tokenMsg").textContent = ok ? "PCにつながりました" : gistOn() ? "GitHubを設定しました（PCは今はつながっていません）" : "つながりません（Tailscale・PCの起動を確認）";
  if (ok) { pcLibrary = null; syncAllProgress(); }
  gistSyncProgress().catch(() => {}).finally(renderConn);
});
let installEvt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("installBtn").classList.remove("hidden"); });
$("installBtn").addEventListener("click", async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (_) {} installEvt = null; $("installBtn").classList.add("hidden"); });
$("persistBtn").addEventListener("click", async () => {
  try { const ok = await navigator.storage.persist(); toast(ok ? "消されにくくしました" : "ブラウザに断られました。ホーム画面に追加して開くと許可されやすくなります"); }
  catch (_) { toast("このブラウザは対応していません"); }
  renderStorageInfo();
});
$("clearAll").addEventListener("click", async () => {
  if (!confirm("この端末に保存した本・読んだ位置をすべて削除します。PCのファイルは消えません。よいですか？")) return;
  await DB.clear("books"); await DB.clear("meta"); await DB.clear("progress"); savedIndex = {}; await kvSet("savedIndex", {});
  toast("削除しました"); renderStorageInfo();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (prefs.theme === "auto") updateThemeTile(); });

// ---------------- 起動 ----------------
(async function boot() {
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
  }
  const params = new URLSearchParams(location.search);
  const shared = extractUrl(params.get("url") || "") || extractUrl(params.get("text") || "") || extractUrl(params.get("title") || "");
  pcLibrary = await kvGet("pcLibrary", null);
  showView(LS.get("view", "library") === "settings" ? "library" : (LS.get("view", "library") || "library"));
  requestAnimationFrame(moveIndicator);
  await checkServer();
  if (!token && !gistOn()) { showView("settings"); $("tokenMsg").textContent = "PCの拡張機能の「スマホ連携」でQRコードを出して、このページを開き直してください。"; }
  if (gistOn()) { gistSyncProgress().catch(() => {}); setInterval(() => gistSyncProgress().catch(() => {}), 120000); }
  if (shared) { history.replaceState(null, "", location.pathname); openAdd(shared); }
  if (online) { await loadPcLibrary(false); if (currentView === "library") renderLibrary(false); syncAllProgress(); }
  setInterval(checkServer, 30000);
  addEventListener("online", checkServer);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkServer(); });
})();
