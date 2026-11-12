// hanzxs Monitor v3: backend + dashboard + sistem key (Cloudflare Worker)
//
// Alur:
//   script Roblox --POST /api/report (X-Monitor-Key + X-HWID)--> Worker
//   dashboard web  <-- login Discord --> Worker (developer mode untuk Discord yang di-whitelist)
//
// Sebelum deploy (Settings > Variables and Secrets di Cloudflare):
//   DISCORD_CLIENT_ID      Client ID aplikasi Discord kamu
//   DISCORD_CLIENT_SECRET  Client Secret aplikasi Discord (simpan sebagai Secret)
//   SESSION_SECRET         teks acak minimal 32 karakter (Secret)
//   OWNER_IDS              Discord ID kamu, pisahkan dengan koma kalau lebih dari satu
// Dan pasang KV namespace dengan nama binding persis: MONITOR
//
// Di Discord Developer Portal > OAuth2 > Redirects, tambahkan:
//   https://ALAMAT-WORKER-KAMU/auth/callback

const OFFLINE_AFTER_SEC = 120;             // tidak ada laporan selama ini = Offline
const SAVE_EVERY_SEC = 180;                // jarak simpan akun ke KV (paket gratis: 1.000 tulis per hari)
const HISTORY_POINTS = 40;                 // titik riwayat untuk hitung laju (40 x 3 menit = 2 jam)
const KV_TTL_SEC = 7 * 24 * 3600;          // akun dihapus otomatis kalau 7 hari tidak melapor
const SESSION_TTL_SEC = 7 * 24 * 3600;     // login Discord berlaku 7 hari
const MAX_BODY = 20000;
const MAX_KEYS_PER_BATCH = 20;
const MAX_DURATION_DAYS = 3650;

const KV_PREFIX = "acc:";
const KV_INDEX = "index";
const KEY_PREFIX = "key:";
const DEV_PREFIX = "dev:";

const KEY_RE = /^HAN[A-Z0-9]{12}$/;        // HAN + 12 huruf/angka
const KEY_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const DISCORD_ID_RE = /^\d{15,25}$/;

// cache di memori Worker
const hot = new Map();
const knownIds = new Set();
let kvCache = { at: 0, rows: [] };
const keyCache = new Map();                // key -> { at, rec }
const devCache = new Map();                // discordId -> { at, ok }
const recentKeys = new Map();              // tulisan terbaru (KV list bisa telat): key -> { at, rec|null }
const recentDevs = new Map();
const KEY_CACHE_MS = 15000;
const DEV_CACHE_MS = 60000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/" && method === "GET") return page();
      if (path === "/api/report" && method === "POST") return await handleReport(request, env, ctx);
      if (path === "/auth/login" && method === "GET") return authLogin(env, url);
      if (path === "/auth/callback" && method === "GET") return await authCallback(request, env, url);
      if (path === "/auth/logout" && method === "POST") return authLogout(request, url);
      if (path === "/api/me" && method === "GET") return await apiMe(request, env);
      if (path.startsWith("/api/")) return await handleDevApi(request, env, url, path, method);
      return json({ error: "Tidak ditemukan" }, 404);
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500);
    }
  },
};

// ---------- helper umum ----------

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      headers || {}
    ),
  });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function num(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function str(v, max) {
  return typeof v === "string" ? v.slice(0, max || 60) : null;
}

function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function numberMap(obj, maxKeys) {
  const out = {};
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj).slice(0, maxKeys)) {
      const n = num(v);
      if (n !== null) out[String(k).slice(0, 30)] = n;
    }
  }
  return out;
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 4000) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch (e) {
    return null;
  }
}

function mergeRecent(rows, recent, field) {
  const nowMs = Date.now();
  const map = new Map(rows.map((r) => [r[field], r]));
  for (const [id, entry] of recent) {
    if (nowMs - entry.at > 120000) {
      recent.delete(id);
      continue;
    }
    if (entry.rec) map.set(id, entry.rec);
    else map.delete(id);
  }
  return Array.from(map.values());
}

// ---------- pembuat key: HAN + 12 huruf/angka acak ----------

function randomChars(n) {
  const limit = 256 - (256 % KEY_CHARS.length); // buang byte berlebih supaya tiap karakter adil
  let out = "";
  while (out.length < n) {
    const buf = new Uint8Array(n * 2);
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      if (buf[i] < limit) out += KEY_CHARS[buf[i] % KEY_CHARS.length];
    }
  }
  return out;
}

function generateKey() {
  return "HAN" + randomChars(12);
}

function toSeconds(amount, unit) {
  const n = Number(amount);
  const mult = unit === "hour" ? 3600 : unit === "day" ? 86400 : 0;
  if (!isFinite(n) || n <= 0 || !mult) return null;
  const sec = Math.floor(n * mult);
  if (sec < 3600 || sec > MAX_DURATION_DAYS * 86400) return null;
  return sec;
}

// ---------- penyimpanan key ----------
//
// Record key:
//   permanent   true = tanpa batas waktu
//   durationSec durasi yang menunggu (mulai dihitung saat key pertama kali dipakai)
//   activatedAt waktu pertama dipakai (null = belum pernah)
//   expiresAt   waktu habis (null kalau permanen / belum dipakai)
//   hwid        SHA-256 dari HWID perangkat (null = belum terikat)
//   revoked     true = dicabut

function cleanRecord(r) {
  return {
    key: r.key,
    note: str(r.note, 40) || "",
    createdAt: num(r.createdAt),
    createdBy: str(r.createdBy, 24),
    permanent: r.permanent === true,
    durationSec: r.permanent === true ? 0 : num(r.durationSec) || 0,
    activatedAt: num(r.activatedAt),
    expiresAt: r.permanent === true ? null : num(r.expiresAt),
    hwid: str(r.hwid, 64),
    boundName: str(r.boundName, 30),
    revoked: r.revoked === true,
  };
}

async function getKeyRecord(env, key) {
  const nowMs = Date.now();
  const cached = keyCache.get(key);
  if (cached && nowMs - cached.at < KEY_CACHE_MS) return cached.rec;

  const rec = (await env.MONITOR.get(KEY_PREFIX + key, "json")) || null;
  if (keyCache.size >= 500) keyCache.clear();
  keyCache.set(key, { at: nowMs, rec });
  return rec;
}

async function putKeyRecord(env, rec) {
  const clean = cleanRecord(rec);
  const meta = Object.assign({}, clean);
  delete meta.key;
  await env.MONITOR.put(KEY_PREFIX + clean.key, JSON.stringify(clean), { metadata: meta });
  keyCache.set(clean.key, { at: Date.now(), rec: clean });
  recentKeys.set(clean.key, { at: Date.now(), rec: clean });
  return clean;
}

async function deleteKeyRecord(env, key) {
  await env.MONITOR.delete(KEY_PREFIX + key);
  keyCache.set(key, { at: Date.now(), rec: null });
  recentKeys.set(key, { at: Date.now(), rec: null });
}

