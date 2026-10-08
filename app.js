/* MD Viewer: Dropbox 上の Markdown をブラウザだけで読むビューア。
 * サーバーは持たない。Dropbox とは OAuth (PKCE) で直接つながり、
 * 取得した本文と画像は端末の IndexedDB にキャッシュしてオフラインでも読めるようにする。 */
(() => {
"use strict";

const CFG = window.MDV_CONFIG || {};
const MD_EXT = /\.(md|markdown|mdown|mkd)$/i;
const TEXT_EXT = /\.(txt|text)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i;
const RECENT_MAX = 15;

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const titleEl = $("#title");

// ---------- small utils ----------
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lower = p => (p || "").toLowerCase();
const basename = p => p.slice(p.lastIndexOf("/") + 1);
const dirname = p => { const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };
const joinPath = (a, b) => (a === "/" ? "" : a) + "/" + b;
function normalizePath(p) {
  const out = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop(); else out.push(seg);
  }
  return "/" + out.join("/");
}
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }
function resolveRel(dir, ref) {
  ref = safeDecode(ref.split("#")[0].split("?")[0]).trim();
  if (ref.startsWith("<") && ref.endsWith(">")) ref = ref.slice(1, -1);
  return normalizePath(ref.startsWith("/") ? ref : joinPath(dir, ref));
}
const isExternal = u => /^[a-z][a-z0-9+.-]*:/i.test(u);
function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
function toast(msg, ms = 2500) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function setOffline(on) { $("#offline-badge").hidden = !on; }
// Dropbox-API-Arg ヘッダは ASCII しか通らないので、日本語のパスは \uXXXX にする
const argHeader = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4));

// ---------- IndexedDB cache ----------
const db = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open("mdviewer", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction("kv", mode);
      const out = fn(t.objectStore("kv"));
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    get: k => tx("readonly", s => s.get(k)).catch(() => undefined),
    put: (k, v) => tx("readwrite", s => { s.put(v, k); }).catch(() => {}),
    clear: () => tx("readwrite", s => { s.clear(); }),
    async each(prefix, cb) {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction("kv", "readonly");
        const range = IDBKeyRange.bound(prefix, prefix + "￿");
        const r = t.objectStore("kv").openCursor(range);
        r.onsuccess = () => { const c = r.result; if (c) { cb(c.key, c.value); c.continue(); } };
        t.oncomplete = () => res(); t.onerror = () => rej(t.error);
      });
    },
  };
})();

// ---------- auth (OAuth 2 PKCE, no server) ----------
const appKey = () => CFG.APP_KEY || store.get("mdv_app_key", "");
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, "");
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randStr = n => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function startLogin(manual) {
  const verifier = randStr(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = randStr(12);
  store.set("mdv_pkce", { verifier, state, manual: !!manual });
  const q = new URLSearchParams({
    client_id: appKey(), response_type: "code", token_access_type: "offline",
    code_challenge: challenge, code_challenge_method: "S256",
  });
  if (!manual) { q.set("redirect_uri", redirectUri()); q.set("state", state); }
  const url = "https://www.dropbox.com/oauth2/authorize?" + q;
  if (manual) window.open(url, "_blank"); else location.href = url;
}

async function tokenRequest(params) {
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: appKey(), ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || "token error " + r.status);
  return j;
}

