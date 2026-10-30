/* ℜ Reader v0.24 — PC（D:\epub）の本を読む・端末に保存する・PCへ依頼する PWA
 * - 本棚は「PCの本」が基本。端末に保存した本もPCの本として（✓付きで）表示する
 * - 漫画（画像EPUB）と小説（文章EPUB・縦書き/横書き）を読める
 * - EPUBはZIPを部分読み（Blob.slice + DecompressionStream）するので、200MBでもメモリに全展開しない
 * - 読んだ位置はGitHub(Gist)で端末どうし直接同期（PCがオフでも）。つながっていればPCとも同期
 */
"use strict";
const APP_VERSION = "0.29.3";
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
  tap: LS.get("tap", "left"), stream: LS.get("stream", true), wm: LS.get("wm", "auto"), font: LS.get("font", 19), theme: LS.get("theme", "auto"),
  // v0.24: 小説の表示
  tbg: LS.get("tbg", "auto"), tfont: LS.get("tfont", "mincho"), tlh: LS.get("tlh", 1.85), tpad: LS.get("tpad", 1), tweight: LS.get("tweight", "400"),
  tjust: LS.get("tjust", true), toverride: LS.get("toverride", false), mbg: LS.get("mbg", "auto"),
  showAdult: LS.get("showAdult", false)   // v0.29.3: 成人漫画は基本表示しない（設定で表示）
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

// v0.26: iPad/iPhoneの「ホーム画面に追加」したアプリは、Safariと保存場所（localStorage・IndexedDB）が別。
// そのため、Safariで保存した合言葉がアプリ側に無く「PCとつながらない」状態になっていた。
// → Safariで開いている間は、ホーム画面アプリの起動URL（manifestのstart_urlと、今のURL）に合言葉を入れておく。
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function pairingHash() {
  const q = new URLSearchParams();
  if (token) q.set("t", token);
  if (apiBase) q.set("pc", apiBase);
  if (GH.gist && GH.token) { q.set("g", GH.gist); q.set("gh", GH.token); }
  return q.toString();
}
const pairingUrl = () => `${location.origin}${location.pathname}#${pairingHash()}`;
let manifestBase = null;
async function prepareHomeScreenPairing() {
  if (!isIOS || isStandalone() || window.SIDNative || !(token || (GH.gist && GH.token))) return;
  const hash = pairingHash();
  // (1) アドレスバーのURLに残す（manifestを使わないiOSは、追加したときのURLで起動する）
  if (location.hash.slice(1) !== hash) history.replaceState(null, "", location.pathname + location.search + "#" + hash);
  // (2) manifestの start_url にも入れる（追加したときの内容がアプリに残る）
  try {
    if (!manifestBase) manifestBase = await (await fetch("manifest.webmanifest", { cache: "no-store" })).json();
    const abs = u => new URL(u, location.href).href;
    const dir = abs("./");
    const m = { ...manifestBase, id: dir, scope: dir, start_url: `${location.origin}${location.pathname}#${hash}`,
      icons: (manifestBase.icons || []).map(i => ({ ...i, src: abs(i.src) })) };
    if (m.share_target) m.share_target = { ...m.share_target, action: abs(m.share_target.action || "./") };
    const link = document.querySelector('link[rel="manifest"]');
    if (link) link.href = "data:application/manifest+json;charset=utf-8," + encodeURIComponent(JSON.stringify(m));
  } catch (_) {}
}
prepareHomeScreenPairing();
// v0.27: 端末ID（PCの見張りが「知らない端末」を見分けるため）。?t= で開くURL（画像・表紙・本体）にも付ける
const apiUrl = path => (apiBase || "") + path + (/[?&]t=/.test(path) ? `&dv=${encodeURIComponent(deviceId)}` : "");
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
    const r = await fetch(apiUrl(path), { method: opts.method || "GET", headers: { "X-SID-Token": token, "X-SID-Device": deviceId, "X-SID-Device-Name": encodeURIComponent(deviceName), ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ctl.signal, cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) throw Object.assign(new Error("合言葉が違います（設定でPCのURLを貼り直してください）"), { auth: true });
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  } finally { clearTimeout(t); }
}
let netState = { pc: "", pcText: "" };
let failStreak = 0;
async function checkServer() {
  const before = online;
  if (!token) { online = false; netState = { pc: "none", pcText: "未設定" }; }
  else if (!apiBase && /github\.io$/.test(location.hostname)) { online = false; netState = { pc: "none", pcText: "PCのURLなし" }; }
  else {
    // v0.24.1: 1回の失敗ではオフにしない（Tailscale/Funnel経由や、iPadで画面に戻った直後は1回目が失敗しやすい）
    let ok = false, err = null;
    for (let i = 0; i < (online ? 3 : 2) && !ok; i++) {
      try { serverInfo = await api("/api/info", { timeout: i ? 12000 : 8000 }); ok = true; }
      catch (e) { err = e; if (e.auth) break; await sleep(i ? 2500 : 1200); }
    }
    if (ok) { online = true; failStreak = 0; netState = { pc: "on", pcText: "つながっています" }; flushPending(); }
    else { failStreak++; online = false; netState = { pc: "off", pcText: err?.auth ? "合言葉が違います" : "いまはつながっていません" }; }
  }
  $("setDot").classList.toggle("hidden", online || !token);
  const first = !checkedOnce; checkedOnce = true;
  if ((first || before !== online) && currentView === "library") renderLibrary(false);
  return online;
}

// PCの確認: 画面を見ている間だけ。つながっている間は60秒ごと、オフのときは最初の2分は8秒ごと→その後30秒ごと。
// 裏に回っている間は確認しない（電池を使わない）。アプリに戻った・フォーカスした・回線が戻った瞬間にもすぐ確認する。
let pcTimer = null, offlineSince = 0, lastCheckAt = 0;
function schedulePcCheck() {
  clearTimeout(pcTimer);
  if (document.hidden) return;
  if (online) offlineSince = 0; else if (!offlineSince) offlineSince = Date.now();
  const delay = online ? 60000 : (Date.now() - offlineSince < 120000 ? 8000 : 30000);
  pcTimer = setTimeout(() => pcCheckNow(), delay);
}
async function pcCheckNow() {
  if (Date.now() - lastCheckAt < 1500 || pcCheckNow.busy) return;
  lastCheckAt = Date.now(); pcCheckNow.busy = true;
  const was = online;
  try { await checkServer(); } finally { pcCheckNow.busy = false; schedulePcCheck(); }
  if (!was && online) { if (checkedOnce && failStreak === 0 && Date.now() - (pcCheckNow.lastToast || 0) > 60000) { pcCheckNow.lastToast = Date.now(); toast("PCにつながりました"); } syncLibMeta().catch(() => {}); if (!pcLibrary || currentView === "library") { await loadPcLibrary(false); if (currentView === "library") renderLibrary(false); } }
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
    ...(body.selection ? { selection: body.selection } : {}), ...(body.title ? { title: body.title } : {}),
    ...(body.siteMode ? { siteMode: body.siteMode, rememberMode: !!body.rememberMode } : {}), ...(body.decimalMode ? { decimalMode: body.decimalMode } : {}), ...(body.coverUrl ? { coverUrl: body.coverUrl } : {}) });
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
      // v0.24: 本棚の分類（カテゴリ・シリーズ・作者）。項目ごとに新しい方を採用し、足りない分を書き戻す
      await getLibMeta();
      const remoteL = jparse(files["sid-library.json"], {}) || {};
      const gotL = mergeLibEntries(remoteL);
      if (gotL) { await kvSet("libmeta", libMeta); pulled += gotL; }
      if (Object.entries(libMeta.entries).some(([k, v]) => Number(v.t || 0) > Number(remoteL[k]?.t || 0))) {
        await gh("PATCH", `/gists/${GH.gist}`, { files: { "sid-library.json": { content: JSON.stringify(libMeta.entries) } } });
      }
      // v0.24: サイトの型
      const remoteS = jparse(files["sid-site-modes.json"], {}) || {};
      if (mergeSiteModes(remoteS)) kvSet("siteModes", siteModesCache);
      if (Object.entries(siteModesCache).some(([k, v]) => Number(v.t || 0) > Number(remoteS[k]?.t || 0))) {
        await gh("PATCH", `/gists/${GH.gist}`, { files: { "sid-site-modes.json": { content: JSON.stringify(siteModesCache) } } });
      }
      const mine = {};
      for (const p of byKey.values()) mine[p.key] = { page: p.page, pages: p.pages, at: p.at, title: p.title, device: p.device, ...(p.d != null ? { d: p.d, f: p.f } : {}) };
      const text = JSON.stringify(mine);
      if (gistProgressDirty || files[`sid-progress-${deviceId}.json`] !== text) {
        await gh("PATCH", `/gists/${GH.gist}`, { files: { [`sid-progress-${deviceId}.json`]: { content: text } } });
        gistProgressDirty = false;
      }
      ghState = { ok: true, at: Date.now(), err: "" };
      if (pulled && R.book == null && !gistSyncProgress.quiet) { if (currentView === "library") renderLibrary(false); if (currentView === "continue") renderContinue(); }
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
  if (online) { await syncAllProgress(); await syncLibMeta().catch(() => {}); parts.push("PC ✓"); }
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
/** 保存済みの本を、いまのPCの一覧（D:\\epub）のファイルへ付け替える。キーが違っても、ファイル名が一致すれば同じ本として扱う */
async function reconcileSaved() {
  if (!pcLibrary?.series) return;
  const idx = await getSaved();
  const byName = new Map(), dupName = new Set();
  for (const s of pcLibrary.series) for (const f of s.files) { if (byName.has(f.name)) dupName.add(f.name); byName.set(f.name, { s, f }); }
  const byTitleName = new Map();
  for (const s of pcLibrary.series) for (const f of s.files) byTitleName.set(`${s.title}\n${f.name}`, { s, f });
  const nowKeys = new Set(pcLibrary.series.flatMap(s => s.files.map(f => f.rel)));
  for (const rec of Object.values(idx)) {
    if (rec.key.startsWith("local:") || nowKeys.has(rec.key)) continue;
    const hit = byTitleName.get(`${rec.series}\n${rec.name}`) || (!dupName.has(rec.name) ? byName.get(rec.name) : null);
    if (!hit) continue;
    const nk = hit.f.rel;
    if (idx[nk]) continue; // 同じ本がすでに保存されている
    try {
      const patch = { key: nk, fileId: hit.f.id, series: hit.s.title, shelf: hit.s.shelf, kind: hit.s.kind, pc: true };
      if (rec.native) { await setSaved({ ...rec, ...patch }); await unsetSaved(rec.key); }
      else {
        const full = await DB.get("books", rec.key); if (!full) continue;
        await DB.put("books", { ...full, ...patch }); await DB.del("books", rec.key);
        await unsetSaved(rec.key); await setSaved({ ...full, ...patch });
      }
      const m = await DB.get("meta", rec.key); if (m) { await DB.put("meta", { ...m, key: nk }); await DB.del("meta", rec.key); }
      const p = await DB.get("progress", rec.key); if (p) { await DB.put("progress", { ...p, key: nk }); }
    } catch (_) {}
  }
}