async function listKeyRecords(env) {
  const rows = [];
  let cursor;
  do {
    const res = await env.MONITOR.list({ prefix: KEY_PREFIX, limit: 1000, cursor });
    for (const k of res.keys) {
      if (k.metadata) rows.push(Object.assign({ key: k.name.slice(KEY_PREFIX.length) }, k.metadata));
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor && rows.length < 2000);
  return mergeRecent(rows, recentKeys, "key");
}

// Cek key + HWID. Pertama kali dipakai: HWID terkunci dan durasi mulai dihitung.
async function checkKey(env, key, hwid, accountName, now) {
  const rec = await getKeyRecord(env, key);
  if (!rec) return { error: json({ error: "Key tidak ditemukan", code: "invalid_key" }, 401) };
  if (rec.revoked) return { error: json({ error: "Key sudah dicabut", code: "revoked" }, 403) };

  if (rec.hwid && !safeEqual(rec.hwid, hwid)) {
    return { error: json({ error: "Key terkunci di perangkat lain (HWID tidak cocok)", code: "hwid_mismatch" }, 403) };
  }
  if (rec.activatedAt && !rec.permanent && now >= (rec.expiresAt || 0)) {
    return { error: json({ error: "Key sudah habis masa aktifnya", code: "expired" }, 403) };
  }

  if (!rec.hwid || !rec.activatedAt) {
    const next = Object.assign({}, rec);
    if (!next.hwid) {
      next.hwid = hwid;
      next.boundName = accountName;
    }
    if (!next.activatedAt) {
      next.activatedAt = now;
      next.expiresAt = next.permanent ? null : now + next.durationSec;
    }
    return { rec: await putKeyRecord(env, next) };
  }
  return { rec };
}

// ---------- login Discord (OAuth2) + sesi ----------

function authConfigured(env) {
  return !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.SESSION_SECRET && String(env.SESSION_SECRET).length >= 16);
}

function ownerIds(env) {
  return new Set(String(env.OWNER_IDS || "").split(/[\s,]+/).filter((x) => DISCORD_ID_RE.test(x)));
}

function b64uEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(text) {
  let s = text.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signToken(payload, secret) {
  const body = b64uEncode(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return body + "." + b64uEncode(sig);
}

async function verifyToken(token, secret) {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64uDecode(token.slice(dot + 1)), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64uDecode(body)));
    if (!payload || typeof payload.exp !== "number" || payload.exp < nowSec()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(name, value, maxAge) {
  return name + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
}

function redirect(location, cookies) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies || []) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

async function getUser(request, env) {
  if (!authConfigured(env)) return null;
  return await verifyToken(parseCookies(request).hz_session, env.SESSION_SECRET);
}

async function isDev(env, id) {
  if (ownerIds(env).has(id)) return true;
  if (!env.MONITOR) return false;
  const cached = devCache.get(id);
  if (cached && Date.now() - cached.at < DEV_CACHE_MS) return cached.ok;
  const ok = (await env.MONITOR.get(DEV_PREFIX + id)) !== null;
  devCache.set(id, { at: Date.now(), ok });
  return ok;
}

function authLogin(env, url) {
  if (!authConfigured(env)) return redirect("/");
  const state = randomHex(16);
  const target =
    "https://discord.com/oauth2/authorize?" +
    new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      redirect_uri: url.origin + "/auth/callback",
      response_type: "code",
      scope: "identify",
      state,
    });
  return redirect(target, [cookie("hz_state", state, 600)]);
}

async function authCallback(request, env, url) {
  const clearState = cookie("hz_state", "", 0);
  if (!authConfigured(env)) return redirect("/");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return redirect("/?e=denied", [clearState]);
  if (!code || !state || !safeEqual(state, parseCookies(request).hz_state || "")) {
    return redirect("/?e=state", [clearState]);
  }

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: url.origin + "/auth/callback",
    }),
  });
  if (!tokenRes.ok) return redirect("/?e=token", [clearState]);
  const token = await tokenRes.json();

  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: "Bearer " + token.access_token },
  });
  if (!userRes.ok) return redirect("/?e=user", [clearState]);
  const u = await userRes.json();
  if (!u || !DISCORD_ID_RE.test(String(u.id))) return redirect("/?e=user", [clearState]);

  const session = await signToken(
    {
      id: String(u.id),
      u: String(u.global_name || u.username || "").slice(0, 40),
      a: typeof u.avatar === "string" ? u.avatar.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) : null,
      exp: nowSec() + SESSION_TTL_SEC,
    },
    env.SESSION_SECRET
  );
  return redirect("/", [cookie("hz_session", session, SESSION_TTL_SEC), clearState]);
}

function authLogout(request, url) {
  if (request.headers.get("Origin") !== url.origin) return json({ error: "Origin tidak valid" }, 403);
  return json({ ok: true }, 200, { "set-cookie": cookie("hz_session", "", 0) });
}

async function apiMe(request, env) {
  const base = { configured: authConfigured(env), kvBound: !!env.MONITOR };
  if (!base.configured) return json(base);

  const user = await getUser(request, env);
  if (!user) return json(Object.assign(base, { loggedIn: false }));

  const owner = ownerIds(env).has(user.id);
  const dev = owner || (await isDev(env, user.id));
  return json(
    Object.assign(base, {
      loggedIn: true,
      isDev: dev,
      isOwner: owner,
      user: {
        id: user.id,
        name: user.u,
        avatar: user.a ? "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.a + ".png?size=64" : null,
      },
    })
  );
}

// ---------- API khusus developer mode ----------

async function requireDev(request, env, url) {
  if (!authConfigured(env)) return { response: json({ error: "Login Discord belum dikonfigurasi", code: "not_configured" }, 503) };
  if (!env.MONITOR) return { response: json({ error: "KV MONITOR belum dipasang", code: "no_kv" }, 503) };

  const user = await getUser(request, env);
  if (!user) return { response: json({ error: "Belum login", code: "login" }, 401) };

  const owner = ownerIds(env).has(user.id);
  if (!owner && !(await isDev(env, user.id))) {
    return { response: json({ error: "Akun Discord ini belum di-whitelist", code: "not_dev" }, 403) };
  }
  if (request.method !== "GET" && request.headers.get("Origin") !== url.origin) {
    return { response: json({ error: "Origin tidak valid" }, 403) };
  }
  return { user, owner };
}

async function handleDevApi(request, env, url, path, method) {
  const auth = await requireDev(request, env, url);
  if (auth.response) return auth.response;

  if (path === "/api/status" && method === "GET") return await apiStatus(env);
  if (path === "/api/keys" && method === "GET") return await apiListKeys(env);
  if (path === "/api/devs" && method === "GET") return await apiListDevs(env);

  if (method !== "POST") return json({ error: "Tidak ditemukan" }, 404);
  const body = await readJson(request);
  if (!body) return json({ error: "Isi permintaan tidak valid" }, 400);

  if (path === "/api/keys") return await apiCreateKeys(env, auth.user, body);

  if (path === "/api/keys/extend" || path === "/api/keys/reset-hwid" || path === "/api/keys/revoke" || path === "/api/keys/delete") {
    const key = String(body.key || "");
    if (!KEY_RE.test(key)) return json({ error: "Format key salah" }, 400);
    const rec = (await env.MONITOR.get(KEY_PREFIX + key, "json")) || null;
    if (!rec) return json({ error: "Key tidak ditemukan" }, 404);

    if (path === "/api/keys/delete") {
      await deleteKeyRecord(env, key);
      return json({ ok: true, deleted: key });
    }
    if (path === "/api/keys/reset-hwid") {
      return json({ ok: true, key: await putKeyRecord(env, Object.assign({}, rec, { hwid: null, boundName: null })) });
    }
    if (path === "/api/keys/revoke") {
      return json({ ok: true, key: await putKeyRecord(env, Object.assign({}, rec, { revoked: body.revoked !== false })) });
    }
    return json(await extendKey(env, rec, body));
  }

  if (path === "/api/devs" || path === "/api/devs/remove") {
    if (!auth.owner) return json({ error: "Hanya owner yang bisa mengatur whitelist" }, 403);
    const id = String(body.id || "").trim();
    if (!DISCORD_ID_RE.test(id)) return json({ error: "Discord ID harus berupa angka 15-25 digit" }, 400);

    if (path === "/api/devs/remove") {
      await env.MONITOR.delete(DEV_PREFIX + id);
      devCache.set(id, { at: Date.now(), ok: false });
      recentDevs.set(id, { at: Date.now(), rec: null });
      return json({ ok: true });
    }
    const rec = { id, name: str(body.name, 30) || "", at: nowSec() };
    await env.MONITOR.put(DEV_PREFIX + id, "1", { metadata: { name: rec.name, at: rec.at } });
    devCache.set(id, { at: Date.now(), ok: true });
    recentDevs.set(id, { at: Date.now(), rec });
    return json({ ok: true, dev: rec });
  }

  return json({ error: "Tidak ditemukan" }, 404);
}