async function finishLogin(code, manual) {
  const pk = store.get("mdv_pkce");
  if (!pk) throw new Error("ログインをやり直してください");
  const params = { grant_type: "authorization_code", code, code_verifier: pk.verifier };
  if (!manual) params.redirect_uri = redirectUri();
  const j = await tokenRequest(params);
  store.set("mdv_token", { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
  store.del("mdv_pkce");
  await setupAccount();
}

let refreshing = null;
async function accessToken(force) {
  const t = store.get("mdv_token");
  if (!t) throw Object.assign(new Error("not logged in"), { auth: true });
  if (!force && Date.now() < t.exp) return t.access;
  if (!refreshing) {
    refreshing = tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh })
      .then(j => {
        const nt = { ...t, access: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
        store.set("mdv_token", nt);
        return nt.access;
      })
      .catch(e => {
        if (e instanceof TypeError) throw e; // network
        store.del("mdv_token");
        throw Object.assign(new Error("ログインの有効期限が切れました"), { auth: true });
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// ---------- Dropbox API ----------
function pathRootHeader() {
  const pr = store.get("mdv_pathroot");
  return pr ? { "Dropbox-API-Path-Root": pr } : {};
}

async function dbx(kind, endpoint, args, retried) {
  const token = await accessToken();
  let r;
  if (kind === "rpc") {
    r = await fetch("https://api.dropboxapi.com/2/" + endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...pathRootHeader() },
      body: args === undefined ? "null" : JSON.stringify(args),
    });
  } else {
    r = await fetch("https://content.dropboxapi.com/2/" + endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Dropbox-API-Arg": argHeader(args), ...pathRootHeader() },
    });
  }
  if (r.status === 401 && !retried) { await accessToken(true); return dbx(kind, endpoint, args, true); }
  if (r.status === 401) { store.del("mdv_token"); throw Object.assign(new Error("ログインし直してください"), { auth: true }); }
  if (r.status === 429) { await new Promise(s => setTimeout(s, 1500)); return dbx(kind, endpoint, args, retried); }
  if (!r.ok) {
    const txt = await r.text();
    let summary = txt;
    try { summary = JSON.parse(txt).error_summary || txt; } catch {}
    throw Object.assign(new Error(summary), { status: r.status, summary, notFound: /not_found/.test(summary) });
  }
  if (kind === "rpc") return r.json();
  let meta = null;
  try { meta = JSON.parse(r.headers.get("Dropbox-API-Result")); } catch {}
  return { blob: await r.blob(), meta };
}

async function setupAccount() {
  // チームスペース（Dropbox Business）では、チーム全体のルートから見えるように Path-Root を設定する
  store.del("mdv_pathroot");
  const acct = await dbx("rpc", "users/get_current_account");
  const ri = acct.root_info || {};
  if (ri.root_namespace_id && ri.root_namespace_id !== ri.home_namespace_id) {
    store.set("mdv_pathroot", JSON.stringify({ ".tag": "root", root: ri.root_namespace_id }));
  }
  store.set("mdv_account", { name: acct.name && acct.name.display_name, email: acct.email });
  if (!store.get("mdv_home")) await locateDefaultHome();
}

async function locateDefaultHome() {
  const want = CFG.DEFAULT_HOME || "/";
  if (want === "/") { store.set("mdv_home", "/"); return; }
  try {
    const m = await dbx("rpc", "files/get_metadata", { path: want });
    store.set("mdv_home", m.path_display); return;
  } catch (e) { if (!e.notFound) throw e; }
  // 見つからなければフォルダ名で探す（Business だとメンバーフォルダの下にあることがある）
  try {
    const name = basename(want);
    const r = await dbx("rpc", "files/search_v2", { query: name, options: { file_categories: [{ ".tag": "folder" }], filename_only: true, max_results: 20 } });
    const hits = (r.matches || []).map(m => m.metadata && m.metadata.metadata).filter(m => m && m[".tag"] === "folder" && lower(m.name) === lower(name));
    if (hits.length) { store.set("mdv_home", hits[0].path_display); return; }
  } catch {}
  store.set("mdv_home", "/");
}

async function listFolder(path) {
  let r = await dbx("rpc", "files/list_folder", { path: path === "/" ? "" : path, limit: 2000 });
  const entries = [...r.entries];
  while (r.has_more) {
    r = await dbx("rpc", "files/list_folder/continue", { cursor: r.cursor });
    entries.push(...r.entries);
  }
  return entries.map(slimEntry);
}
const slimEntry = e => ({ tag: e[".tag"], name: e.name, path: e.path_display, rev: e.rev, size: e.size, mod: e.server_modified });

// ---------- cached readers ----------
function decodeText(buf) {
  let t = new TextDecoder("utf-8").decode(buf);
  const bad = (t.match(/�/g) || []).length;
  if (bad > 3) { try { t = new TextDecoder("shift_jis").decode(buf); } catch {} }
  return t.replace(/^﻿/, "");
}

async function fetchDoc(path) {
  const { blob, meta } = await dbx("content", "files/download", { path });
  const text = decodeText(await blob.arrayBuffer());
  const rec = { path: meta ? meta.path_display : path, text, rev: meta && meta.rev, mod: meta && meta.server_modified, at: Date.now() };
  await db.put("doc:" + lower(path), rec);
  return rec;
}

const blobUrls = new Map();
async function loadImage(path, { network = true } = {}) {
  const key = lower(path);
  if (blobUrls.has(key)) return blobUrls.get(key);
  let rec = await db.get("img:" + key);
  if (!rec && network) {
    const { blob, meta } = await dbx("content", "files/download", { path });
    rec = { blob: fixSvgType(blob, path), rev: meta && meta.rev, at: Date.now() };
    await db.put("img:" + key, rec);
  }
  if (!rec) throw Object.assign(new Error("not cached"), { notFound: true });
  const url = URL.createObjectURL(rec.blob);
  blobUrls.set(key, url);
  return url;
}
const fixSvgType = (blob, path) => /\.svg$/i.test(path) && blob.type !== "image/svg+xml" ? new Blob([blob], { type: "image/svg+xml" }) : blob;

// Obsidian 形式の ![[名前]] などはファイル名だけなので、ホーム以下から名前で探す
const nameCache = new Map();
async function findByName(name, wantExt) {
  const key = lower(name);
  if (nameCache.has(key)) return nameCache.get(key);
  let found = null;
  const idx = store.get("mdv_nameidx", {});
  if (idx[key]) found = idx[key];
  else if (navigator.onLine) {
    try {
      const r = await dbx("rpc", "files/search_v2", { query: name, options: { path: homePath() === "/" ? "" : homePath(), filename_only: true, max_results: 25 } });
      const hits = (r.matches || []).map(m => m.metadata && m.metadata.metadata).filter(m => m && m[".tag"] === "file");
      const exact = hits.find(m => lower(m.name) === key) || hits.find(m => wantExt && lower(m.name) === key + wantExt);
      found = exact ? exact.path_display : null;
    } catch {}
  }
  nameCache.set(key, found);
  return found;
}

// ---------- recent / prefs ----------
const homePath = () => store.get("mdv_home", "/");
function addRecent(path) {
  const r = store.get("mdv_recent", []).filter(p => lower(p) !== lower(path));
  r.unshift(path);
  store.set("mdv_recent", r.slice(0, RECENT_MAX));
}
function applyFont() { document.documentElement.style.setProperty("--font-scale", store.get("mdv_font", 1)); }

// ---------- routing ----------
const enc = p => encodeURIComponent(p).replace(/%2F/g, "/");
const routeTo = (kind, path) => { location.hash = "#/" + kind + enc(path); };
let current = { kind: "home", path: "/" };
const scrollMemo = new Map();
let navDepth = 0;

function parseHash() {
  const h = location.hash.slice(1) || "/";
  const m = h.match(/^\/(f|v|s)(.*)$/);
  if (!m) return { kind: "home" };
  if (m[1] === "s") return { kind: "search", q: new URLSearchParams(m[2].replace(/^\?/, "")).get("q") || "" };
  return { kind: m[1] === "f" ? "folder" : "doc", path: safeDecode(m[2]) || "/" };
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const r = parseHash();
  current = r;
  $("#menu").hidden = true;
  $("#btn-back").disabled = r.kind === "home" || (r.kind === "folder" && r.path === "/");
  try {
    if (!appKey()) return showSetup();
    if (!store.get("mdv_token")) return showLogin();
    if (r.kind === "home") await showFolder(homePath(), true, seq);
    else if (r.kind === "folder") await showFolder(r.path, false, seq);
    else if (r.kind === "doc") await showDoc(r.path, seq);
    else if (r.kind === "search") await showSearch(r.q, seq);
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e.auth) return showLogin(e.message);
    view.innerHTML = `<div class="card"><h1>読み込めませんでした</h1><p class="small">${esc(e.message || e)}</p><a class="btn ghost" href="#/">ホームへ</a></div>`;
  }
  if (seq === renderSeq) window.scrollTo(0, scrollMemo.get(location.hash) || 0);
}

// ---------- screens ----------
function showSetup() {
  titleEl.textContent = "はじめに";
  view.innerHTML = `
  <div class="card stack">
    <h1>Dropbox アプリの App key</h1>
    <p>Dropbox App Console で作ったアプリの App key を入れてください。この端末にだけ保存されます。</p>
    <input type="text" id="appkey" placeholder="App key" autocapitalize="off" autocorrect="off" spellcheck="false">
    <p class="small">App Console の Redirect URIs には次を登録してください:<br><code id="ru">${esc(redirectUri())}</code></p>
    <button class="btn" id="save">保存</button>
  </div>`;
  $("#save").onclick = () => {
    const v = $("#appkey").value.trim();
    if (!v) return;
    store.set("mdv_app_key", v);
    render();
  };
}

function showLogin(msg) {
  titleEl.textContent = "MD Viewer";
  view.innerHTML = `
  <div class="card stack">
    <h1>Dropbox でログイン</h1>
    <p>Dropbox のファイルを直接読みに行きます。ファイルはこの端末と Dropbox の間だけでやりとりされます。</p>
    ${msg ? `<p class="small">${esc(msg)}</p>` : ""}
    <button class="btn" id="login">Dropbox でログイン</button>
  </div>
  <details class="card">
    <summary>ログイン後にこの画面へ戻ってこない場合</summary>
    <div class="stack" style="margin-top:12px">
      <p class="small">ホーム画面から開いたときに戻れないことがあります。下のボタンで認可ページを開き、表示されたコードをここに貼り付けてください。</p>
      <button class="btn ghost" id="login-manual">認可ページを開く</button>
      <input type="text" id="code" placeholder="表示されたコード" autocapitalize="off" autocorrect="off" spellcheck="false">
      <button class="btn" id="code-go">コードでログイン</button>
    </div>
  </details>`;
  $("#login").onclick = () => startLogin(false);
  $("#login-manual").onclick = () => startLogin(true);
  $("#code-go").onclick = async () => {
    const code = $("#code").value.trim();
    if (!code) return;
    try { await finishLogin(code, true); location.hash = "#/"; render(); }
    catch (e) { toast("ログインできませんでした: " + e.message, 4000); }
  };
}

function crumbsHtml(path) {
  const parts = path.split("/").filter(Boolean);
  let acc = "";
  const links = [`<a href="#/f/">Dropbox</a>`];
  for (const p of parts) { acc += "/" + p; links.push(`<a href="#/f${esc(enc(acc))}">${esc(p)}</a>`); }
  return `<div class="crumbs">${links.join(" / ")}</div>`;
}

function entryIcon(e) {
  if (e.tag === "folder") return "📁";
  if (MD_EXT.test(e.name)) return "📝";
  if (TEXT_EXT.test(e.name)) return "📄";
  if (IMG_EXT.test(e.name)) return "🖼️";
  if (/\.pdf$/i.test(e.name)) return "📕";
  return "📎";
}

function sortEntries(list) {
  const coll = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
  return [...list].sort((a, b) => (a.tag === "folder" ? 0 : 1) - (b.tag === "folder" ? 0 : 1) || coll.compare(a.name, b.name));
}

// ふだんは読むものだけ出す（アプリのコードや作業ファイルが混ざっていても邪魔にならないように）
const isShown = e => store.get("mdv_showall", false) || (e.tag === "folder"
  ? !/^(\.|node_modules$|__pycache__$)/.test(e.name)
  : MD_EXT.test(e.name) || TEXT_EXT.test(e.name) || IMG_EXT.test(e.name) || /\.pdf$/i.test(e.name));

function entriesHtml(entries) {
  entries = entries.filter(isShown);
  if (!entries.length) return `<div class="empty">表示できるファイルがありません</div>`;
  return `<ul class="list">${sortEntries(entries).map(e => {
    const readable = e.tag === "folder" || MD_EXT.test(e.name) || TEXT_EXT.test(e.name);
    const href = e.tag === "folder" ? "#/f" + enc(e.path) : readable ? "#/v" + enc(e.path) : null;
    const meta = e.tag === "file" ? fmtDate(e.mod) : "";
    const inner = `<span class="ico">${entryIcon(e)}</span><span class="name">${esc(e.name)}</span><span class="meta">${meta}</span>`;
    return href
      ? `<li><a href="${esc(href)}">${inner}</a></li>`
      : `<li><a href="#" class="dim" data-open="${esc(e.path)}">${inner}</a></li>`;
  }).join("")}</ul>`;
}

async function openRaw(path) {
  try {
    const r = await dbx("rpc", "files/get_temporary_link", { path });
    window.open(r.link, "_blank");
  } catch (e) { toast("開けませんでした: " + e.message); }
}

async function showFolder(path, isHome, seq) {
  titleEl.textContent = path === "/" ? "Dropbox" : basename(path);
  const recent = isHome ? store.get("mdv_recent", []) : [];
  const recentHtml = recent.length
    ? `<div class="section-title">最近開いたもの</div><ul class="list">${recent.slice(0, 5).map(p =>
        `<li><a href="#/v${esc(enc(p))}"><span class="ico">🕘</span><span class="name">${esc(basename(p))}<span class="sub">${esc(dirname(p))}</span></span></a></li>`).join("")}</ul>
       <div class="section-title">${esc(path === "/" ? "Dropbox" : basename(path))}</div>`
    : "";
  const paint = entries => {
    if (seq !== renderSeq) return;
    view.innerHTML = crumbsHtml(path) + recentHtml + entriesHtml(entries);
    view.querySelectorAll("[data-open]").forEach(a => a.onclick = ev => { ev.preventDefault(); openRaw(a.dataset.open); });
  };
  const cached = await db.get("ls:" + lower(path));
  if (cached) paint(cached.entries);
  else view.innerHTML = crumbsHtml(path) + `<div class="progress">読み込み中…</div>`;
  try {
    const entries = await listFolder(path);
    setOffline(false);
    await db.put("ls:" + lower(path), { entries, at: Date.now() });
    if (!cached || JSON.stringify(cached.entries) !== JSON.stringify(entries)) paint(entries);
  } catch (e) {
    if (e.auth) throw e;
    if (e.notFound && isHome) {
      store.set("mdv_home", "/");
      toast("ホームフォルダが見つからないので一番上を表示します");
      return showFolder("/", true, seq);
    }
    if (!cached) throw offlineErr(e);
    setOffline(true);
  }
}
const offlineErr = e => e instanceof TypeError ? new Error("オフラインで、このフォルダはまだ保存されていません") : e;

async function showDoc(path, seq) {
  titleEl.textContent = basename(path);
  addRecent(path);
  const cached = await db.get("doc:" + lower(path));
  let shownRev = null;
  if (cached) { await paintDoc(cached, seq); shownRev = cached.rev; }
  else view.innerHTML = `<div class="progress">読み込み中…</div>`;
  try {
    const fresh = await fetchDoc(path);
    setOffline(false);
    if (!cached || fresh.rev !== shownRev || fresh.text !== cached.text) {
      const y = window.scrollY;
      await paintDoc(fresh, seq);
      if (cached) window.scrollTo(0, y);
    }
  } catch (e) {
    if (e.auth) throw e;
    if (!cached) throw offlineErr(e);
    setOffline(true);
  }
}

// ---------- markdown rendering ----------
marked.use({ gfm: true, breaks: false });

function preprocess(text) {
  // front matter は表示しない
  text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  // Obsidian の埋め込みとリンク
  text = text.replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, name, alt) => `![${alt || ""}](mdv-wiki/${encodeURIComponent(name.trim())})`);
  text = text.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, name, _h, label) => `[${label || name}](mdv-wikilink/${encodeURIComponent(name.trim())})`);
  // 空白を含むパス（Obsidian などでよくある）は CommonMark では無効なので <> で囲む
  text = text.replace(/(!?\[[^\]\n]*\]\()([^()<>"'\n]*?[ \u3000][^()<>"'\n]*?)\)/g, (_, head, url) => `${head}<${url.trim()}>)`);
  return text;
}

function slugify(s) {
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s+/g, "-");
}

async function paintDoc(rec, seq) {
  if (seq !== renderSeq) return;
  const path = rec.path;
  const dir = dirname(path);
  const tpl = document.createElement("template");
  if (TEXT_EXT.test(path)) {
    tpl.innerHTML = `<pre style="white-space:pre-wrap">${esc(rec.text)}</pre>`;
  } else {
    tpl.innerHTML = DOMPurify.sanitize(marked.parse(preprocess(rec.text)), { ADD_ATTR: ["target"] });
  }
  const frag = tpl.content;

  // 見出しにアンカー
  const used = new Map();
  frag.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach(h => {
    let id = slugify(h.textContent) || "section";
    const n = used.get(id) || 0; used.set(id, n + 1);
    if (n) id += "-" + n;
    h.id = id;
  });

  // 画像: 相対パスは Dropbox から取得（テンプレート上で src を外すので、ホスティング先へは問い合わせない）
  const imgs = [];
  frag.querySelectorAll("img").forEach(img => {
    const src = img.getAttribute("src") || "";
    if (!src || isExternal(src) || src.startsWith("//")) return;
    img.removeAttribute("src");
    img.classList.add("loading");
    img.dataset.ref = src;
    imgs.push(img);
  });

  // リンク
  frag.querySelectorAll("a[href]").forEach(a => {
    const href = a.getAttribute("href");
    if (href.startsWith("#")) { a.dataset.anchor = safeDecode(href.slice(1)); return; }
    if (isExternal(href) || href.startsWith("//")) { a.target = "_blank"; a.rel = "noopener"; return; }
    if (href.startsWith("mdv-wikilink/")) { a.dataset.wikilink = safeDecode(href.slice(13)); a.setAttribute("href", "#"); return; }
    const target = resolveRel(dir, href);
    if (MD_EXT.test(target) || TEXT_EXT.test(target)) a.setAttribute("href", "#/v" + enc(target));
    else if (!/\.[^/]+$/.test(basename(target))) a.setAttribute("href", "#/f" + enc(target));
    else { a.dataset.open = target; a.setAttribute("href", "#"); }
  });

  const meta = document.createElement("div");
  meta.className = "docmeta";
  meta.textContent = path + (rec.mod ? "  ·  更新 " + fmtDate(rec.mod) : "");
  const wrap = document.createElement("article");
  wrap.className = "md";
  wrap.appendChild(frag);
  view.replaceChildren(meta, wrap);

  wrap.addEventListener("click", async ev => {
    const a = ev.target.closest("a");
    if (!a) return;
    if (a.dataset.anchor != null) {
      ev.preventDefault();
      const el = document.getElementById(a.dataset.anchor) || document.getElementById(slugify(a.dataset.anchor));
      if (el) el.scrollIntoView({ behavior: "smooth" });
    } else if (a.dataset.wikilink) {
      ev.preventDefault();
      const name = a.dataset.wikilink;
      const direct = joinPath(dir, MD_EXT.test(name) ? name : name + ".md");
      const p = (await db.get("doc:" + lower(direct))) ? direct : (await findByName(MD_EXT.test(name) ? name : name + ".md")) || direct;
      routeTo("v", p);
    } else if (a.dataset.open) {
      ev.preventDefault();
      openRaw(a.dataset.open);
    }
  });

  const loadOne = async img => {
    const ref = img.dataset.ref;
    try {
      let url;
      if (ref.startsWith("mdv-wiki/")) {
        const name = safeDecode(ref.slice(9));
        const direct = joinPath(dir, name);
        try { url = await loadImage(direct); }
        catch (e) {
          if (!e.notFound) throw e;
          const p = await findByName(name);
          if (!p) throw e;
          url = await loadImage(p);
        }
      } else {
        url = await loadImage(resolveRel(dir, ref));
      }
      img.src = url;
      img.classList.remove("loading");
    } catch {
      img.classList.remove("loading");
      img.classList.add("broken");
      img.alt = "画像を読み込めません: " + safeDecode(ref);
    }
  };
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); loadOne(e.target); } }), { rootMargin: "800px 0px" });
    imgs.forEach(i => io.observe(i));
  } else imgs.forEach(loadOne);
}