/** 本棚のモデル: D:\\epub の作品だけ（保存済みならその本を使う）＋「ファイル」から読み込んだ本 */
async function libraryModel() {
  const idx = await getSaved();
  const prog = new Map((await DB.all("progress").catch(() => [])).map(p => [p.key, p]));
  const pcSeries = (pcLibrary?.series || []).map(s => ({ ...s, pc: true, files: s.files.map(f => ({ ...f, key: f.rel })) }));
  const local = new Map();
  for (const rec of Object.values(idx)) {
    if (!rec.key.startsWith("local:")) continue; // PCの本はPCの一覧の側で表示（二重に出さない）
    const t = rec.series || "端末で読み込んだEPUB";
    const id = "local:" + t;
    if (!local.has(id)) local.set(id, { id, title: t, site: "", shelf: "この端末", kind: rec.kind || "", local: true, files: [], updated: Math.round((rec.savedAt || 0) / 1000) });
    local.get(id).files.push({ key: rec.key, id: "", name: rec.name, variant: "", size: rec.size, range: "", localOnly: true });
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
  // v0.29.3: 成人漫画を表示しない設定のときは、表紙も取りに行かない
  if (!prefs.showAdult && s?.id && metaOf(s.id).cat === "amanga") return "";
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

// ---------------- v0.24: 本棚の分類（カテゴリ・シリーズ・作者）。GitHubとPCで端末どうし同期 ----------------
const CATS = [["manga", "漫画"], ["novel", "小説"], ["amanga", "成人漫画"], ["anovel", "成人小説"]];
const CAT_LABEL = Object.fromEntries([...CATS, ["none", "未分類"]]);
let libMeta = null; // { entries: { 作品ID: { cat, series, author, t } } }
async function getLibMeta() {
  if (libMeta) return libMeta;
  libMeta = await kvGet("libmeta", null) || { entries: {} };
  if (!libMeta.entries) libMeta.entries = {};
  // v0.22の「フォルダ」は、シリーズ名として引き継ぐ（1回だけ）
  if (!libMeta.migratedFolders) {
    const fl = await kvGet("folders", null);
    for (const f of fl?.list || []) for (const id of f.ids || []) {
      const e = libMeta.entries[id] || {};
      if (!e.series) libMeta.entries[id] = { ...e, series: f.name, t: Number(fl.at) || 1 };
    }
    libMeta.migratedFolders = true; await kvSet("libmeta", libMeta);
  }
  return libMeta;
}
const metaOf = id => libMeta?.entries?.[id] || {};
async function setMeta(ids, patch) {
  const m = await getLibMeta(); const t = Date.now();
  for (const id of ids) {
    const cur = { ...(m.entries[id] || {}) };
    for (const [k, v] of Object.entries(patch)) { if (v) cur[k] = String(v).slice(0, 120); else delete cur[k]; }
    cur.t = t; m.entries[id] = cur;
  }
  await kvSet("libmeta", m);
  clearTimeout(setMeta.t); setMeta.t = setTimeout(() => syncLibMeta().catch(() => {}), 1500);
}
function mergeLibEntries(incoming) {
  let n = 0; const m = libMeta;
  for (const [k, v] of Object.entries(incoming || {})) {
    if (!v || typeof v !== "object") continue;
    if (Number(v.t || 0) > Number(m.entries[k]?.t || 0)) {
      const rec = {}; for (const f of ["cat", "series", "author"]) if (v[f]) rec[f] = String(v[f]); rec.t = Number(v.t);
      m.entries[k] = rec; n++;
    }
  }
  return n;
}
let libSyncing = null;
/** 分類をPC（つながっていれば）とGitHubで同期。項目ごとに新しい方を使う */
async function syncLibMeta() {
  if (libSyncing) return libSyncing;
  libSyncing = (async () => {
    await getLibMeta(); let pulled = 0;
    if (online && prefs.sync) {
      try { const r = await api("/api/libmeta", { method: "POST", body: { meta: libMeta.entries }, timeout: 8000 }); pulled += mergeLibEntries(r.meta); } catch (_) {}
    }
    if (pulled) await kvSet("libmeta", libMeta);
    if (gistOn() && prefs.sync) { try { pulled += await gistSyncProgress() || 0; } catch (_) {} }
    if (pulled && !R.book && currentView === "library") renderLibrary(false);
    return pulled;
  })().finally(() => { libSyncing = null; });
  return libSyncing;
}

let renderSeq = 0;
let lastModel = null;
let curCat = LS.get("cat", "");
let openGroup = null;      // { key, type: "series"|"author", name }
let selecting = null;      // 複数選択中の作品ID
const catOf = u => metaOf(u.id).cat || "none";
/** シリーズ物: SIDの漫画（originalフォルダ）・EPUBが2冊以上の作品・自分でシリーズ名を付けた作品 */
const isSeriesUnit = u => !!metaOf(u.id).series || u.files.length > 1 || (u.pc && u.kind === "manga");
const unitScore = u => Math.max(Number(u.lastRead?.at) || 0, Number(u.updated) || 0);
function groupUnits(units) {
  const map = new Map(); const out = [];
  const push = (key, type, name, u) => { let g = map.get(key); if (!g) { g = { key, type, name, units: [] }; map.set(key, g); out.push(g); } g.units.push(u); };
  for (const u of units) {
    const m = metaOf(u.id);
    // シリーズ物は作品名をシリーズ名とみなす（外伝などに同じシリーズ名を付けると1つにまとまる）
    const sk = m.series || (isSeriesUnit(u) ? u.title : "");
    if (sk) push("s:" + sk, "series", sk, u);
    else if (m.author) push("a:" + m.author, "author", m.author, u);
    else push("u:" + u.id, "unit", u.title, u);
  }
  for (const g of out) { if (g.units.length === 1) g.type = "unit"; g.score = Math.max(...g.units.map(unitScore)); }
  return out.sort((a, b) => b.score - a.score);
}
function unitSub(u, inGroup) {
  const m = metaOf(u.id);
  return [inGroup?.type === "series" ? "" : m.series && m.series !== u.title ? m.series : "", inGroup?.type === "author" ? "" : m.author].filter(Boolean).join(" ・ ");
}
function unitMeta(u) {
  const parts = [];
  if (u.files.length > 1) parts.push(`${u.files.length}冊`);
  if (u.site && u.site !== metaOf(u.id).author) parts.push(u.site);
  if (u.lastRead?.pages && u.lastRead.page > 0) parts.push(`${Math.round((u.lastRead.page + 1) / u.lastRead.pages * 100)}%`);
  if (u.savedCount) parts.push(u.savedCount === u.files.length ? "端末に保存済み" : `端末に${u.savedCount}冊`);
  return parts.join(" ・ ");
}
function rowEl({ title, sub, meta, kind, coverFor, stack, off, pct, sel }) {
  const r = el("button", "lrow" + (off ? " off" : "") + (sel != null ? " selecting" : "") + (sel ? " picked" : "")); r.type = "button";
  const cv = coverEl("", title, kind);
  if (stack) cv.classList.add("stack");
  if (coverFor) coverUrlFor(coverFor, lastModel?.idx || {}).then(u => { if (u) { const img = el("img"); img.alt = ""; img.loading = "lazy"; img.decoding = "async"; img.onload = () => cv.querySelector(".ph")?.remove(); img.onerror = () => img.remove(); img.src = u; cv.append(img); } });
  const tx = el("div", "lt");
  tx.append(el("div", "l1", title));
  if (sub) tx.append(el("div", "l2", sub));
  if (meta) tx.append(el("div", "l3", meta));
  if (pct != null) { const b = el("div", "bar"); const i = el("i"); i.style.width = pct + "%"; b.append(i); tx.append(b); }
  r.append(cv, tx);
  if (sel != null) { const c = el("span", "selMark"); c.append(svgUse("i-check")); r.append(c); }
  return r;
}
/** 長押し（PCは右クリックでも）でメニュー。押してすぐ離すと onTap */
function bindPress(node, onTap, onLong) {
  let t = null, x0 = 0, y0 = 0, fired = false;
  const cancel = () => { clearTimeout(t); t = null; };
  node.addEventListener("pointerdown", e => {
    if (e.button > 0) return;
    fired = false; x0 = e.clientX; y0 = e.clientY; cancel();
    t = setTimeout(() => { t = null; fired = true; try { navigator.vibrate?.(12); } catch (_) {} node.classList.add("pressed"); setTimeout(() => node.classList.remove("pressed"), 220); onLong(); }, 480);
  });
  node.addEventListener("pointermove", e => { if (t && (Math.abs(e.clientX - x0) > 10 || Math.abs(e.clientY - y0) > 10)) cancel(); });
  ["pointerup", "pointercancel", "pointerleave"].forEach(ev => node.addEventListener(ev, cancel));
  node.addEventListener("contextmenu", e => { e.preventDefault(); cancel(); if (!fired) { fired = true; onLong(); } });
  node.addEventListener("click", e => { if (fired) { e.preventDefault(); fired = false; return; } onTap(); });
}

async function renderLibrary(reload = false) {
  const seq = ++renderSeq;
  if (reload || !pcLibrary) await loadPcLibrary(reload);
  if (seq !== renderSeq) return;
  await getLibMeta();
  const model = await libraryModel(); lastModel = model;
  if (seq !== renderSeq) return;
  // v0.29.3: 成人漫画は設定で表示するまで出さない（表紙も取りに行かない）
  if (!prefs.showAdult) model.series = model.series.filter(u => catOf(u) !== "amanga");
  const filter = $("libFilter").value.trim().toLowerCase();
  // カテゴリ（上のタブ）。未分類は、あるときだけ出す
  const counts = { none: 0 }; for (const [c] of CATS) counts[c] = 0;
  for (const u of model.series) counts[catOf(u)] = (counts[catOf(u)] || 0) + 1;
  const tabs = CATS.map(([c]) => c).filter(c => prefs.showAdult || c !== "amanga").concat(counts.none ? ["none"] : []);
  if (!tabs.includes(curCat) || (!counts[curCat] && !filter)) curCat = counts.none ? "none" : (tabs.find(c => counts[c]) || "manga");
  const chips = $("shelfChips"); chips.textContent = "";
  for (const c of tabs) {
    const b = el("button", "catTab" + (c === curCat ? " on" : "") + (c === "none" ? " none" : "")); b.type = "button"; b.setAttribute("role", "tab");
    b.append(document.createTextNode(CAT_LABEL[c]), el("b", "", String(counts[c] || 0)));
    b.addEventListener("click", () => { curCat = c; LS.set("cat", c); openGroup = null; renderLibrary(false); scrollTo({ top: 0 }); });
    chips.append(b);
  }
  chips.classList.remove("hidden");
  // お知らせ
  const notice = $("libNotice");
  notice.classList.add("hidden");
  if (!token && !pcLibrary) { notice.textContent = "PCの本を見るには、PCの拡張機能の「スマホ連携」でQRコードを読んでください（設定にURLを貼っても大丈夫です）。"; notice.classList.remove("hidden"); }
  else if (!checkedOnce) { /* 接続確認中 */ }
  else if (!online && pcLibrary) { notice.textContent = "PCにつながっていません。保存した本（✓）だけ読めます。一覧は前回のものです。"; notice.classList.remove("hidden"); }
  else if (!online && token) { notice.textContent = "PCにつながっていません。PC・Firefox・helperの起動と、Tailscaleを確認してください。"; notice.classList.remove("hidden"); }
  else if (curCat === "none" && !openGroup && !selecting) { notice.textContent = "長押し（PCは右クリック）で、漫画・小説などに分けたり、シリーズ・作者を設定できます。まとめて分けるときは長押し →「複数選ぶ」。"; notice.classList.remove("hidden"); }
  // 一覧
  let units = model.series.filter(u => filter ? true : catOf(u) === curCat);
  if (filter) units = units.filter(u => { const m = metaOf(u.id); return [u.title, u.site, m.series, m.author].filter(Boolean).join(" ").toLowerCase().includes(filter); });
  let groups = groupUnits(units);
  if (openGroup && !filter) {
    const g = groups.find(x => x.key === openGroup.key);
    if (!g) openGroup = null;
    else groups = g.units.slice().sort((a, b) => a.title.localeCompare(b.title, "ja", { numeric: true })).map(u => ({ key: "u:" + u.id, type: "unit", name: u.title, units: [u] }));
  }
  const head = $("folderHead");
  head.classList.toggle("hidden", !openGroup || !!filter);
  if (openGroup) { $("folderName").textContent = openGroup.name; $("folderKind").textContent = openGroup.type === "series" ? "シリーズ" : "作者"; }
  const list = $("seriesGrid"); list.textContent = "";
  $("libEmpty").classList.toggle("hidden", !!groups.length);
  if (!groups.length) {
    $("libEmpty").textContent = "";
    $("libEmpty").append(el("b", "", filter ? "見つかりません" : model.series.length ? `${CAT_LABEL[curCat]}はまだありません` : "まだ本がありません"),
      document.createTextNode(filter ? "別の言葉でさがしてください。" : model.series.length ? "ほかのタブの本を長押しして、ここへ移せます。" : online ? "PCの D:\\epub にEPUBを置くか、＋から作品を追加してください。" : "PCにつながると、PCの本が並びます。"));
  }
  const frag = document.createDocumentFragment();
  for (const g of groups) {
    let row;
    if (g.type === "unit") {
      const u = g.units[0];
      const pct = u.lastRead?.pages ? Math.round((u.lastRead.page + 1) / u.lastRead.pages * 100) : null;
      row = rowEl({ title: u.title, sub: unitSub(u, openGroup), meta: unitMeta(u), kind: u.kind, coverFor: u, off: !online && u.pc && !u.savedCount, pct: pct && pct < 100 ? pct : null, sel: selecting ? selecting.has(u.id) : null });
      bindPress(row, () => selecting ? toggleSel([u.id]) : openUnit(u), () => openMeta([u.id], { unit: u }));
    } else {
      const ids = g.units.map(u => u.id);
      const books = g.units.reduce((a, u) => a + u.files.length, 0);
      const authors = [...new Set(g.units.map(u => metaOf(u.id).author).filter(Boolean))];
      const sub = g.type === "series" ? [authors.join("・")].filter(Boolean).join("") : "作者";
      row = rowEl({ title: g.name, sub: g.type === "series" ? (sub ? `シリーズ ・ ${sub}` : "シリーズ") : sub, meta: `${g.units.length}作品 ・ ${books}冊`, kind: g.units[0].kind, coverFor: g.units[0], stack: true,
        sel: selecting ? ids.every(id => selecting.has(id)) : null });
      bindPress(row, () => selecting ? toggleSel(ids) : (openGroup = { key: g.key, type: g.type, name: g.name }, renderLibrary(false), scrollTo({ top: 0 })), () => openMeta(ids, { group: g }));
    }
    frag.append(row);
  }
  list.append(frag);
  renderSelBar();
}
$("libFilter").addEventListener("input", () => renderLibrary(false));
$("folderBack").addEventListener("click", () => { openGroup = null; renderLibrary(false); });
async function openUnit(u) {
  const idx = lastModel?.idx || await getSaved();
  if (u.files.length === 1) {
    const f = u.files[0];
    if (idx[f.key]) return openBook(f.key);
    if (online && u.pc) return prefs.stream ? openStream(u, f) : saveBook(u, f, true);
  }
  openSeries(u);
}

// ---- 複数選ぶ ----
function toggleSel(ids) {
  if (!selecting) return;
  const all = ids.every(id => selecting.has(id));
  ids.forEach(id => all ? selecting.delete(id) : selecting.add(id));
  renderLibrary(false);
}
function renderSelBar() {
  const bar = $("selBar");
  bar.classList.toggle("hidden", !selecting);
  $("dock").classList.toggle("hide", !!selecting);
  if (selecting) $("selCount").textContent = `${selecting.size}件を選択中`;
  $("selApply").disabled = !selecting?.size;
}
$("selCancel").addEventListener("click", () => { selecting = null; renderLibrary(false); });
$("selAll").addEventListener("click", () => {
  if (!selecting || !lastModel) return;
  lastModel.series.filter(u => catOf(u) === curCat).forEach(u => selecting.add(u.id)); renderLibrary(false);
});
$("selApply").addEventListener("click", () => { if (selecting?.size) openMeta([...selecting], { bulk: true }); });

// ---- 分類シート（長押しで出る） ----
let metaCtx = null; // { ids, unit?, group?, bulk? }
async function openMeta(ids, ctx = {}) {
  await getLibMeta();
  closeSheets(true);
  metaCtx = { ids, ...ctx };
  const metas = ids.map(metaOf);
  const same = f => { const v = metas.map(m => m[f] || ""); return v.every(x => x === v[0]) ? v[0] : null; };
  const title = ctx.unit ? ctx.unit.title : ctx.group ? ctx.group.name : `${ids.length}件`;
  $("msTitle").textContent = title;
  $("msSub").textContent = ctx.unit ? [ctx.unit.site, `${ctx.unit.files.length}冊`].filter(Boolean).join(" ・ ") : ctx.group ? `${ctx.group.type === "series" ? "シリーズ" : "作者"} ・ ${ids.length}作品` : "まとめて変更します";
  const cat = same("cat");
  $("msCat").querySelectorAll("button").forEach(b => b.classList.toggle("on", (cat ?? "-") === (b.dataset.v === "none" ? "" : b.dataset.v)));
  let ser = same("series"), au = same("author");
  if (ctx.group?.type === "series") ser = ctx.group.name;   // まとめて名前を変えられるように
  if (ctx.group?.type === "author") au = ctx.group.name;
  $("msSeries").value = ser ?? ""; $("msSeries").placeholder = ser === null ? "（作品ごとに違います）" : "なし（シリーズにしない）";
  $("msAuthor").value = au ?? ""; $("msAuthor").placeholder = au === null ? "（作品ごとに違います）" : "なし";
  metaCtx.orig = { series: $("msSeries").value, author: $("msAuthor").value };
  // 入力候補
  const all = Object.values(libMeta.entries);
  const fill = (id, f) => { const dl = $(id); dl.textContent = ""; [...new Set(all.map(m => m[f]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")).slice(0, 200).forEach(v => { const o = el("option"); o.value = v; dl.append(o); }); };
  fill("dlSeries", "series"); fill("dlAuthor", "author");
  // 操作
  const acts = $("msActs"); acts.textContent = "";
  const act = (text, fn, cls = "") => { const b = el("button", "btn small " + cls, text); b.type = "button"; b.addEventListener("click", fn); acts.append(b); };
  if (ctx.unit) {
    act(ctx.unit.files.length > 1 ? "巻の一覧" : "詳細", async () => { await applyMetaFields(); closeSheets(true); openSeries(ctx.unit); });
    if (ctx.unit.files.length === 1 && ctx.unit.pc) {
      const f = ctx.unit.files[0]; const idx = await getSaved();
      if (idx[f.key]) act("端末から削除", async () => { if (!confirm(`「${f.name}」をこの端末から削除しますか？\n（PCのファイルは消えません）`)) return; await removeLocal(f.key); closeSheets(); renderLibrary(false); toast("端末から削除しました"); });
      else act("端末に保存", () => { closeSheets(); saveBook(ctx.unit, f, false); toast("保存を始めました"); });
    }
  }
  if (ctx.group) act("開く", async () => { await applyMetaFields(); closeSheets(true); openGroup = { key: ctx.group.key, type: ctx.group.type, name: ctx.group.name }; renderLibrary(false); });
  if (!ctx.bulk) act("複数選ぶ", async () => { await applyMetaFields(); closeSheets(true); selecting = new Set(ids); renderLibrary(false); });
  openSheet("metaSheet");
}
$("msCat").addEventListener("click", async e => {
  const b = e.target.closest("button[data-v]"); if (!b || !metaCtx) return;
  const v = b.dataset.v === "none" ? "" : b.dataset.v;
  await setMeta(metaCtx.ids, { cat: v });
  $("msCat").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  toast(`${metaCtx.ids.length > 1 ? `${metaCtx.ids.length}件を` : ""}「${CAT_LABEL[b.dataset.v]}」にしました`);
  if (metaCtx.bulk) { selecting = null; }
  closeSheets(); renderLibrary(false);
});
async function applyMetaFields() {
  if (!metaCtx?.orig) return false;
  const s = $("msSeries").value.trim(), a = $("msAuthor").value.trim();
  const patch = {};
  if (s !== metaCtx.orig.series) patch.series = s;
  if (a !== metaCtx.orig.author) patch.author = a;
  if (!Object.keys(patch).length) return false;
  await setMeta(metaCtx.ids, patch);
  metaCtx.orig = { series: s, author: a };
  if (openGroup && patch.series !== undefined && openGroup.type === "series") openGroup = null;
  return true;
}
$("msSeriesClr").addEventListener("click", () => { $("msSeries").value = ""; $("msSeries").placeholder = "なし（シリーズにしない）"; });
$("msAuthorClr").addEventListener("click", () => { $("msAuthor").value = ""; $("msAuthor").placeholder = "なし"; });
["msSeries", "msAuthor"].forEach(id => $(id).addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("msDone").click(); } }));
$("msDone").addEventListener("click", async () => {
  const changed = await applyMetaFields();
  if (changed) toast("保存しました（ほかの端末にも同期します）");
  if (metaCtx?.bulk) selecting = null;
  closeSheets(); renderLibrary(false);
});

// ---------------- 作品の詳細シート ----------------
let sheetSeries = null;
function openSheet(id) {
  $("scrim").classList.remove("hidden");
  const sh = $(id); sh.classList.remove("hidden", "closing");
  document.body.style.overflow = "hidden";
}
function closeSheets() {
  if (!$("metaSheet").classList.contains("hidden") && metaCtx) { const ctx = metaCtx; applyMetaFields().then(ch => { if (ch) { toast("保存しました（ほかの端末にも同期します）"); renderLibrary(false); } if (ctx.bulk) { selecting = null; renderLibrary(false); } }).catch(() => {}); metaCtx = null; }
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
// シートを下へスワイプで閉じる（上の部分をつかんだとき・中身が一番上までスクロールされているとき）
document.querySelectorAll(".sheet").forEach(sh => {
  let y0 = null, x0 = 0, dy = 0, active = false, scroller = null;
  sh.addEventListener("touchstart", e => {
    if (e.touches.length !== 1 || e.target.closest("input, textarea, select, .seg")) { y0 = null; return; }
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0; active = false;
    scroller = e.target.closest(".volList, .addBody");
  }, { passive: true });
  sh.addEventListener("touchmove", e => {
    if (y0 == null) return;
    const d = e.touches[0].clientY - y0, dx = Math.abs(e.touches[0].clientX - x0);
    if (!active) {
      if (d < 8 || dx > d) { if (d < -4 || dx > 12) y0 = null; return; }
      if (scroller && scroller.scrollTop > 0) { y0 = null; return; }
      active = true; sh.style.transition = "none";
    }
    dy = Math.max(0, d);
    sh.style.transform = innerWidth >= 760 ? `translate(-50%, calc(50% + ${dy}px))` : `translateY(${dy}px)`;
    e.preventDefault();
  }, { passive: false });
  const end = () => {
    if (!active) { y0 = null; return; }
    sh.style.transition = ""; sh.style.transform = "";
    if (dy > Math.min(140, sh.offsetHeight * 0.22)) closeSheets();
    y0 = null; active = false;
  };
  sh.addEventListener("touchend", end); sh.addEventListener("touchcancel", end);
  // マウス（PC）: つまみ・見出しをドラッグ
  sh.querySelectorAll(".grab, .sheetHead, .ssHead").forEach(g => {
    let my = null;
    g.addEventListener("pointerdown", e => { if (e.pointerType !== "mouse" || e.target.closest("button, input")) return; my = e.clientY; g.setPointerCapture(e.pointerId); });
    g.addEventListener("pointermove", e => { if (my == null) return; const d = Math.max(0, e.clientY - my); sh.style.transform = innerWidth >= 760 ? `translate(-50%, calc(50% + ${d}px))` : `translateY(${d}px)`; });
    g.addEventListener("pointerup", e => { if (my == null) return; const d = e.clientY - my; my = null; sh.style.transform = ""; if (d > 90) closeSheets(); });
  });
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
  await getLibMeta();
  const sm = metaOf(s.id);
  $("ssShelf").textContent = [CAT_LABEL[sm.cat || "none"], sm.series && sm.series !== s.title ? `シリーズ: ${sm.series}` : "", sm.author, s.site].filter(Boolean).join(" · ");
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
  li.addEventListener("click", () => {
    if (isSaved) openBook(f.key);
    else if (online && s.pc) prefs.stream ? openStream(s, f) : saveBook(s, f, true);
    else toast("PCにつながっていないため開けません（保存した本だけ読めます）");
  });
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
$("ssMetaBtn").addEventListener("click", () => { const s = sheetSeries; if (s) openMeta([s.id], { unit: s }); });
$("ssDelAll").addEventListener("click", async () => {
  const s = sheetSeries; if (!s) return;
  const idx = await getSaved();
  const keys = s.files.filter(f => idx[f.key]).map(f => f.key);
  if (!confirm(`この作品の${keys.length}冊を、この端末から削除しますか？\n（PCのファイルは消えません。読んだ位置は残ります）`)) return;
  for (const k of keys) await removeLocal(k);
  toast("端末から削除しました"); renderSeriesList(); renderLibrary(false);
});
async function removeLocal(key) {
  const rec = (await getSaved())[key];
  if (rec?.native && window.SIDNative) { try { SIDNative.remove(rec.file); } catch (_) {} }
  await DB.del("books", key); await DB.del("meta", key).catch(() => {}); await unsetSaved(key);
  if (coverCache.has(key)) { URL.revokeObjectURL(coverCache.get(key)); coverCache.delete(key); }
}

/** PCの本を端末に保存。Androidアプリでは SDカードへ（アプリが直接ダウンロード）、ブラウザでは IndexedDB へ。
 *  ブラウザでは4本同時に分けて取り寄せて速くする（Funnel/Tailscale経由は1本だと遅い） */
async function downloadBook(s, f, onProgress) {
  if (!online) throw new Error("PCにつながっていません");
  const fileUrl = apiUrl(`/api/file/${f.id}?t=${encodeURIComponent(token)}`);
  let cover = null;
  const getCover = async () => { try { const rc = await fetch(apiUrl(`/api/cover/${f.id}?t=${encodeURIComponent(token)}`)); if (rc.ok) cover = await rc.blob(); } catch (_) {} };
  const base = { key: f.key, fileId: f.id, name: f.name, series: s.title, shelf: s.shelf || "", kind: s.kind || "", site: s.site || "", variant: f.variant || "", range: f.range || "", savedAt: Date.now(), pc: true };
  if (window.SIDNative) {
    const res = await nativeDownload(fileUrl, f.name, f.size, onProgress);
    await getCover();
    const rec = { ...base, native: true, file: res.file, dir: res.dir, size: res.size };
    await DB.put("meta", { key: f.key, cover }); await setSaved(rec);
    return;
  }
  const total = f.size || 0;
  let blob;
  if (total > 6e6) {
    const CH = 4 * 1024 * 1024, n = Math.ceil(total / CH), parts = new Array(n), got = new Array(n).fill(0);
    let next = 0, failed = null;
    const worker = async () => {
      while (next < n && !failed) {
        const i = next++, a = i * CH, b = Math.min(total, a + CH) - 1;
        for (let tries = 0; ; tries++) {
          try {
            const r = await fetch(fileUrl, { headers: { Range: `bytes=${a}-${b}` }, cache: "no-store" });
            if (r.status !== 206) throw new Error(r.status === 401 ? "合言葉が違います" : `HTTP ${r.status}`);
            const rd = r.body.getReader(); const ch = []; let len = 0;
            for (;;) { const { done, value } = await rd.read(); if (done) break; ch.push(value); len += value.length; got[i] = len; onProgress(got.reduce((x, y) => x + y, 0) / total); }
            if (len !== b - a + 1) throw new Error("途中で切れました");
            parts[i] = new Blob(ch); break;
          } catch (e) { if (tries >= 2 || /合言葉/.test(e.message)) { failed = e; return; } await sleep(800); }
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (failed) throw failed;
    blob = new Blob(parts, { type: "application/epub+zip" });
  } else {
    const r = await fetch(fileUrl, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 401 ? "合言葉が違います" : `HTTP ${r.status}`);
    const reader = r.body.getReader(); const chunks = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; if (total) onProgress(got / total); }
    blob = new Blob(chunks, { type: "application/epub+zip" });
  }
  if (total && blob.size !== total) throw new Error("途中で切れました。もう一度試してください");
  try { await navigator.storage?.persist?.(); } catch (_) {}
  await getCover();
  const rec = { ...base, size: blob.size, blob };
  await DB.put("books", rec);
  await DB.put("meta", { key: f.key, cover });
  await setSaved(rec);
}
// ---- Androidアプリ（SDカードに保存） ----
const nativeJobs = new Map();
window.__sidNative = {
  progress(id, got, total) { const j = nativeJobs.get(id); if (j && total) j.onProgress(got / total); },
  done(id, json) { const j = nativeJobs.get(id); if (j) { nativeJobs.delete(id); j.resolve(JSON.parse(json)); } },
  fail(id, msg) { const j = nativeJobs.get(id); if (j) { nativeJobs.delete(id); j.reject(new Error(msg)); } }
};
function nativeDownload(url, name, size, onProgress) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    nativeJobs.set(id, { resolve, reject, onProgress });
    try { SIDNative.download(id, url, name, String(size || 0)); } catch (e) { nativeJobs.delete(id); reject(e); }
  });
}
function nativeCall(fn, ...args) { try { if (window.SIDNative && typeof SIDNative[fn] === "function") return SIDNative[fn](...args); } catch (_) {} return undefined; }
const nativeFileUrl = file => `https://appassets.androidplatform.net/sd/${encodeURIComponent(file)}`;

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
  // 保存した本 ＋ 保存せずにPCから読んだ本（PCの一覧にあるもの）
  const pcFiles = new Map();
  for (const ss of (pcLibrary?.series || [])) for (const f of ss.files) pcFiles.set(f.rel, { s: { ...ss, pc: true }, f: { ...f, key: f.rel } });
  const cand = recs.map(b => ({ b, saved: true }));
  for (const [k, pf] of pcFiles) if (!idx[k] && prog.has(k)) cand.push({ b: { key: k, name: pf.f.name, series: pf.s.title, kind: pf.s.kind }, saved: false, pf });
  const items = cand.map(x => ({ ...x, p: progressFor(x.b, prog) })).filter(x => x.p && x.p.pages && x.p.page > 0 && x.p.page < x.p.pages - 1).sort((a, b) => b.p.at - a.p.at).slice(0, 24);
  const box = $("contList"); box.textContent = "";
  if (!items.length) box.append(el("div", "muted small", "途中まで読んだ本はここに並びます。"));
  for (const { b, p, saved, pf } of items.filter(x => prefs.showAdult || !(x.pf?.s?.id && metaOf(x.pf.s.id).cat === "amanga"))) {
    const it = el("button", "contItem glass"); it.type = "button";
    const cv = coverEl(!saved && online && pf?.f?.id ? apiUrl(`/api/cover/${pf.f.id}?t=${encodeURIComponent(token)}`) : "", b.series || b.name, b.kind);
    DB.get("meta", b.key).then(m => { if (m?.cover) { const img = el("img"); img.alt = ""; img.src = URL.createObjectURL(m.cover); img.onload = () => { cv.querySelector(".ph")?.remove(); URL.revokeObjectURL(img.src); }; cv.append(img); } }).catch(() => {});
    const L = volLabel(b.name);
    const sub = [L.no, L.text].filter(Boolean).join(" ");
    const txt = el("div");
    txt.append(el("div", "t", b.series || b.name), el("div", "s", (sub && sub !== b.series ? sub + " · " : "") + `${Math.round((p.page + 1) / p.pages * 100)}%${p.device && p.device !== deviceName ? ` · ${p.device}で` : ""}`));
    const bar = el("div", "bar"); const i = el("i"); i.style.width = `${Math.round((p.page + 1) / p.pages * 100)}%`; bar.append(i); txt.append(bar);
    it.append(cv, txt);
    it.addEventListener("click", () => saved ? openBook(b.key) : online ? openStream(pf.s, pf.f) : toast("PCにつながっていないため開けません（保存した本だけ読めます）"));
    if (!saved) it.classList.toggle("off", !online);
    box.append(it);
  }
  const sl = $("savedList"); sl.textContent = "";
  const sorted = recs.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  $("savedHead").textContent = `この端末に保存した本（${sorted.length}冊・${fmtMB(sorted.reduce((a, b) => a + (b.size || 0), 0))}）`;
  for (const b of sorted) {
    const row = el("div", "savedRow");
    const cv = coverEl("", "", b.kind);
    DB.get("meta", b.key).then(m => { if (m?.cover) { const img = el("img"); img.alt = ""; img.src = URL.createObjectURL(m.cover); img.onload = () => { cv.querySelector(".ph")?.remove(); URL.revokeObjectURL(img.src); }; cv.append(img); } }).catch(() => {});
    const t = el("div"); t.append(el("div", "n", bookTitle(b.series, b.name)), el("div", "m", `${fmtMB(b.size || 0)}${b.native ? " · SDカード" : ""}${b.pc ? " · PCの本" : " · 端末のファイル"}`));
    t.style.minWidth = "0"; t.style.cursor = "pointer"; t.addEventListener("click", () => openBook(b.key));
    const del = el("button", "act"); del.type = "button"; del.setAttribute("aria-label", "端末から削除"); del.append(svgUse("i-trash"));
    del.addEventListener("click", async () => { if (!confirm(`「${b.name}」をこの端末から削除しますか？${b.pc ? "\n（PCのファイルは消えません）" : ""}`)) return; await removeLocal(b.key); renderContinue(); });
    row.append(cv, t, del); sl.append(row);
  }
  renderStorageInfo();
}
async function renderStorageInfo() {
  if (window.SIDNative) {
    try {
      const i = JSON.parse(SIDNative.storageInfo());
      const t = `保存先: ${i.removable ? "SDカード" : "本体"}（${i.dir}）・空き ${fmtMB(i.free)}${i.removable ? "" : "　※SDカードが見つからないため本体に保存しています"}`;
      $("nativeStorage").textContent = t; $("nativeStorage").classList.remove("hidden");
    } catch (_) {}
  }
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    const t = est ? `使用量 ${fmtMB(est.usage || 0)} / 上限の目安 ${fmtMB(est.quota || 0)}${persisted ? "（消されにくい設定）" : ""}` : "";
    $("storageInfo").textContent = t; $("storageDetail").textContent = t;
  } catch (_) {}
}

// ---------------- ZIP（部分読み） ----------------
/** 読み出し元: Blob（IndexedDB）／URL（SDカードの本: Range読み） */
const blobSource = blob => ({ size: blob.size, read: (a, b) => blob.slice(a, b).arrayBuffer() });
async function urlSource(url, size) {
  if (!size) { const h = await fetch(url, { method: "HEAD" }); size = Number(h.headers.get("Content-Length")) || 0; }
  return { size, read: async (a, b) => { const r = await fetch(url, { headers: { Range: `bytes=${a}-${b - 1}` } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); } };
}
class ZipReader {
  constructor(src) { this.src = src.read ? src : blobSource(src); this.entries = new Map(); }
  async open() {
    const size = this.src.size;
    const tailLen = Math.min(size, 65557 + 20);
    const tail = new DataView(await this.src.read(size - tailLen, size));
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("EPUB(ZIP)として読めません");
    let count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
    if ((cdOff === 0xFFFFFFFF || count === 0xFFFF || cdSize === 0xFFFFFFFF) && eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
      const z64off = Number(tail.getBigUint64(eocd - 20 + 8, true));
      const z = new DataView(await this.src.read(z64off, z64off + 56));
      count = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
    }
    const cd = new DataView(await this.src.read(cdOff, cdOff + cdSize));
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
      this.entries.set(name, { method, comp, usize, local, nl });
      p += 46 + nl + xl + cl;
    }
    return this;
  }
  has(name) { return this.entries.has(name); }
  get names() { return [...this.entries.keys()]; }
  async blobOf(name, type = "") {
    const e = this.entries.get(name);
    if (!e) throw new Error("EPUB内にありません: " + name);
    // ローカルヘッダの拡張欄の長さは中央ディレクトリと違うことがあるので、少し多めに一度で読む
    const pad = 30 + e.nl + 512;
    const buf = await this.src.read(e.local, Math.min(this.src.size, e.local + pad + e.comp));
    const lh = new DataView(buf, 0, 30);
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error("ZIPの中身が壊れています");
    const start = 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = new Blob([new Uint8Array(buf, start, e.comp)]);
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
/** 保存せずにPCから直接読む: helperがEPUBの中のファイルを1つずつ返す（画像はURLのまま表示するので速い） */
class RemoteZip {
  constructor(fileId) { this.id = fileId; this.set = new Set(); this.v = 0; }
  async open() {
    const info = await api(`/api/book/${this.id}`, { timeout: 20000 });
    info.names.forEach(n => this.set.add(n)); this.v = info.mtime; this.size = info.size;
    return this;
  }
  has(name) { return this.set.has(name); }
  get names() { return [...this.set]; }
  urlOf(name) { return apiUrl(`/api/entry/${this.id}?p=${encodeURIComponent(name)}&v=${this.v}&t=${encodeURIComponent(token)}`); }
  async blobOf(name, type = "") {
    const r = await fetch(this.urlOf(name));
    if (!r.ok) throw new Error(`PCから読めません (HTTP ${r.status})`);
    const b = await r.blob();
    return type ? new Blob([b], { type }) : b;
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
  async open(srcOrZip, cached = null) {
    const zip = srcOrZip instanceof RemoteZip || srcOrZip instanceof ZipReader ? srcOrZip : await new ZipReader(srcOrZip).open();
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
      // 速くする: 漫画（KCC）は Text/0001.xhtml ↔ Images/0001.jpg のように名前がそろっているので、本文を開かずにページを決める
      // Text/001_話/kcc-0001.xhtml ↔ Images/001_話/kcc-0001.jpg（話ごとのフォルダ名まで一致させる）
      const norm = (h, re) => h.replace(/\.[^./]+$/, "").replace(re, "/@/");
      const imgs = new Map();
      for (const it of items.values()) if (/^image\//.test(it.type) && !/svg/.test(it.type)) imgs.set(norm("/" + it.href, /\/(?:Images|images|image|img|Image)\//), it.href);
      const mapped = docs.map(d => /^image\//.test(d.type) ? d.href : imgs.get(norm("/" + d.href, /\/(?:Text|text|xhtml|Xhtml|html|pages)\//)) || null);
      const hit = mapped.filter(Boolean).length;
      if (docs.length >= 4 && hit / docs.length >= 0.9) {
        let sample = "";
        try { sample = visibleText(await zip.text(docs[Math.min(2, docs.length - 1)].href)); } catch (_) {}
        if (sample.length < 200) { kind = "manga"; pages = mapped.filter(p => p && zip.has(p)); }
      }
    }
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
      remote: !!zip.urlOf,
      async url(i) {
        if (zip.urlOf) return zip.urlOf(pages[i]);
        if (urls.has(i)) return urls.get(i);
        const p = pages[i];
        const u = URL.createObjectURL(await zip.blobOf(p, mimeOf(p)));
        urls.set(i, u); return u;
      },
      async res(path) {
        if (res.has(path)) return res.get(path);
        const pr = (async () => {
          if (!zip.has(path)) return "";
          if (zip.urlOf && !/\.css$/i.test(path)) return zip.urlOf(path);
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
        for (const pr of res.values()) pr.then(u => { if (u && u.startsWith("blob:")) URL.revokeObjectURL(u); }).catch(() => {}); res.clear();
      }
    };
  }
};

// ---------------- 読書画面 ----------------
const R = { book: null, key: "", rec: null, page: 0, views: [], vi: 0, ui: false, title: "",
  // 小説
  di: 0, pi: 0, pn: 1, vertical: false, step: 0, loading: false };
async function openBook(key) {
  const idx = await getSaved();
  const info = idx[key];
  if (!info) { toast("この本はまだ保存されていません"); return; }
  let src;
  if (info.native) {
    if (!window.SIDNative) { toast("この本はAndroidアプリのSDカードに保存されています"); return; }
    src = () => urlSource(nativeFileUrl(info.file), info.size).then(u => new ZipReader(u).open());
  } else {
    src = async () => { const rec = await DB.get("books", key); if (!rec?.blob) throw new Error("保存データが見つかりません。もう一度保存してください"); return rec.blob; };
  }
  return openWith(key, info, src);
}
/** 保存せずにPCから直接読む */
async function openStream(s, f) {
  if (!online) { toast("PCにつながっていません"); return; }
  return openWith(f.key, { name: f.name, series: s.title, kind: s.kind }, () => new RemoteZip(f.id).open(), true);
}
async function openWith(key, rec, getSrc, streaming = false) {
  closeSheets(); closeFab();
  $("reader").classList.remove("hidden"); $("reader").setAttribute("aria-hidden", "false");
  $("rLoading").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  nativeCall("setImmersive", true);
  try {
    const meta = await DB.get("meta", key).catch(() => null);
    const book = await Book.open(await getSrc(), meta?.kind ? { kind: meta.kind, pages: meta.pages } : (meta?.pages ? { kind: "manga", pages: meta.pages } : null));
    if (!meta?.kind) { try { await DB.put("meta", { ...(meta || { key }), key, pages: book.pages, kind: book.kind, title: book.title, cover: meta?.cover || (streaming ? null : await book.coverBlob().catch(() => null)) }); } catch (_) {} }
    R.book = book; R.key = key; R.rec = rec; R.title = rec.name;
    $("rTitle").textContent = bookTitle(rec.series, rec.name) + (streaming ? "（PCから）" : "");
    if (prefs.sync && gistOn()) await Promise.race([gistSyncProgress().catch(() => {}), sleep(2500)]);
    const progMap = new Map((await DB.all("progress").catch(() => [])).map(p => [p.key, p]));
    let best = progressFor(rec, progMap);
    if (prefs.sync && online && !key.startsWith("local:")) {
      try { const all = (await api("/api/progress", { timeout: 5000 })).progress || {}; for (const [k, sp] of Object.entries(all)) if ((k === key || sp.title === rec.name) && (!best || sp.at > best.at)) best = sp; } catch (_) {}
    }
    const textMode = book.kind === "text";
    $("stage").classList.toggle("textMode", textMode); $("textFrame").classList.toggle("hidden", !textMode);
    $("rWm").classList.toggle("hidden", !textMode);
    ["rSpread", "rDir"].forEach(id => $(id).classList.toggle("hidden", textMode));
    $("rPanel").classList.toggle("text", textMode); closePanel();
    $("reader").style.background = textMode ? textColors().bg : mangaBg();
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
  near.forEach(i => R.book.url(i).then(u => { if (R.book?.remote) { const im = new Image(); im.decoding = "async"; im.src = u; } }).catch(() => {}));
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
const SANS = `"Hiragino Sans","Yu Gothic","YuGothic","Noto Sans JP","Noto Sans CJK JP",sans-serif`;
// v0.24: 背景（ReadEraなどの一般的なリーダーを参考に）
const TBG = {
  auto: { name: "テーマ" },
  white: { name: "白", bg: "#ffffff", fg: "#1b1b1b", link: "#245" },
  paper: { name: "紙", bg: "#f6f4ef", fg: "#1c1c1c", link: "#246" },
  beige: { name: "ベージュ", bg: "#f1e7d0", fg: "#3a3024", link: "#5a4320" },
  sepia: { name: "セピア", bg: "#e6d3ad", fg: "#43331d", link: "#5b3d12" },
  mint: { name: "ミント", bg: "#dfeadb", fg: "#1f2b20", link: "#24502e" },
  gray: { name: "グレー", bg: "#3b3e44", fg: "#dadad6", link: "#a9c0d8" },
  dark: { name: "ダーク", bg: "#141518", fg: "#d9d9d6", link: "#9ab" },
  black: { name: "黒", bg: "#000000", fg: "#bdbdbb", link: "#8aa" }
};
// v0.24: フォント（Webフォントは使うときだけ読み込む。オフラインでは端末の明朝/ゴシック）
const FONTS = {
  book: { name: "本のまま", stack: "" },
  mincho: { name: "明朝", stack: SERIF, gf: "Noto+Serif+JP:wght@400;600" },
  shippori: { name: "しっぽり明朝", stack: `"Shippori Mincho",${SERIF}`, gf: "Shippori+Mincho:wght@400;600" },
  udmincho: { name: "UD明朝", stack: `"BIZ UDPMincho",${SERIF}`, gf: "BIZ+UDPMincho:wght@400;700" },
  gothic: { name: "ゴシック", stack: SANS, gf: "Noto+Sans+JP:wght@300;400;600" },
  udgothic: { name: "UDゴシック", stack: `"BIZ UDPGothic",${SANS}`, gf: "BIZ+UDPGothic:wght@400;700" },
  maru: { name: "丸ゴシック", stack: `"Zen Maru Gothic","Hiragino Maru Gothic ProN",${SANS}`, gf: "Zen+Maru+Gothic:wght@300;400;700" },
  klee: { name: "手書き風", stack: `"Klee One",${SERIF}`, gf: "Klee+One:wght@400;600" }
};
const fontOf = () => FONTS[prefs.tfont] || FONTS.mincho;
const gfUrl = (fams, text) => `https://fonts.googleapis.com/css2?${fams.map(f => "family=" + f).join("&")}&display=swap${text ? "&text=" + encodeURIComponent(text) : ""}`;
function textColors() {
  const t = TBG[prefs.tbg];
  if (t?.bg) return t;
  return isDark() ? TBG.dark : TBG.paper;
}
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
  const F = fontOf();
  if (F.gf && navigator.onLine !== false) { const ln = doc.createElementNS(doc.documentElement.namespaceURI, "link"); ln.setAttribute("rel", "stylesheet"); ln.setAttribute("href", gfUrl([F.gf])); ln.setAttribute("id", "__rfont"); head.append(ln); }
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
const PAD = () => Math.round(Math.min(innerWidth, innerHeight) * 0.06 * (Number(prefs.tpad) || 1)) + 6;
function textStyle(vertical, forced) {
  const c = textColors(); const P = PAD(); const fam = fontOf().stack;
  const W = innerWidth, H = innerHeight;
  const wm = forced ? `html,body{writing-mode:${vertical ? "vertical-rl" : "horizontal-tb"}!important;-webkit-writing-mode:${vertical ? "vertical-rl" : "horizontal-tb"}!important}` : "";
  const cols = vertical
    ? `body{width:${W}px!important;height:${H}px!important;column-width:${H - 2 * P}px!important;column-gap:${2 * P}px!important;}`
    : `body{width:${W}px!important;height:${H}px!important;column-width:${W - 2 * P}px!important;column-gap:${2 * P}px!important;}`;
  return `${wm}
html{margin:0!important;padding:0!important;overflow:hidden!important;background:${c.bg}!important;color:${c.fg}!important;-webkit-text-size-adjust:100%!important}
body{margin:0!important;padding:${P}px!important;box-sizing:border-box!important;column-fill:auto!important;background:transparent!important;color:inherit!important;
 ${fam ? `font-family:${fam}!important;` : ""}font-size:${prefs.font}px!important;line-height:${Number(prefs.tlh) || 1.85}!important;font-weight:${prefs.tweight || 400};word-break:normal;line-break:strict;overflow-wrap:anywhere;${prefs.tjust ? "text-align:justify;text-justify:inter-character;" : ""}}
${fam ? `p,div,span,li,dd,dt,blockquote,h1,h2,h3,h4,h5,h6,a,ruby,em,strong{font-family:${fam}!important}` : ""}
${prefs.toverride ? `body *{color:inherit!important;font-family:inherit!important;background:transparent!important;line-height:inherit!important}` : ""}
p{line-height:inherit}
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
    // Webフォントは読み込みを待ってからページに分ける（途中で字の幅が変わると位置がずれる）
    const fl = fd.getElementById("__rfont");
    if (fl && !fl.sheet) await Promise.race([new Promise(r => { fl.addEventListener("load", r, { once: true }); fl.addEventListener("error", r, { once: true }); }), sleep(2500)]);
    if (fl && fd.fonts?.load) { const fam = (fontOf().stack.match(/^"([^"]+)"/) || [])[1]; if (fam) await Promise.race([Promise.all([fd.fonts.load(`${prefs.font}px "${fam}"`, "あ永"), fd.fonts.load(`600 ${prefs.font}px "${fam}"`, "あ")]).catch(() => {}), sleep(3000)]); }
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
    $("rWm").textContent = { auto: "本のまま", vertical: "縦書き", horizontal: "横書き" }[prefs.wm];
    $("textFrame").style.background = textColors().bg; $("reader").style.background = textColors().bg;
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
  nativeCall("setImmersive", false);
  $("reader").classList.add("hidden"); $("reader").setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  if (R.book) { R.book.close(); R.book = null; }
  $("textFrame").srcdoc = ""; $("pgA").removeAttribute("src"); $("pgB").removeAttribute("src");
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  setUi(false);
  if (currentView === "library") renderLibrary(false); else if (currentView === "continue") renderContinue();
  if (gistProgressDirty) gistSyncProgress().catch(() => {});
}
function setUi(on) { R.ui = on; $("rTop").classList.toggle("hidden", !on); $("rBottom").classList.toggle("hidden", !on); if (!on) closePanel(); }
function mangaBg() { return prefs.mbg === "black" ? "#000" : prefs.mbg === "white" ? "#fff" : ""; }

// ---- v0.24: 表示の設定パネル ----
function closePanel() { $("rPanel").classList.add("hidden"); $("rAa").setAttribute("aria-expanded", "false"); $("rAa").classList.remove("on"); }
let fontSampleLoaded = false;
function openPanel() {
  if (!fontSampleLoaded) {
    fontSampleLoaded = true;
    const fams = Object.values(FONTS).map(f => f.gf).filter(Boolean);
    const ln = document.createElement("link"); ln.rel = "stylesheet"; ln.href = gfUrl(fams, "あ永字の明朝ゴシックUD丸手書き風しっぽり本まで"); document.head.append(ln);
  }
  renderPanel(); $("rPanel").classList.remove("hidden"); $("rAa").setAttribute("aria-expanded", "true"); $("rAa").classList.add("on");
}
function renderPanel() {
  const bg = $("rpBg"); bg.textContent = "";
  for (const [k, t] of Object.entries(TBG)) {
    const b = el("button", "sw" + (prefs.tbg === k ? " on" : "")); b.type = "button"; b.title = t.name; b.dataset.v = k;
    const c = t.bg ? t : (isDark() ? TBG.dark : TBG.paper);
    const dot = el("span", "", k === "auto" ? "自" : "あ");
    dot.style.background = k === "auto" ? `linear-gradient(135deg, ${TBG.paper.bg} 50%, ${TBG.dark.bg} 50%)` : c.bg; dot.style.color = k === "auto" ? "#888" : c.fg;
    b.append(dot, el("small", "", t.name));
    bg.append(b);
  }
  const fl = $("rpFont"); fl.textContent = "";
  for (const [k, f] of Object.entries(FONTS)) {
    const b = el("button", "fontBtn" + (prefs.tfont === k ? " on" : "")); b.type = "button"; b.dataset.v = k;
    const sample = el("span", "fs", k === "book" ? "本" : "あ永"); if (f.stack) sample.style.fontFamily = f.stack;
    b.append(sample, el("small", "", f.name)); fl.append(b);
  }
  $("rpSize").value = String(prefs.font); $("rpSizeV").textContent = `${prefs.font}px`;
  $("rpLh").value = String(prefs.tlh); $("rpLhV").textContent = Number(prefs.tlh).toFixed(2);
  $("rpPad").value = String(prefs.tpad); $("rpPadV").textContent = `${Math.round(prefs.tpad * 100)}%`;
  $("rpJustify").checked = !!prefs.tjust; $("rpOverride").checked = !!prefs.toverride;
  const segOn = (id, v) => $(id).querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === String(v)));
  segOn("rpWm", prefs.wm); segOn("rpWeight", prefs.tweight); segOn("rpSpread", prefs.spread); segOn("rpDir", prefs.dir); segOn("rpMbg", prefs.mbg); segOn("rpTap", prefs.tap);
}
let panelTimer = null;
function applyPanel(kind = "text", delay = 0) {
  renderPanel(); renderSegs();
  if (!R.book) return;
  clearTimeout(panelTimer);
  panelTimer = setTimeout(() => {
    if (!R.book) return;
    if (R.book.kind === "text") { if (kind === "text") textLoad(R.di, { frac: R.pn > 1 ? R.pi / R.pn : 0 }); }
    else { $("reader").style.background = mangaBg(); if (kind === "manga") layout(R.page); }
  }, delay);
}
$("rAa").addEventListener("click", () => $("rPanel").classList.contains("hidden") ? openPanel() : closePanel());
$("rpBg").addEventListener("click", e => { const b = e.target.closest("button[data-v]"); if (!b) return; setPref("tbg", b.dataset.v); applyPanel("text"); });
$("rpFont").addEventListener("click", e => { const b = e.target.closest("button[data-v]"); if (!b) return; setPref("tfont", b.dataset.v); applyPanel("text"); });
$("rpSize").addEventListener("input", () => { setPref("font", Number($("rpSize").value)); applyPanel("text", 260); });
$("rpLh").addEventListener("input", () => { setPref("tlh", Number($("rpLh").value)); applyPanel("text", 260); });
$("rpPad").addEventListener("input", () => { setPref("tpad", Number($("rpPad").value)); applyPanel("text", 260); });
$("rpJustify").addEventListener("change", () => { setPref("tjust", $("rpJustify").checked); applyPanel("text"); });
$("rpOverride").addEventListener("change", () => { setPref("toverride", $("rpOverride").checked); applyPanel("text"); });
const panelSeg = (id, key, kind) => $(id).addEventListener("click", e => { const b = e.target.closest("button[data-v]"); if (!b) return; setPref(key, b.dataset.v); applyPanel(kind); });
panelSeg("rpWm", "wm", "text"); panelSeg("rpWeight", "tweight", "text"); panelSeg("rpSpread", "spread", "manga"); panelSeg("rpDir", "dir", "manga"); panelSeg("rpMbg", "mbg", "mangaBg"); panelSeg("rpTap", "tap", "none");

// 操作: タップ（既定: 左で次へ／中央でメニュー）、スワイプ、キー、ホイール
(function bindReader() {
  const tl = $("tapLayer");
  let sx = 0, sy = 0, st = 0, moved = false, down = false;
  tl.addEventListener("pointerdown", e => { down = true; sx = e.clientX; sy = e.clientY; st = Date.now(); moved = false; });
  tl.addEventListener("pointermove", e => { if (down && (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12)) moved = true; });
  tl.addEventListener("pointerup", e => {
    if (!down || !R.book) return; down = false;
    if (!$("rPanel").classList.contains("hidden")) { closePanel(); return; }
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
  updateAddState(); renderModeSeg();
  if (online || gistOn()) loadSiteModes().then(renderModeSeg).catch(() => {});
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
// v0.24: サイトの型（自動=登録どおり）
let addMode = "";
const MODE_NAME = { normal: "ふつう", twostep: "2段階", gallery: "画像ページ型", chain: "多段階" };
const MODE_HINT = { "": "サイトごとに登録した型を使います（登録が無ければふつう）。", normal: "一覧ページに各話へのリンクが並ぶサイト。", twostep: "話を開いたあと「チャプターを見る」などのボタンで画像が出るサイト。作品ページから順に押して開きます。", gallery: "作品ページの小さい画像を押すと大きい画像のページになるサイト。全ページを1冊にします。", chain: "話のページから、ボタンを順に押して別のサイトへ移っていくサイト（押すものはPCの拡張機能で設定）。" };
function renderModeSeg() {
  $("modeSeg").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === addMode));
  $("rememberRow").classList.toggle("hidden", !addMode);
  let hint = MODE_HINT[addMode] || "";
  const o = originOf(extractUrl($("addUrl").value));
  const reg = o && siteModesCache[o]?.mode;
  if (!addMode && o) hint = reg ? `このサイトは「${MODE_NAME[reg]}」で登録されています。` : "このサイトは未登録です（ふつうとして読みます）。";
  else if (addMode && reg && reg !== addMode) hint += `（登録は「${MODE_NAME[reg]}」）`;
  $("modeHint").textContent = hint;
}
$("modeSeg").addEventListener("click", e => { const b = e.target.closest("button[data-v]"); if (!b || b.disabled) return; addMode = b.dataset.v; if (pick) resetPick(); renderModeSeg(); });
$("addUrl").addEventListener("input", () => renderModeSeg());
// v0.24: 小数話（13.1話など）
let decMode = LS.get("decimalMode", "default");
function applyDecMode() {
  if (!pick) return;
  pick.decimalMode = decMode;
  for (const x of pick.items) {
    if (!x.decimal || x.saved || x.completed || x.rule) continue;
    const off = decMode === "all" ? false : decMode === "integer" ? true : x.decimal === 2;
    x.unchecked = off; x.sel = !off;
    x.reason = off ? (decMode === "integer" ? "整数話だけの設定です" : "同じ番号の整数話があるので外しました") : "";
  }
}
$("decSeg").addEventListener("click", e => {
  const b = e.target.closest("button[data-v]"); if (!b) return;
  decMode = b.dataset.v; LS.set("decimalMode", decMode);
  $("decSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  applyDecMode(); if (pick) renderPick();
});
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
    const r = await api("/api/preview", { method: "POST", body: { url, device: deviceName, ...(addMode ? { siteMode: addMode } : {}), decimalMode: decMode } });
    const id = r.id; const t0 = Date.now();
    stopPreviewPoll();
    const poll = async () => {
      try {
        const g = await api(`/api/preview?id=${encodeURIComponent(id)}`, { timeout: 8000 });
        const it = g.item || {};
        if (it.status === "done" && it.list) {
          const L = it.list;
          pick = { url, title: L.title || "", gallery: !!L.gallery, items: mergeByChapter((L.links || []).map(x => ({ ...x, sel: !x.saved && !x.completed && !x.unchecked }))) };
          applyDecMode();
          $("decRow").classList.toggle("hidden", !pick.items.some(x => x.decimal));
          $("decSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x.dataset.v === decMode));
          $("pickTitle").value = pick.title;
          // v0.27.1: 作者（PCがページから読んだもの・前に入れたもの）と、画像ページ型の取り方
          $("pickAuthor").value = L.author || "";
          pick.author = L.author || "";
          $("galMethodRow").classList.toggle("hidden", !pick.gallery);
          $("pickGalMethod").value = LS.get("galMethod", "");
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
  $("pickStats").textContent = pick.gallery ? `全${items.length}ページ（画像ページ型・1冊にします）` : `全${items.length}話 ・ 新しい話 ${nNew} ・ 保存済み ${items.length - nNew}`;
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
    else if (x.unchecked) { const t = el("span", "tag warn", x.decimal && !x.rule ? "小数" : "外"); t.title = x.reason || ""; b.append(t); }
    else if (x.decimal) b.append(el("span", "tag new", "小数"));
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
  // v0.27.1: 「すべて」は押すたびに 全部選ぶ ⇔ 全部外す（PCの拡張機能と同じ）
  const selectable = pick.items.filter(x => !x.completed);
  const allOn = selectable.length && selectable.every(x => x.sel);
  pick.items.forEach(x => { if (x.completed) return; x.sel = m === "all" ? !allOn : m === "none" ? false : (!x.saved && !x.unchecked); });
  renderPick();
}));
$("addSubmit").addEventListener("click", async () => {
  const url = extractUrl($("addUrl").value);
  if (!url) { $("addMsg").textContent = "URLが見つかりません"; return; }
  const body = { url, deliver: { drive: $("addDrive").checked, kindle: $("addKindle").checked }, device: deviceName, decimalMode: decMode };
  if (addMode) { body.siteMode = addMode; body.rememberMode = $("rememberMode").checked; }
  const cu = $("addCoverUrl").value.trim();
  if (cu) { if (!/^https?:\/\//i.test(cu)) { $("addMsg").textContent = "表紙の画像URLは https:// で始まるURLにしてください"; return; } body.coverUrl = cu; }
  if (pick && pick.url === url) {
    body.selection = pick.items.filter(x => x.sel).map(x => ({ url: x.url, label: x.label, chapterKey: x.chapterKey || "" }));
    const t = $("pickTitle").value.trim(); if (t && t !== pick.title) body.title = t;
    const a = $("pickAuthor").value.trim(); if (a) body.author = a;
    if (pick.gallery && $("pickGalMethod").value) { body.galleryMethod = $("pickGalMethod").value; }
    LS.set("galMethod", $("pickGalMethod").value);
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
    if (body.siteMode && body.rememberMode) setSiteModeRemote(originOf(url), body.siteMode).catch(() => {});
    $("addUrl").value = ""; $("addCoverUrl").value = ""; resetPick(); closeSheets(); showView("requests");
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
      if (it.position) t.firstChild.textContent = `待ち ${it.position}番目`;
      if (it.siteMode) t.append(el("span", "tag", MODE_NAME[it.siteMode] || it.siteMode));
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
  $("prefCoverSingle").checked = !!prefs.coverSingle; $("prefSync").checked = !!prefs.sync; $("prefStream").checked = !!prefs.stream;
  $("prefFont").value = String(prefs.font); $("fontSizeVal").textContent = `${prefs.font}px`;
}
function renderSettings() {
  $("prefShowAdult").checked = !!prefs.showAdult;
  renderConn(); renderHomeApp(); renderSegs(); loadSiteModes().then(renderSiteModes).catch(() => renderSiteModes());
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
$("prefStream").addEventListener("change", () => setPref("stream", $("prefStream").checked));
$("prefShowAdult").addEventListener("change", () => { setPref("showAdult", $("prefShowAdult").checked); if (!prefs.showAdult && curCat === "amanga") curCat = ""; });
$("prefFont").addEventListener("input", () => { setPref("font", Number($("prefFont").value)); $("fontSizeVal").textContent = `${prefs.font}px`; });
async function connectWithText(text) {
  if (!applyPairing(text)) { $("tokenMsg").textContent = "PCの「スマホ連携」に出るURL（または「ホーム画面アプリ用のURL」）を貼ってください"; return; }
  prepareHomeScreenPairing();
  const ok = await checkServer();
  $("tokenMsg").textContent = ok ? "PCにつながりました" : gistOn() ? "GitHubを設定しました（PCは今はつながっていません）" : "つながりません（Tailscale・PCの起動を確認）";
  if (ok) { pcLibrary = null; await loadPcLibrary(false).catch(() => {}); syncAllProgress(); }
  gistSyncProgress().catch(() => {}).finally(() => { renderConn(); renderHomeApp(); });
}
$("tokenSave").addEventListener("click", () => connectWithText($("tokenInput").value));
// v0.26: ホーム画面アプリ ⇔ Safari の受け渡し
function renderHomeApp() {
  const box = $("homeAppBox"); if (!box) return;
  const standalone = isStandalone() && !window.SIDNative;
  const paired = !!(token || (GH.gist && GH.token));
  const showCopy = isIOS && !standalone && paired;
  const showPaste = standalone && (!online || !token);
  $("copyPairUrl").classList.toggle("hidden", !showCopy);
  $("pasteConnect").classList.toggle("hidden", !showPaste);
  box.classList.toggle("hidden", !showCopy && !showPaste);
  $("homeAppNote").textContent = showPaste
    ? "ホーム画面のアプリはSafariと保存場所が別なので、最初に一度だけつなぎます。Safariでℜ Readerを開き、設定の「ホーム画面アプリ用のURLをコピー」を押してから、ここに戻って「コピーしたURLでつなぐ」を押してください。（Safariで本棚を開き直してからホーム画面に追加し直しても、自動でつながります）"
    : showCopy ? "「ホーム画面に追加」すると、合言葉もいっしょにアプリへ入ります。前に追加したアプリがつながらないときは、アプリを削除して追加し直すか、このボタンでコピーしてアプリの設定で貼ってください（このURLには合言葉が入っています。人に送らないでください）。" : "";
}
$("copyPairUrl").addEventListener("click", async () => {
  const url = pairingUrl();
  try { await navigator.clipboard.writeText(url); toast("コピーしました。ホーム画面のアプリを開いて「コピーしたURLでつなぐ」を押してください", 4200); }
  catch (_) { $("tokenInput").value = url; $("tokenInput").select(); toast("コピーできなかったので、上の欄のURLを長押ししてコピーしてください", 4200); }
});
$("pasteConnect").addEventListener("click", async () => {
  let text = "";
  try { text = await navigator.clipboard.readText(); } catch (_) {}
  if (!text) { $("tokenMsg").textContent = "クリップボードを読めませんでした。上の欄に長押しで貼り付けて「つなぐ」を押してください"; $("tokenInput").focus(); return; }
  await connectWithText(text);
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

// ---------------- v0.24: サイトの型（PCの拡張機能と共通の表。PC・GitHubどちらか経由で同期） ----------------
let siteModesCache = {};
function originOf(text) {
  let t = String(text || "").trim(); if (!t) return "";
  if (!/^https?:\/\//i.test(t)) t = "https://" + t;
  try { return new URL(t).origin.toLowerCase(); } catch (_) { return ""; }
}
function mergeSiteModes(inc) {
  let n = 0;
  for (const [k, v] of Object.entries(inc || {})) {
    if (!v || typeof v !== "object" || !/^https?:\/\//.test(k)) continue;
    if (Number(v.t || 0) > Number(siteModesCache[k]?.t || 0)) { siteModesCache[k] = { mode: String(v.mode || ""), t: Number(v.t) || 0 }; n++; }
  }
  return n;
}
async function loadSiteModes() {
  if (online) { try { const r = await api("/api/site-modes", { method: "POST", body: { entries: siteModesCache }, timeout: 6000 }); mergeSiteModes(r.entries); } catch (_) {} }
  else if (gistOn()) { gistSyncProgress.quiet = true; try { await gistSyncProgress(); } catch (_) {} finally { gistSyncProgress.quiet = false; } }
  await kvSet("siteModes", siteModesCache);
}
async function setSiteModeRemote(origin, mode) {
  if (!origin) throw new Error("サイトのURLが正しくありません");
  siteModesCache[origin] = { mode, t: Date.now() };
  await kvSet("siteModes", siteModesCache);
  if (online) await api("/api/site-modes", { method: "POST", body: { entries: { [origin]: siteModesCache[origin] } }, timeout: 6000 });
  else if (gistOn()) await gistSyncProgress();
  else toast("PCかGitHubにつながったら反映します");
}
function renderSiteModes() {
  const box = $("siteModesList"); box.textContent = "";
  const items = Object.entries(siteModesCache).filter(([, v]) => v.mode).map(([o, v]) => ({ o, host: o.replace(/^https?:\/\//, ""), mode: v.mode })).sort((a, b) => a.host.localeCompare(b.host));
  box.classList.toggle("muted", !items.length);
  if (!items.length) { box.textContent = online || gistOn() ? "登録したサイトはまだありません。PCの拡張機能で型を選ぶか、ここで登録できます。" : "PCかGitHubにつながると表示されます"; return; }
  for (const mode of ["normal", "gallery", "chain"]) {
    const mine = items.filter(x => x.mode === mode); if (!mine.length) continue;
    const g = el("div", "smGroup"); g.append(el("div", "smHead", `${MODE_NAME[mode]}（${mine.length}）`));
    for (const it of mine) {
      const row = el("div", "smRow");
      const seg = el("div", "seg");
      for (const m of ["normal", "gallery", "chain"]) { const b = el("button", m === it.mode ? "on" : "", { normal: "ふつう", twostep: "2段階", gallery: "画像", chain: "多段" }[m]); b.type = "button"; b.addEventListener("click", () => setSiteModeRemote(it.o, m).then(renderSiteModes).catch(e => toast(e.message))); seg.append(b); }
      const del = el("button", "iconBtn"); del.type = "button"; del.setAttribute("aria-label", "登録を外す"); del.append(svgUse("i-x"));
      del.addEventListener("click", () => setSiteModeRemote(it.o, "").then(renderSiteModes).catch(e => toast(e.message)));
      row.append(el("span", "smHost", it.host), seg, del); g.append(row);
    }
    box.append(g);
  }
}
let smNew = "normal";
$("smNew").addEventListener("click", e => { const b = e.target.closest("button[data-v]"); if (!b) return; smNew = b.dataset.v; $("smNew").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); });
$("smAdd").addEventListener("click", async () => {
  const o = originOf($("smHost").value); if (!o) { toast("サイトのURLかドメインを入れてください"); return; }
  try { await setSiteModeRemote(o, smNew); $("smHost").value = ""; renderSiteModes(); toast(`${o.replace(/^https?:\/\//, "")} を「${MODE_NAME[smNew]}」で登録しました`); } catch (e) { toast(e.message || String(e)); }
});

// ---------------- v0.23: スマホ連携（QR）をアプリが開いている最中でも取り込む ----------------
async function pairNow(text) {
  if (!applyPairing(text)) return false;
  history.replaceState(null, "", location.pathname + location.search);
  prepareHomeScreenPairing();
  pcLibrary = null;
  const ok = await checkServer();
  toast(ok ? "PCにつながりました" : gistOn() ? "GitHubを設定しました（PCは今はつながっていません）" : "合言葉を保存しました（PCにはまだつながっていません）", 3200);
  if (ok) { await loadPcLibrary(false); syncAllProgress(); }
  gistSyncProgress().catch(() => {}).finally(renderConn);
  showView("library");
  return true;
}
window.__sidPair = text => { pairNow(String(text || "")).catch(() => {}); return true; };
addEventListener("hashchange", () => { if (location.hash.length > 1) pairNow(location.href).catch(() => {}); });

// ---------------- v0.23: 下に引っ張って更新（アプリ/ホーム画面版。本を読んでいる間は無効） ----------------
async function refreshCurrentView() {
  await checkServer();
  if (currentView === "library") { if (online) await loadPcLibrary(true); await syncLibMeta().catch(() => {}); await renderLibrary(false); }
  else if (currentView === "continue") { if (gistOn()) await gistSyncProgress().catch(() => {}); if (online) await syncAllProgress().catch(() => {}); await renderContinue(); }
  else if (currentView === "requests") await loadRequests();
  else renderSettings();
  toast(online ? "更新しました" : "PCにつながっていません（保存した本だけ表示）");
}
(() => {
  const enabled = !!window.SIDNative || matchMedia("(display-mode: standalone)").matches;
  if (!enabled) return; // 普通のブラウザはブラウザ自身の引っ張って更新がある
  document.documentElement.classList.add("ptrOn");
  const ind = el("div", "ptr"); ind.setAttribute("aria-hidden", "true"); ind.append(svgUse("i-refresh"));
  document.body.append(ind);
  const PULL = 72, MAX = 120;
  let y0 = null, x0 = 0, d = 0, busy = false;
  const blocked = () => !$("reader").classList.contains("hidden") || !!document.querySelector(".sheet:not(.hidden)") || $("dock").classList.contains("open");
  const place = v => { ind.style.transform = `translate(-50%, ${v - 56}px) rotate(${v * 3}deg)`; ind.style.opacity = String(Math.min(1, v / PULL)); };
  const reset = () => { ind.classList.remove("show", "ready", "spin"); ind.style.transform = ""; ind.style.opacity = ""; d = 0; };
  addEventListener("touchstart", e => {
    if (busy || e.touches.length !== 1 || scrollY > 0 || blocked()) { y0 = null; return; }
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; d = 0;
  }, { passive: true });
  addEventListener("touchmove", e => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0, dx = Math.abs(e.touches[0].clientX - x0);
    if (dy <= 0 || scrollY > 0 || dx > dy) { if (d) reset(); return; }
    d = Math.min(MAX, dy * 0.5);
    ind.classList.add("show"); ind.classList.toggle("ready", d >= PULL); place(d);
  }, { passive: true });
  addEventListener("touchend", async () => {
    if (y0 == null) return;
    y0 = null;
    if (d < PULL || blocked()) { reset(); return; }
    busy = true; ind.classList.add("spin"); place(PULL);
    try { await refreshCurrentView(); } catch (e) { toast(String(e.message || e)); }
    finally { busy = false; reset(); }
  }, { passive: true });
})();

// ---------------- 起動 ----------------
// Androidアプリの「戻る」ボタン
window.__sidBack = () => {
  if (!$("reader").classList.contains("hidden")) { closeReader(); return true; }
  if (document.querySelector(".sheet:not(.hidden)")) { closeSheets(); return true; }
  if ($("dock").classList.contains("open")) { closeFab(); return true; }
  if (selecting) { selecting = null; renderLibrary(false); return true; }
  if (openGroup) { openGroup = null; renderLibrary(false); return true; }
  if (currentView !== "library") { showView("library"); return true; }
  return false;
};
(async function boot() {
  if (window.SIDNative) document.documentElement.classList.add("native");
  else if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
  }
  const params = new URLSearchParams(location.search);
  const shared = extractUrl(params.get("url") || "") || extractUrl(params.get("text") || "") || extractUrl(params.get("title") || "");
  pcLibrary = await kvGet("pcLibrary", null);
  siteModesCache = await kvGet("siteModes", {}) || {};
  await getLibMeta().catch(() => {});
  await reconcileSaved().catch(() => {});
  showView(LS.get("view", "library") === "settings" ? "library" : (LS.get("view", "library") || "library"));
  requestAnimationFrame(moveIndicator);
  await checkServer();
  if (!token && !gistOn()) { showView("settings"); $("tokenMsg").textContent = isStandalone() && isIOS ? "ホーム画面のアプリは、Safariとは別に一度つなぐ必要があります（下の説明を見てください）。" : "PCの拡張機能の「スマホ連携」でQRコードを出して、このページを開き直してください。"; renderHomeApp(); }
  if (gistOn()) { gistSyncProgress().catch(() => {}); setInterval(() => gistSyncProgress().catch(() => {}), 120000); }
  if (shared) { history.replaceState(null, "", location.pathname); openAdd(shared); }
  if (online) { await loadPcLibrary(false); if (currentView === "library") renderLibrary(false); syncAllProgress(); }
  syncLibMeta().catch(() => {});
  if (online) loadSiteModes().catch(() => {});
  schedulePcCheck();
  addEventListener("online", () => pcCheckNow());
  addEventListener("focus", () => pcCheckNow());
  addEventListener("pageshow", () => pcCheckNow());
  // 画面に戻った直後は回線が戻っていないことがあるので少し待ってから確認
  document.addEventListener("visibilitychange", () => { if (!document.hidden) setTimeout(pcCheckNow, 900); else clearTimeout(pcTimer); });
})();