async function apiCreateKeys(env, user, body) {
  const count = clampInt(body.count, 1, MAX_KEYS_PER_BATCH, 1);
  const permanent = body.permanent === true;
  let sec = 0;
  if (!permanent) {
    sec = toSeconds(body.amount, body.unit);
    if (sec === null) return json({ error: "Durasi tidak valid (minimal 1 jam, maksimal " + MAX_DURATION_DAYS + " hari)" }, 400);
  }
  const note = str(body.note, 40) || "";
  const now = nowSec();

  const made = await Promise.all(
    Array.from({ length: count }, () =>
      putKeyRecord(env, { key: generateKey(), note, createdAt: now, createdBy: user.id, permanent, durationSec: sec })
    )
  );
  return json({ ok: true, keys: made });
}

async function extendKey(env, rec, body) {
  const next = Object.assign({}, rec);
  const now = nowSec();

  if (body.permanent === true) {
    next.permanent = true;
    next.expiresAt = null;
    next.durationSec = 0;
    return { ok: true, key: await putKeyRecord(env, next) };
  }

  const sec = toSeconds(body.amount, body.unit);
  if (sec === null) return { error: "Durasi tidak valid (minimal 1 jam)" };
  if (next.permanent) return { error: "Key ini sudah permanen" };

  if (!next.activatedAt) next.durationSec = (next.durationSec || 0) + sec;
  else next.expiresAt = Math.max(next.expiresAt || 0, now) + sec; // sudah habis? hitung dari sekarang
  return { ok: true, key: await putKeyRecord(env, next) };
}

async function apiListKeys(env) {
  const rows = await listKeyRecords(env);
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json({ now: nowSec(), keys: rows });
}

async function apiListDevs(env) {
  const res = await env.MONITOR.list({ prefix: DEV_PREFIX, limit: 200 });
  const rows = res.keys.map((k) => ({
    id: k.name.slice(DEV_PREFIX.length),
    name: (k.metadata && k.metadata.name) || "",
    at: (k.metadata && k.metadata.at) || null,
  }));
  return json({ devs: mergeRecent(rows, recentDevs, "id") });
}

// ---------- POST /api/report (dari script Roblox) ----------

// hanya field yang dikenal yang disimpan, dengan tipe yang sudah dipastikan
function sanitize(d) {
  return {
    name: str(d.name),
    displayName: str(d.displayName),
    userId: num(d.userId),
    placeId: num(d.placeId),
    jobId: str(d.jobId, 64),
    players: num(d.players),
    ping: num(d.ping),
    fps: num(d.fps),
    uptime: num(d.uptime),
    afk: d.afk === true,
    idle: num(d.idle),
    stats: numberMap(d.stats, 40),
    pets: numberMap(d.pets, 12),
  };
}

async function handleReport(request, env, ctx) {
  if (!env.MONITOR) return json({ error: "KV MONITOR belum dipasang di Worker", code: "no_kv" }, 503);

  const key = (request.headers.get("X-Monitor-Key") || "").trim();
  if (!KEY_RE.test(key)) return json({ error: "Format key salah (harus HAN + 12 huruf/angka)", code: "invalid_key" }, 401);

  const hwidRaw = (request.headers.get("X-HWID") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
  if (hwidRaw.length < 8) return json({ error: "HWID tidak terbaca dari executor", code: "no_hwid" }, 400);

  if (Number(request.headers.get("content-length") || 0) > MAX_BODY) return json({ error: "Laporan terlalu besar" }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: "Laporan terlalu besar" }, 413);

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return json({ error: "JSON tidak valid" }, 400);
  }
  if (!data || typeof data !== "object") return json({ error: "JSON tidak valid" }, 400);

  const now = nowSec();
  const checked = await checkKey(env, key, await sha256Hex(hwidRaw), str(data.name, 30), now);
  if (checked.error) return checked.error;
  const keyRec = checked.rec;

  const id = String(data.userId != null ? data.userId : data.name || "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 40);
  if (!id) return json({ error: "userId kosong" }, 400);

  let prev = hot.get(id) || null;
  if (!prev) prev = await env.MONITOR.get(KV_PREFIX + id, "json");

  const lastWrite = (prev && prev.kvWrittenAt) || 0;
  const writeNow = now - lastWrite >= SAVE_EVERY_SEC;

  const record = Object.assign({ id, receivedAt: now }, sanitize(data), {
    keyTail: key.slice(-4),
    keyPerm: keyRec.permanent === true,
    keyExp: keyRec.permanent ? null : keyRec.expiresAt,
  });

  const history = prev && Array.isArray(prev.history) ? prev.history.slice() : [];
  const lastPoint = history.length ? history[history.length - 1].t : 0;
  if (now - lastPoint >= SAVE_EVERY_SEC) {
    history.push({
      t: now,
      c: typeof record.stats.Clicks === "number" ? record.stats.Clicks : null,
      r: typeof record.stats.Rebirths === "number" ? record.stats.Rebirths : null,
    });
  }
  record.history = history.slice(-HISTORY_POINTS);
  record.kvWrittenAt = writeNow ? now : lastWrite;

  if (hot.size >= 100) hot.clear();
  hot.set(id, record);

  if (writeNow) ctx.waitUntil(saveRecord(env, record).catch(function () {}));

  return json({
    ok: true,
    stored: writeNow,
    now,
    permanent: keyRec.permanent === true,
    expiresAt: keyRec.permanent ? null : keyRec.expiresAt,
  });
}

async function saveRecord(env, record) {
  await env.MONITOR.put(KV_PREFIX + record.id, JSON.stringify(record), { expirationTtl: KV_TTL_SEC });

  if (!knownIds.has(record.id)) {
    const ids = (await env.MONITOR.get(KV_INDEX, "json")) || [];
    if (!ids.includes(record.id)) {
      ids.push(record.id);
      await env.MONITOR.put(KV_INDEX, JSON.stringify(ids.slice(-50)));
    }
    knownIds.add(record.id);
  }
}

// ---------- GET /api/status ----------