// ---------- search ----------
async function showSearch(q, seq) {
  titleEl.textContent = "検索";
  view.innerHTML = `
    <form class="searchbox" id="sf"><input type="search" id="sq" placeholder="ファイル名・本文を検索" value="${esc(q)}" enterkeyhint="search"></form>
    <div id="sr"></div>`;
  const input = $("#sq");
  $("#sf").onsubmit = ev => { ev.preventDefault(); input.blur(); location.hash = "#/s?q=" + encodeURIComponent(input.value.trim()); };
  if (!q) { input.focus(); $("#sr").innerHTML = `<div class="empty">ホームフォルダ（${esc(homePath())}）の中を探します。保存済みの本文はオフラインでも検索できます。</div>`; return; }
  const out = $("#sr");
  out.innerHTML = `<div class="progress">検索中…</div>`;

  const ql = q.toLowerCase();
  const homeL = lower(homePath());
  const local = [];
  await db.each("doc:", (k, rec) => {
    if (homeL !== "/" && !k.slice(4).startsWith(homeL)) return;
    const name = basename(rec.path);
    const i = rec.text.toLowerCase().indexOf(ql);
    if (i < 0 && !name.toLowerCase().includes(ql)) return;
    let snip = "";
    if (i >= 0) {
      const s = Math.max(0, i - 40);
      const raw = rec.text.slice(s, i + q.length + 60).replace(/\s+/g, " ");
      const j = raw.toLowerCase().indexOf(ql);
      snip = (s ? "…" : "") + esc(raw.slice(0, j)) + "<mark>" + esc(raw.slice(j, j + q.length)) + "</mark>" + esc(raw.slice(j + q.length)) + "…";
    }
    local.push({ path: rec.path, snip });
  });
  if (seq !== renderSeq) return;

  const row = r => `<li><a href="#/v${esc(enc(r.path))}"><span class="ico">📝</span><span class="name">${esc(basename(r.path))}<span class="sub">${r.snip || esc(dirname(r.path))}</span></span></a></li>`;
  let html = local.length ? `<div class="section-title">保存済みの本文から（${local.length}件）</div><ul class="list">${local.slice(0, 100).map(row).join("")}</ul>` : "";
  out.innerHTML = html + `<div class="progress">Dropbox を検索中…</div>`;

  try {
    const r = await dbx("rpc", "files/search_v2", {
      query: q,
      options: { path: homePath() === "/" ? "" : homePath(), max_results: 100, file_extensions: ["md", "markdown", "txt"] },
    });
    if (seq !== renderSeq) return;
    const seen = new Set(local.map(l => lower(l.path)));
    const remote = (r.matches || []).map(m => m.metadata && m.metadata.metadata).filter(m => m && m[".tag"] === "file" && !seen.has(lower(m.path_display)));
    html += remote.length ? `<div class="section-title">Dropbox 検索（${remote.length}件）</div><ul class="list">${remote.map(m => row({ path: m.path_display })).join("")}</ul>` : "";
    setOffline(false);
  } catch (e) {
    if (e.auth) throw e;
    setOffline(e instanceof TypeError);
  }
  if (seq !== renderSeq) return;
  out.innerHTML = html || `<div class="empty">見つかりませんでした</div>`;
}

