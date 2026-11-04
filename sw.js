// SID（リーダー）Service Worker: アプリ本体をキャッシュして、PCがオフでも起動できるようにする。
// /api/ は常にネットへ（本の中身はIndexedDBに保存するのでここでは扱わない）。
const CACHE = "sid-reader-v0.35.3";
const SHELL = ["./", "index.html", "app.js?v=0.35.3", "app.css?v=0.35.3", "manifest.webmanifest", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("sid-reader-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (url.pathname.includes("/fonts/")) return;   // v0.35: フォントはアプリが端末(IndexedDB)に保存する（ここで二重に持たない）
  if (e.request.mode === "navigate") {
    // v0.23: 本棚(index.html)以外のページ（スマホ連携のQRなど）はそのままネットへ
    if (!/\/(index\.html)?$/.test(url.pathname)) return;
    // ページ本体: まずネット（更新を取り込む）、だめならキャッシュ
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put("index.html", copy)); return r; })
      .catch(() => caches.match("index.html").then(r => r || caches.match("./"))));
    return;
  }
  // v0.24.1: 本体(app.js/app.css)はまずネット（4秒で諦めてキャッシュ）。以前は古いキャッシュを先に返していたため、
  // iPadなどで新しいページ＋古いapp.jsの組み合わせになり、表示や機能がAPKと違うことがあった
  const shell = /\/(app\.js|app\.css|manifest\.webmanifest|pair\.html)$/.test(url.pathname);
  if (shell) {
    // v0.31.1: 版付き（?v=）の本体は、同じ版のキャッシュだけを使う。違う版（古いapp.js）を返すと、新しい画面に古い動きが混ざる
    // （Funnel経由で4秒以内に届かないと古いapp.jsが使われ、新しい機能が効いていないことがあった）
    const versioned = url.searchParams.has("v");
    e.respondWith(caches.match(e.request).then(exact => {
      const net = fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; });
      if (exact) { net.catch(() => {}); return exact; }               // 同じ版があればすぐそれ（裏で取り直す）
      if (versioned) return net.catch(() => caches.match(e.request, { ignoreSearch: true }).then(h => h || Response.error()));
      return Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))])
        .catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || net));
    }));
    return;
  }
  // それ以外（アイコンなど）: キャッシュを返しつつ裏で更新
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