async function loadFromKV(env) {
  const nowMs = Date.now();
  if (nowMs - kvCache.at < 15000) return kvCache.rows;

  const ids = (await env.MONITOR.get(KV_INDEX, "json")) || [];
  const rows = (await Promise.all(ids.map((id) => env.MONITOR.get(KV_PREFIX + id, "json")))).filter(Boolean);
  kvCache = { at: nowMs, rows };
  return rows;
}

async function apiStatus(env) {
  const map = new Map();
  for (const row of await loadFromKV(env)) {
    if (row && row.id) map.set(row.id, row);
  }
  for (const row of hot.values()) {
    const current = map.get(row.id);
    if (!current || row.receivedAt >= current.receivedAt) map.set(row.id, row);
  }
  return json({
    now: nowSec(),
    offlineAfter: OFFLINE_AFTER_SEC,
    accounts: Array.from(map.values()),
  });
}

// ---------- dashboard ----------

function page() {
  return new Response(PAGE, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https://cdn.discordapp.com; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

const PAGE = String.raw`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pantauan akun</title>
<link rel="icon" href="data:,">
<style>
:root{
  --paper:#edf0f5;--sheet:#fafbfd;--ink:#172033;--muted:#5c6780;--line:#d5dae5;
  --live:#0e9f8e;--down:#d4493c;--afk:#5b5bd6;--gold:#d99a14;--mut:#9b5de5;--normal:#8b97b4;
}
@media (prefers-color-scheme:dark){
  :root{
    --paper:#0f1320;--sheet:#171c2e;--ink:#e8ecf6;--muted:#93a0bc;--line:#2a3250;
    --live:#34d3bf;--down:#ff7a6b;--afk:#9a9aff;--gold:#f0b429;--mut:#b98cf0;--normal:#6f7fa6;
  }
}
*{box-sizing:border-box}
html{color-scheme:light dark}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
.wrap{max-width:640px;margin:0 auto;padding:20px 16px 56px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}
h1{margin:0;font-size:20px;line-height:1.2;font-weight:650}
h2{margin:0 0 12px;font-size:17px;font-weight:650}
.meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}
.stamp{color:var(--muted);font-size:13px}
.stamp.bad{color:var(--down)}
.user{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.user img{width:24px;height:24px;border-radius:50%}
.linkbtn{background:none;border:0;padding:4px 0;color:var(--muted);font:inherit;font-size:13px;text-decoration:underline;cursor:pointer}
button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--afk);outline-offset:2px}
[hidden]{display:none!important}

.tabs{display:flex;gap:4px;margin-bottom:16px;padding:4px;background:var(--sheet);border:1px solid var(--line);border-radius:12px}
.tabs button{flex:1;height:40px;border:0;border-radius:9px;background:none;color:var(--muted);font:inherit;font-weight:600;cursor:pointer}
.tabs button[aria-selected="true"]{background:var(--ink);color:var(--paper)}

.sheet{background:var(--sheet);border:1px solid var(--line);border-radius:18px;padding:18px;margin-bottom:16px}
.state{display:flex;justify-content:space-between;align-items:flex-end;gap:12px}
.word{font:600 34px/1 ui-serif,Georgia,"Times New Roman",serif;letter-spacing:-.01em}
.on .word{color:var(--live)}
.off .word{color:var(--down)}
.since{color:var(--muted);font-size:13px;text-align:right}

.pulse{display:block;width:100%;height:56px;margin:10px 0 14px;overflow:visible}
.pulse .ecg{fill:none;stroke-linecap:round;stroke-linejoin:round}
.pulse .base{stroke:var(--line);stroke-width:2}
.pulse .beat{stroke:var(--live);stroke-width:2.6;stroke-dasharray:70 330;animation:sweep 2.6s linear infinite}
.pulse .flat{stroke:var(--down);stroke-width:2;stroke-dasharray:3 7;stroke-linecap:round}
.on .flat{display:none}
.off .ecg{display:none}
@keyframes sweep{from{stroke-dashoffset:400}to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.pulse .beat{animation:none;stroke-dasharray:none}}

.who{font-size:17px}
.who .handle{color:var(--muted);margin-left:8px;font-size:14px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 14px}
.chip{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:13px;color:var(--muted)}
.chip.afk{border-color:var(--afk);color:var(--afk)}
.chip.ok{border-color:var(--live);color:var(--live)}
.chip.bad{border-color:var(--down);color:var(--down)}
.chip.warn{border-color:var(--gold);color:var(--gold)}

.row{display:flex;align-items:baseline;gap:8px;margin:8px 0}
.row .k{color:var(--muted);font-size:15px}
.row .dots{flex:1;border-bottom:2px dotted var(--line);transform:translateY(-4px)}
.row .v{font:600 30px/1.1 ui-serif,Georgia,"Times New Roman",serif;font-variant-numeric:tabular-nums lining-nums}

.bar{display:flex;gap:2px;height:10px;margin:14px 0 8px}
.seg{min-width:4px;border-radius:3px}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:13px;color:var(--muted)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}
.t-normal{background:var(--normal)}
.t-golden{background:var(--gold)}
.t-rainbow{background:linear-gradient(90deg,#e5484d,#f5a524,#46a758,#3e63dd,#8e4ec6)}
.t-mutated{background:var(--mut)}
.t-other{background:var(--muted)}

.trend{margin-top:12px;font-size:13px;color:var(--muted)}
.facts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.fact b{display:block;font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.fact span{font-size:12px;color:var(--muted)}
.more{margin-top:12px}
.more summary{cursor:pointer;font-size:13px;color:var(--muted)}
.more .v{font-size:16px}
.more .row{margin:4px 0}

.note{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:16px;font-size:13px;color:var(--muted)}
.empty{padding:28px 6px;color:var(--muted)}
.empty strong{display:block;color:var(--ink);font-size:17px;margin-bottom:4px}
.err{color:var(--down);font-size:14px;margin:8px 0 0}
.hint{color:var(--muted);font-size:13px;margin:6px 0 0}

/* gerbang login */
.gate p{margin:0 0 12px;color:var(--muted)}
.gate code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.gate ul{margin:0 0 12px;padding-left:20px;color:var(--muted);font-size:14px}
.idbox{display:flex;gap:8px;align-items:center;margin:0 0 12px}
.idbox code{flex:1;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--paper);font-size:15px;overflow-wrap:anywhere}

/* tombol & form */
.btn{display:inline-flex;align-items:center;justify-content:center;height:44px;padding:0 20px;border:0;border-radius:10px;background:var(--ink);color:var(--paper);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn.discord{background:#5865f2;color:#fff}
.btn.small{height:36px;padding:0 12px;font-size:14px}
.btn.ghost{background:none;border:1px solid var(--line);color:var(--ink)}
.btn.danger{background:none;border:1px solid var(--down);color:var(--down)}
.btn:disabled{opacity:.45;cursor:default}
.field{display:flex;flex-direction:column;gap:4px;min-width:0}
.field label{font-size:13px;color:var(--muted)}
input[type=text],input[type=number],select{width:100%;height:44px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);font:inherit}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.check{display:flex;align-items:center;gap:8px;margin:2px 0 12px;font-size:15px}
.check input{width:18px;height:18px}

/* developer mode */
.made{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.keyline{display:flex;align-items:center;gap:8px;margin:6px 0}
.keyline .mono{flex:1;font-size:16px;font-weight:600;letter-spacing:.02em;overflow-wrap:anywhere}
.kcard{border:1px solid var(--line);border-radius:14px;padding:14px;margin-top:10px;background:var(--paper)}
.ktop{display:flex;justify-content:space-between;align-items:center;gap:8px}
.ktop .mono{font-size:16px;font-weight:650;letter-spacing:.02em;background:none;border:0;padding:0;color:var(--ink);cursor:pointer;text-align:left}
.kinfo{margin:8px 0 0;font-size:13px;color:var(--muted)}
.kinfo b{color:var(--ink);font-weight:600}
.kact{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.kext{margin-top:10px;padding-top:10px;border-top:1px dashed var(--line)}
.kext .grid2{margin-bottom:8px}
.search{margin:0 0 4px}
.devrow{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--line);font-size:14px}
.devrow:first-of-type{border-top:0}
.devrow .mono{font-size:13px;color:var(--muted)}

.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:90vw;padding:10px 16px;border-radius:10px;background:var(--ink);color:var(--paper);font-size:14px;z-index:10}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Pantauan akun</h1>
    <div class="meta">
      <span class="stamp" id="stamp"></span>
      <span class="user" id="userbox" hidden></span>
    </div>
  </header>
  <div class="tabs" id="tabs" role="tablist" hidden>
    <button type="button" role="tab" id="tab-mon" aria-selected="true">Pantauan</button>
    <button type="button" role="tab" id="tab-dev" aria-selected="false">Developer</button>
  </div>
  <main id="root"></main>
</div>
<div class="toast" id="toast" hidden></div>
<script>
(function () {
  var POLL_MS = 10000;
  var SUFFIX = ["", "K", "M", "B", "T", "QD", "QN", "SX", "SP", "O", "N", "D", "UD", "DD"];
  var TIER_ORDER = ["Normal", "Golden", "Rainbow", "Mutated"];
  var ERRORS = {
    denied: "Login Discord dibatalkan.",
    state: "Sesi login kedaluwarsa. Coba masuk lagi.",
    token: "Discord menolak login. Cek Client ID, Client Secret, dan Redirect URL.",
    user: "Gagal membaca akun Discord. Coba masuk lagi."
  };

  var root = document.getElementById("root");
  var stamp = document.getElementById("stamp");
  var userbox = document.getElementById("userbox");
  var tabs = document.getElementById("tabs");
  var tabMon = document.getElementById("tab-mon");
  var tabDev = document.getElementById("tab-dev");
  var toastEl = document.getElementById("toast");

  var me = null;
  var paneMon = null;
  var paneDev = null;
  var view = "monitor";
  var pollTimer = null;
  var tickTimer = null;

  var shown = {};
  var openMore = {};
  var lastOkAt = 0;
  var failed = false;
  var serverNow = 0;
  var fetchedAt = 0;

  var keys = [];
  var keysNow = 0;
  var keysFetchedAt = 0;
  var keyFilter = "";
  var openExtend = {};
  var devs = [];
  var devPane = {};

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function svg(tag, attrs) {
    var n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function btn(label, cls, onClick) {
    var b = el("button", "btn " + (cls || ""), label);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  function field(label, input, id) {
    var f = el("div", "field");
    var l = el("label", "", label);
    if (id) { l.setAttribute("for", id); input.id = id; }
    f.appendChild(l);
    f.appendChild(input);
    return f;
  }

  function numInput(value, min, max) {
    var i = el("input");
    i.type = "number";
    i.min = String(min);
    i.max = String(max);
    i.value = String(value);
    i.setAttribute("inputmode", "numeric");
    return i;
  }

  function unitSelect() {
    var s = el("select");
    var d = el("option", "", "hari"); d.value = "day";
    var h = el("option", "", "jam"); h.value = "hour";
    s.appendChild(d);
    s.appendChild(h);
    return s;
  }

  function fmt(v) {
    if (typeof v !== "number" || !isFinite(v)) return "-";
    var i = 0;
    while (Math.abs(v) >= 1000 && i < SUFFIX.length - 1) { v = v / 1000; i++; }
    return String(Math.round(v * 100) / 100) + SUFFIX[i];
  }

  function dur(sec) {
    sec = Math.max(0, Math.floor(sec));
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + " hr " + h + " j";
    if (h > 0) return h + " j " + m + " mnt";
    if (m > 0) return m + " mnt";
    return sec + " dtk";
  }

  function estNow() { return serverNow + (Date.now() - fetchedAt) / 1000; }
  function keyClock() { return keysFetchedAt ? keysNow + (Date.now() - keysFetchedAt) / 1000 : Date.now() / 1000; }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { toastEl.hidden = true; }, 2600);
  }

  function copy(text, label) {
    function done() { toast((label || "Teks") + " disalin"); }
    function fallback() {
      var t = document.createElement("textarea");
      t.value = text;
      t.style.position = "fixed";
      t.style.opacity = "0";
      document.body.appendChild(t);
      t.select();
      try { document.execCommand("copy"); done(); } catch (e) { toast("Gagal menyalin"); }
      document.body.removeChild(t);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else { fallback(); }
  }

  function api(method, path, body) {
    var opt = { method: method, cache: "no-store", headers: {} };
    if (body !== undefined) {
      opt.headers["content-type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    return fetch(path, opt).then(function (res) {
      return res.json().then(
        function (b) { return { status: res.status, body: b }; },
        function () { return { status: res.status, body: {} }; }
      );
    });
  }

  // ---------- gerbang: setup / login / belum di-whitelist ----------

  function gate(title) {
    root.textContent = "";
    var box = el("section", "sheet gate");
    box.appendChild(el("h2", "", title));
    root.appendChild(box);
    return box;
  }

  function showSetup() {
    var box = gate("Login Discord belum disiapkan");
    box.appendChild(el("p", "", "Isi variabel ini di Cloudflare (Settings > Variables and Secrets), lalu deploy ulang:"));
    var ul = el("ul");
    ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "SESSION_SECRET (teks acak 32+ karakter)", "OWNER_IDS (Discord ID kamu)"].forEach(function (t) {
      ul.appendChild(el("li", "", t));
    });
    box.appendChild(ul);
    box.appendChild(el("p", "", "Di Discord Developer Portal > OAuth2 > Redirects, tambahkan: " + location.origin + "/auth/callback"));
  }

  function showLogin(message) {
    var box = gate("Masuk dulu");
    box.appendChild(el("p", "", "Halaman ini hanya bisa dibuka lewat akun Discord yang sudah di-whitelist."));
    var a = el("a", "btn discord", "Masuk dengan Discord");
    a.href = "/auth/login";
    box.appendChild(a);
    if (message) box.appendChild(el("p", "err", message));
  }

  function showNotDev() {
    var box = gate("Akun ini belum di-whitelist");
    box.appendChild(el("p", "", "Kirim Discord ID ini ke owner, atau taruh di OWNER_IDS pada Worker kalau kamu pemiliknya."));
    var idbox = el("div", "idbox");
    idbox.appendChild(el("code", "", me.user.id));
    idbox.appendChild(btn("Salin", "small ghost", function () { copy(me.user.id, "Discord ID"); }));
    box.appendChild(idbox);
  }

  // ---------- pantauan akun ----------

  function tierClass(k) {
    var l = String(k).toLowerCase();
    if (l === "normal" || l === "golden" || l === "rainbow" || l === "mutated") return "t-" + l;
    return "t-other";
  }

  function pulse() {
    var w = svg("svg", { "class": "pulse", viewBox: "0 0 320 56", preserveAspectRatio: "none", "aria-hidden": "true" });
    var d = "M0 34 H60 L68 30 L76 34 H112 L120 38 L130 6 L140 50 L148 34 H176 L186 28 L198 34 H320";
    w.appendChild(svg("path", { "class": "ecg base", d: d, pathLength: "400" }));
    w.appendChild(svg("path", { "class": "ecg beat", d: d, pathLength: "400" }));
    w.appendChild(svg("line", { "class": "flat", x1: "0", y1: "34", x2: "320", y2: "34" }));
    return w;
  }

  function row(label, value) {
    var r = el("div", "row");
    r.appendChild(el("span", "k", label));
    r.appendChild(el("span", "dots"));
    r.appendChild(el("span", "v", value));
    return r;
  }

  function fact(label, value) {
    var f = el("div", "fact");
    f.appendChild(el("b", "", value));
    f.appendChild(el("span", "", label));
    return f;
  }

  function petsBar(pets) {
    var ks = Object.keys(pets).filter(function (k) { return k !== "Total" && pets[k] > 0; });
    if (!ks.length) return null;
    ks.sort(function (x, y) {
      var ix = TIER_ORDER.indexOf(x); var iy = TIER_ORDER.indexOf(y);
      ix = ix < 0 ? 99 : ix; iy = iy < 0 ? 99 : iy;
      if (ix !== iy) return ix - iy;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    var wrap = el("div", "pets");
    var bar = el("div", "bar");
    var legend = el("div", "legend");
    ks.forEach(function (k) {
      var seg = el("span", "seg " + tierClass(k));
      seg.style.flex = pets[k] + " 1 0";
      bar.appendChild(seg);
      var item = el("span", "item");
      item.appendChild(el("i", tierClass(k)));
      item.appendChild(document.createTextNode(k + " " + fmt(pets[k])));
      legend.appendChild(item);
    });
    wrap.appendChild(bar);
    wrap.appendChild(legend);
    return wrap;
  }

  function trend(a) {
    var h = a.history;
    if (!h || h.length < 2) return null;
    var first = h[0];
    var last = h[h.length - 1];
    var span = last.t - first.t;
    if (span < 600) return null;
    var parts = [];
    if (typeof first.r === "number" && typeof last.r === "number" && last.r > first.r) parts.push("+" + fmt(last.r - first.r) + " rebirth");
    if (typeof first.c === "number" && typeof last.c === "number" && last.c > first.c) parts.push("+" + fmt(last.c - first.c) + " clicks");
    if (!parts.length) return null;
    return "Dalam " + dur(span) + " terakhir: " + parts.join(", ");
  }

  function sheet(a, now, offlineAfter) {
    var age = Math.max(0, now - a.receivedAt);
    var online = age <= offlineAfter;
    var s = el("section", "sheet " + (online ? "on" : "off"));

    var top = el("div", "state");
    top.appendChild(el("div", "word", online ? "Online" : "Offline"));
    var since = el("div", "since", "Lapor " + dur(age) + " lalu");
    since.setAttribute("data-at", String(a.receivedAt));
    top.appendChild(since);
    s.appendChild(top);

    s.appendChild(pulse());

    var who = el("div", "who");
    who.appendChild(el("strong", "", a.displayName || a.name || a.id));
    if (a.name) who.appendChild(el("span", "handle", "@" + a.name));
    s.appendChild(who);

    var chips = el("div", "chips");
    if (a.afk) {
      chips.appendChild(el("span", "chip afk", "AFK" + (typeof a.idle === "number" ? " " + dur(a.idle) : "")));
    } else {
      chips.appendChild(el("span", "chip ok", "Sedang aktif"));
    }
    if (a.keyPerm) {
      chips.appendChild(el("span", "chip", "Key permanen"));
    } else if (typeof a.keyExp === "number") {
      var left = a.keyExp - now;
      chips.appendChild(el("span", "chip" + (left < 86400 ? " warn" : ""), left > 0 ? "Key sisa " + dur(left) : "Key habis"));
    }
    s.appendChild(chips);

    var stats = a.stats || {};
    var pets = a.pets || {};
    s.appendChild(row("Clicks", fmt(stats.Clicks)));
    s.appendChild(row("Rebirth", fmt(stats.Rebirths)));
    s.appendChild(row("Pet", fmt(pets.Total)));

    var bar = petsBar(pets);
    if (bar) s.appendChild(bar);

    var t = trend(a);
    if (t) s.appendChild(el("div", "trend", t));

    var facts = el("div", "facts");
    facts.appendChild(fact("Ping", a.ping != null ? Math.round(a.ping) + " ms" : "-"));
    facts.appendChild(fact("FPS", a.fps != null ? String(Math.round(a.fps)) : "-"));
    facts.appendChild(fact("Pemain", a.players != null ? String(a.players) : "-"));
    facts.appendChild(fact("Sesi", a.uptime != null ? dur(a.uptime) : "-"));
    s.appendChild(facts);

    var other = Object.keys(stats).filter(function (k) { return k !== "Clicks" && k !== "Rebirths"; });
    if (other.length) {
      var det = el("details", "more");
      det.appendChild(el("summary", "", "Statistik lain (" + other.length + ")"));
      other.sort().forEach(function (k) { det.appendChild(row(k, fmt(stats[k]))); });
      det.open = !!openMore[a.id];
      det.addEventListener("toggle", function () { openMore[a.id] = det.open; });
      s.appendChild(det);
    }
    return s;
  }

  function renderMonitor(data) {
    (data.accounts || []).forEach(function (a) {
      var prev = shown[a.id];
      if (!prev || a.receivedAt >= prev.receivedAt) shown[a.id] = a;
    });

    var list = Object.keys(shown).map(function (id) { return shown[id]; });
    var now = serverNow;
    list.sort(function (x, y) {
      var ox = now - x.receivedAt <= data.offlineAfter ? 0 : 1;
      var oy = now - y.receivedAt <= data.offlineAfter ? 0 : 1;
      if (ox !== oy) return ox - oy;
      return String(x.name || x.id).localeCompare(String(y.name || y.id));
    });

    paneMon.textContent = "";
    if (!list.length) {
      var empty = el("div", "empty");
      empty.appendChild(el("strong", "", "Belum ada akun yang melapor"));
      empty.appendChild(document.createTextNode("Jalankan script monitor di akunmu dengan key dari tab Developer. Halaman ini terisi sendiri dalam setengah menit."));
      paneMon.appendChild(empty);
      return;
    }
    list.forEach(function (a) { paneMon.appendChild(sheet(a, now, data.offlineAfter)); });
  }

  function fail(message) {
    failed = true;
    stamp.textContent = message;
    stamp.className = "stamp bad";
  }

  function loadMonitor() {
    api("GET", "/api/status").then(function (r) {
      if (r.status === 401 || r.status === 403) { boot(); return; }
      if (r.status !== 200) { fail("Gagal memuat (" + r.status + "). Mencoba lagi."); return; }
      failed = false;
      lastOkAt = Date.now();
      fetchedAt = lastOkAt;
      serverNow = r.body.now;
      stamp.className = "stamp";
      renderMonitor(r.body);
      tick();
    }, function () { fail("Tidak tersambung. Mencoba lagi."); });
  }

  function tick() {
    if (view === "monitor" && lastOkAt && !failed) {
      stamp.className = "stamp";
      stamp.textContent = "Diperbarui " + dur((Date.now() - lastOkAt) / 1000) + " lalu";
    }
    var els = document.querySelectorAll(".since[data-at]");
    for (var i = 0; i < els.length; i++) {
      var at = Number(els[i].getAttribute("data-at"));
      els[i].textContent = "Lapor " + dur(estNow() - at) + " lalu";
    }
  }

  // ---------- developer mode ----------

  function keyStatus(k) {
    var now = keyClock();
    if (k.revoked) return { text: "Dicabut", cls: "bad" };
    if (k.permanent) return { text: k.activatedAt ? "Permanen" : "Permanen, belum dipakai", cls: "ok" };
    if (!k.activatedAt) return { text: "Belum dipakai", cls: "" };
    if (k.expiresAt <= now) return { text: "Habis", cls: "bad" };
    return { text: "Aktif", cls: k.expiresAt - now < 86400 ? "warn" : "ok" };
  }

  function keyInfoLine(k) {
    var now = keyClock();
    if (k.permanent) return "Durasi: permanen";
    if (!k.activatedAt) return "Durasi: " + dur(k.durationSec) + " (mulai dihitung saat pertama dipakai)";
    if (k.expiresAt <= now) return "Habis " + dur(now - k.expiresAt) + " lalu";
    return "Sisa: " + dur(k.expiresAt - now);
  }

  function replaceKey(rec) {
    var found = false;
    keys = keys.map(function (k) {
      if (k.key === rec.key) { found = true; return rec; }
      return k;
    });
    if (!found) keys.unshift(rec);
  }

  function act(promise, okMsg) {
    return promise.then(function (r) {
      if (r.status !== 200 || (r.body && r.body.error)) {
        toast((r.body && r.body.error) || "Gagal (" + r.status + ")");
        return null;
      }
      if (okMsg) toast(okMsg);
      return r.body;
    }, function () { toast("Tidak tersambung"); return null; });
  }

  function extendForm(k) {
    var box = el("div", "kext");
    var grid = el("div", "grid2");
    var amount = numInput(7, 1, 3650);
    var unit = unitSelect();
    grid.appendChild(field("Tambah durasi", amount));
    grid.appendChild(field("Satuan", unit));
    box.appendChild(grid);

    var acts = el("div", "kact");
    acts.appendChild(btn("Tambah", "small", function () {
      act(api("POST", "/api/keys/extend", { key: k.key, amount: Number(amount.value), unit: unit.value }), "Durasi ditambah").then(function (b) {
        if (b && b.key) { replaceKey(b.key); openExtend[k.key] = false; renderKeys(); }
      });
    }));
    if (!k.permanent) {
      acts.appendChild(btn("Jadikan permanen", "small ghost", function () {
        if (!confirm("Jadikan key ini permanen?")) return;
        act(api("POST", "/api/keys/extend", { key: k.key, permanent: true }), "Key jadi permanen").then(function (b) {
          if (b && b.key) { replaceKey(b.key); openExtend[k.key] = false; renderKeys(); }
        });
      }));
    }
    box.appendChild(acts);
    return box;
  }

  function keyCard(k) {
    var st = keyStatus(k);
    var c = el("div", "kcard");

    var top = el("div", "ktop");
    var kb = el("button", "mono", k.key);
    kb.type = "button";
    kb.title = "Salin key";
    kb.addEventListener("click", function () { copy(k.key, "Key"); });
    top.appendChild(kb);
    top.appendChild(el("span", "chip " + st.cls, st.text));
    c.appendChild(top);

    var info = el("p", "kinfo");
    info.appendChild(document.createTextNode(keyInfoLine(k)));
    c.appendChild(info);

    var hw = el("p", "kinfo");
    if (k.hwid) {
      hw.appendChild(document.createTextNode("HWID: "));
      hw.appendChild(el("b", "mono", k.hwid.slice(0, 8)));
      if (k.boundName) hw.appendChild(document.createTextNode(" (pertama dipakai oleh " + k.boundName + ")"));
    } else {
      hw.appendChild(document.createTextNode("HWID: belum terikat"));
    }
    c.appendChild(hw);

    if (k.note) c.appendChild(el("p", "kinfo", "Catatan: " + k.note));

    var acts = el("div", "kact");
    acts.appendChild(btn("+ Durasi", "small ghost", function () { openExtend[k.key] = !openExtend[k.key]; renderKeys(); }));
    var rb = btn("Reset HWID", "small ghost", function () {
      if (!confirm("Reset HWID? Key bisa dipakai di perangkat baru.")) return;
      act(api("POST", "/api/keys/reset-hwid", { key: k.key }), "HWID direset").then(function (b) {
        if (b && b.key) { replaceKey(b.key); renderKeys(); }
      });
    });
    rb.disabled = !k.hwid;
    acts.appendChild(rb);
    acts.appendChild(btn(k.revoked ? "Aktifkan" : "Cabut", "small ghost", function () {
      act(api("POST", "/api/keys/revoke", { key: k.key, revoked: !k.revoked }), k.revoked ? "Key diaktifkan" : "Key dicabut").then(function (b) {
        if (b && b.key) { replaceKey(b.key); renderKeys(); }
      });
    }));
    acts.appendChild(btn("Hapus", "small danger", function () {
      if (!confirm("Hapus key " + k.key + " selamanya?")) return;
      act(api("POST", "/api/keys/delete", { key: k.key }), "Key dihapus").then(function (b) {
        if (b) { keys = keys.filter(function (x) { return x.key !== k.key; }); renderKeys(); }
      });
    }));
    c.appendChild(acts);

    if (openExtend[k.key]) c.appendChild(extendForm(k));
    return c;
  }

  function renderKeys() {
    var box = devPane.list;
    box.textContent = "";
    var q = keyFilter.trim().toUpperCase();
    var shownKeys = keys.filter(function (k) {
      if (!q) return true;
      return k.key.indexOf(q) >= 0 || String(k.note || "").toUpperCase().indexOf(q) >= 0 || String(k.boundName || "").toUpperCase().indexOf(q) >= 0;
    });
    devPane.count.textContent = keys.length ? "Daftar key (" + keys.length + ")" : "Daftar key";
    if (!shownKeys.length) {
      box.appendChild(el("p", "hint", keys.length ? "Tidak ada key yang cocok." : "Belum ada key. Buat dulu di atas."));
      return;
    }
    shownKeys.forEach(function (k) { box.appendChild(keyCard(k)); });
  }

  function loadKeys() {
    api("GET", "/api/keys").then(function (r) {
      if (r.status === 401 || r.status === 403) { boot(); return; }
      if (r.status !== 200) { toast("Gagal memuat key (" + r.status + ")"); return; }
      keys = r.body.keys || [];
      keysNow = r.body.now;
      keysFetchedAt = Date.now();
      renderKeys();
    }, function () { toast("Tidak tersambung"); });
  }

  function renderDevs() {
    var box = devPane.devList;
    box.textContent = "";
    if (!devs.length) box.appendChild(el("p", "hint", "Belum ada developer tambahan. Akun di OWNER_IDS otomatis owner."));
    devs.forEach(function (d) {
      var r = el("div", "devrow");
      var left = el("div");
      left.appendChild(el("div", "", d.name || "Developer"));
      left.appendChild(el("div", "mono", d.id));
      r.appendChild(left);
      if (me.isOwner) {
        r.appendChild(btn("Hapus", "small danger", function () {
          if (!confirm("Cabut akses developer untuk " + (d.name || d.id) + "?")) return;
          act(api("POST", "/api/devs/remove", { id: d.id }), "Akses dicabut").then(function (b) {
            if (b) { devs = devs.filter(function (x) { return x.id !== d.id; }); renderDevs(); }
          });
        }));
      }
      box.appendChild(r);
    });
  }

  function loadDevs() {
    api("GET", "/api/devs").then(function (r) {
      if (r.status !== 200) return;
      devs = r.body.devs || [];
      renderDevs();
    });
  }

  function buildDev() {
    paneDev.textContent = "";
    devPane = {};

    // buat key
    var gen = el("section", "sheet");
    gen.appendChild(el("h2", "", "Buat key"));
    var g1 = el("div", "grid2");
    var count = numInput(1, 1, 20);
    g1.appendChild(field("Jumlah key", count, "gen-count"));
    var note = el("input");
    note.type = "text";
    note.maxLength = 40;
    note.placeholder = "mis. nama pembeli";
    g1.appendChild(field("Catatan (opsional)", note, "gen-note"));
    gen.appendChild(g1);

    var g2 = el("div", "grid2");
    var amount = numInput(30, 1, 3650);
    var unit = unitSelect();
    g2.appendChild(field("Durasi", amount, "gen-amount"));
    g2.appendChild(field("Satuan", unit, "gen-unit"));
    gen.appendChild(g2);

    var permLabel = el("label", "check");
    var perm = el("input");
    perm.type = "checkbox";
    permLabel.appendChild(perm);
    permLabel.appendChild(document.createTextNode("Permanen (tanpa batas waktu)"));
    perm.addEventListener("change", function () { amount.disabled = perm.checked; unit.disabled = perm.checked; });
    gen.appendChild(permLabel);

    var made = el("div", "made");
    made.hidden = true;
    gen.appendChild(btn("Buat key", "", function () {
      act(api("POST", "/api/keys", { count: Number(count.value), amount: Number(amount.value), unit: unit.value, permanent: perm.checked, note: note.value }), null).then(function (b) {
        if (!b || !b.keys) return;
        made.textContent = "";
        made.hidden = false;
        made.appendChild(el("p", "hint", "Durasi mulai dihitung saat key pertama kali dipakai di script."));
        b.keys.forEach(function (k) {
          replaceKey(k);
          var line = el("div", "keyline");
          line.appendChild(el("span", "mono", k.key));
          line.appendChild(btn("Salin", "small ghost", function () { copy(k.key, "Key"); }));
          made.appendChild(line);
        });
        if (b.keys.length > 1) {
          var all = b.keys.map(function (k) { return k.key; }).join("\n");
          made.appendChild(btn("Salin semua", "small", function () { copy(all, "Semua key"); }));
        }
        renderKeys();
      });
    }));
    gen.appendChild(made);
    paneDev.appendChild(gen);

    // daftar key
    var list = el("section", "sheet");
    var h = el("h2", "", "Daftar key");
    devPane.count = h;
    list.appendChild(h);
    var search = el("input", "search");
    search.type = "text";
    search.placeholder = "Cari key, catatan, atau nama akun";
    search.setAttribute("aria-label", "Cari key");
    search.addEventListener("input", function () { keyFilter = search.value; renderKeys(); });
    list.appendChild(search);
    var listBox = el("div");
    devPane.list = listBox;
    list.appendChild(listBox);
    list.appendChild(el("p", "hint", "Cabut, reset HWID, dan tambah durasi berlaku di script dalam kurang lebih 1 menit."));
    paneDev.appendChild(list);

    // whitelist developer
    var wl = el("section", "sheet");
    wl.appendChild(el("h2", "", "Whitelist developer"));
    var devList = el("div");
    devPane.devList = devList;
    wl.appendChild(devList);
    if (me.isOwner) {
      var wg = el("div", "grid2");
      var did = el("input");
      did.type = "text";
      did.setAttribute("inputmode", "numeric");
      did.placeholder = "Discord ID";
      var dname = el("input");
      dname.type = "text";
      dname.maxLength = 30;
      dname.placeholder = "Nama (opsional)";
      wg.appendChild(field("Discord ID", did, "dev-id"));
      wg.appendChild(field("Nama", dname, "dev-name"));
      wl.appendChild(wg);
      wl.appendChild(btn("Tambah developer", "", function () {
        act(api("POST", "/api/devs", { id: did.value, name: dname.value }), "Developer ditambahkan").then(function (b) {
          if (b && b.dev) {
            devs = devs.filter(function (x) { return x.id !== b.dev.id; });
            devs.push(b.dev);
            did.value = "";
            dname.value = "";
            renderDevs();
          }
        });
      }));
    } else {
      wl.appendChild(el("p", "hint", "Hanya owner yang bisa menambah atau mencabut developer."));
    }
    paneDev.appendChild(wl);

    renderKeys();
    renderDevs();
  }

  // ---------- tab & boot ----------

  function setView(v) {
    view = v;
    tabMon.setAttribute("aria-selected", v === "monitor" ? "true" : "false");
    tabDev.setAttribute("aria-selected", v === "dev" ? "true" : "false");
    paneMon.hidden = v !== "monitor";
    paneDev.hidden = v !== "dev";
    if (v === "dev") {
      stamp.textContent = "";
      loadKeys();
      loadDevs();
    } else {
      loadMonitor();
    }
  }

  function renderUser() {
    userbox.textContent = "";
    userbox.hidden = false;
    if (me.user.avatar) {
      var img = el("img");
      img.src = me.user.avatar;
      img.alt = "";
      userbox.appendChild(img);
    }
    userbox.appendChild(el("span", "", me.user.name || "Discord"));
    var out = el("button", "linkbtn", "Keluar");
    out.type = "button";
    out.addEventListener("click", function () {
      api("POST", "/auth/logout", {}).then(function () { location.reload(); });
    });
    userbox.appendChild(out);
  }

  function startApp() {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    renderUser();
    tabs.hidden = false;
    root.textContent = "";
    paneMon = el("div");
    paneDev = el("div");
    root.appendChild(paneMon);
    root.appendChild(paneDev);
    buildDev();
    setView("monitor");
    pollTimer = setInterval(function () { if (view === "monitor") loadMonitor(); }, POLL_MS);
    tickTimer = setInterval(tick, 30000);
  }

  function boot() {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    tabs.hidden = true;
    userbox.hidden = true;
    stamp.textContent = "";

    var params = new URLSearchParams(location.search);
    var e = params.get("e");
    if (e) history.replaceState(null, "", "/");

    api("GET", "/api/me").then(function (r) {
      me = r.body || {};
      if (!me.configured) { showSetup(); return; }
      if (!me.loggedIn) { showLogin(e ? (ERRORS[e] || "Login gagal.") : ""); return; }
      if (!me.isDev) { renderUser(); showNotDev(); return; }
      if (!me.kvBound) {
        root.textContent = "";
        root.appendChild(el("div", "note", "KV dengan binding bernama MONITOR belum dipasang di Worker. Key dan data akun butuh KV."));
        return;
      }
      startApp();
    }, function () { fail("Tidak tersambung. Muat ulang halaman."); });
  }

  tabMon.addEventListener("click", function () { if (paneMon) setView("monitor"); });
  tabDev.addEventListener("click", function () { if (paneDev) setView("dev"); });
  boot();
})();
</script>
</body>
</html>`;