// ---------- offline sync ----------
function extractImageRefs(text) {
  const refs = [];
  text = preprocess(text);
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g)) refs.push(m[1]);
  for (const m of text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) refs.push(m[1]);
  return refs.filter(r => !isExternal(r) && !r.startsWith("//"));
}

let syncing = false;
async function syncHome() {
  if (syncing) return;
  syncing = true;
  const home = homePath();
  const box = document.createElement("div");
  box.className = "toast";
  document.body.appendChild(box);
  const say = s => { box.textContent = s; };
  try {
    say("ファイル一覧を取得中…");
    let r = await dbx("rpc", "files/list_folder", { path: home === "/" ? "" : home, recursive: true, limit: 2000 });
    const all = [...r.entries];
    while (r.has_more) { r = await dbx("rpc", "files/list_folder/continue", { cursor: r.cursor }); all.push(...r.entries); say(`ファイル一覧を取得中… ${all.length}件`); }
    const entries = all.filter(e => e[".tag"] !== "deleted").map(slimEntry);

    // フォルダ一覧をキャッシュ（オフラインでも辿れるように）
    const byDir = new Map([[lower(home), []]]);
    for (const e of entries) if (e.tag === "folder") byDir.set(lower(e.path), []);
    for (const e of entries) { const d = byDir.get(lower(dirname(e.path))); if (d) d.push(e); }
    for (const [k, v] of byDir) await db.put("ls:" + k, { entries: v, at: Date.now() });

    const files = entries.filter(e => e.tag === "file");
    const byPath = new Map(files.map(e => [lower(e.path), e]));
    const nameIdx = {};
    for (const e of files) if (IMG_EXT.test(e.name) || MD_EXT.test(e.name)) nameIdx[lower(e.name)] = nameIdx[lower(e.name)] || e.path;
    store.set("mdv_nameidx", nameIdx);

    const docs = files.filter(e => MD_EXT.test(e.name) || TEXT_EXT.test(e.name));
    const wantImgs = new Map();
    let i = 0, fetched = 0;
    const workers = Array.from({ length: 4 }, async () => {
      while (i < docs.length) {
        const e = docs[i++];
        let rec = await db.get("doc:" + lower(e.path));
        if (!rec || rec.rev !== e.rev) { rec = await fetchDoc(e.path); fetched++; }
        for (const ref of extractImageRefs(rec.text)) {
          let p;
          if (ref.startsWith("mdv-wiki/")) {
            const name = safeDecode(ref.slice(9));
            p = byPath.has(lower(joinPath(dirname(e.path), name))) ? joinPath(dirname(e.path), name) : nameIdx[lower(name)];
          } else p = resolveRel(dirname(e.path), ref);
          const img = p && byPath.get(lower(p));
          if (img) wantImgs.set(lower(img.path), img);
        }
        say(`本文を保存中… ${Math.min(i, docs.length)}/${docs.length}`);
      }
    });
    await Promise.all(workers);

    const imgs = [...wantImgs.values()];
    let j = 0, imgFetched = 0;
    const iw = Array.from({ length: 4 }, async () => {
      while (j < imgs.length) {
        const e = imgs[j++];
        const key = "img:" + lower(e.path);
        const rec = await db.get(key);
        if (!rec || rec.rev !== e.rev) {
          const { blob } = await dbx("content", "files/download", { path: e.path });
          await db.put(key, { blob: fixSvgType(blob, e.path), rev: e.rev, at: Date.now() });
          blobUrls.delete(lower(e.path));
          imgFetched++;
        }
        say(`画像を保存中… ${Math.min(j, imgs.length)}/${imgs.length}`);
      }
    });
    await Promise.all(iw);
    store.set("mdv_lastsync", Date.now());
    say(`保存しました（md ${docs.length}件、画像 ${imgs.length}件。うち今回更新 ${fetched + imgFetched}件）`);
    setTimeout(() => box.remove(), 4000);
  } catch (e) {
    say("保存できませんでした: " + (e instanceof TypeError ? "オフラインです" : e.message));
    setTimeout(() => box.remove(), 5000);
  } finally { syncing = false; }
}

// ---------- chrome ----------
window.addEventListener("hashchange", ev => {
  try { scrollMemo.set(new URL(ev.oldURL).hash, window.scrollY); } catch {}
  navDepth++;
  render();
});
window.addEventListener("online", () => setOffline(false));

$("#btn-back").onclick = () => {
  if (navDepth > 0) { navDepth -= 2; history.back(); return; }
  const r = current;
  if (r.kind === "doc") routeTo("f", dirname(r.path));
  else if (r.kind === "folder") routeTo("f", dirname(r.path));
  else location.hash = "#/";
};
$("#btn-search").onclick = () => { location.hash = "#/s"; };
$("#btn-menu").onclick = () => {
  const m = $("#menu");
  m.querySelector('[data-act="sethome"]').hidden = current.kind !== "folder";
  m.querySelector('[data-act="sync"]').textContent = "ホーム以下をまとめてオフライン保存" + (store.get("mdv_lastsync") ? `（前回 ${fmtDate(store.get("mdv_lastsync"))}）` : "");
  m.querySelector('[data-act="showall"]').textContent = store.get("mdv_showall", false) ? "md・画像・PDFだけ表示する" : "すべてのファイルを表示する";
  m.hidden = !m.hidden;
};
$("#menu").onclick = async ev => {
  const act = ev.target.dataset && ev.target.dataset.act;
  if (!act) return;
  $("#menu").hidden = true;
  if (act === "home") location.hash = "#/";
  else if (act === "sethome") { store.set("mdv_home", current.path); store.del("mdv_nameidx"); toast("ホームにしました: " + current.path); }
  else if (act === "sync") syncHome();
  else if (act === "showall") { store.set("mdv_showall", !store.get("mdv_showall", false)); render(); }
  else if (act === "font-up" || act === "font-down") {
    const f = Math.min(1.6, Math.max(0.8, store.get("mdv_font", 1) + (act === "font-up" ? 0.1 : -0.1)));
    store.set("mdv_font", Math.round(f * 10) / 10); applyFont();
  }
  else if (act === "clear") {
    if (!confirm("この端末に保存した本文と画像を消しますか？（Dropbox 上のファイルは消えません）")) return;
    await db.clear(); blobUrls.clear(); store.del("mdv_nameidx"); store.del("mdv_lastsync"); toast("消しました");
  }
  else if (act === "logout") {
    if (!confirm("ログアウトしますか？")) return;
    try { await dbx("rpc", "auth/token/revoke"); } catch {}
    ["mdv_token", "mdv_pathroot", "mdv_account", "mdv_home", "mdv_recent", "mdv_nameidx", "mdv_lastsync"].forEach(store.del);
    await db.clear(); blobUrls.clear();
    location.hash = "#/"; render();
  }
};

// ---------- boot ----------
async function boot() {
  applyFont();
  const q = new URLSearchParams(location.search);
  if (q.get("code") || q.get("error")) {
    const pk = store.get("mdv_pkce");
    const clean = () => history.replaceState(null, "", location.pathname + "#/");
    if (q.get("error")) { clean(); toast("ログインがキャンセルされました"); }
    else if (!pk || pk.state !== q.get("state")) { clean(); toast("ログイン情報が一致しません。もう一度お試しください"); }
    else {
      view.innerHTML = `<div class="progress">ログイン中…</div>`;
      try { await finishLogin(q.get("code"), false); }
      catch (e) { toast("ログインできませんでした: " + e.message, 4000); }
      clean();
    }
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  render();
}
boot();
})();
