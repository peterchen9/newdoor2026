import http from 'node:http';
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomInt, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, WebSocket } from 'ws';

export async function createApp(options = {}) {
  const env = { ...process.env, ...options };
  const tokens = { host: env.HOST_TOKEN, door: env.DOOR_TOKEN };
  if (Object.values(tokens).some(t => !t || t.length < 24) || tokens.host === tokens.door) throw Error('Set distinct HOST_TOKEN and DOOR_TOKEN, minimum 24 characters');
  const integer = (key, fallback, min, max) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw Error(`Invalid ${key}`);
    return n;
  };
  const ringMs = integer('RING_SECONDS', 30, 1, 120) * 1000;
  const callMs = integer('CALL_SECONDS', 180, 1, 900) * 1000;
  const pulseMs = integer('RELAY_PULSE_MS', 3000, 100, 10000);
  const mode = env.RELAY_MODE || 'mock';
  if (!['mock', 'http'].includes(mode)) throw Error('Invalid RELAY_MODE');
  if (mode === 'http' && (!env.RELAY_URL?.startsWith('https://') || !env.RELAY_TOKEN)) throw Error('HTTP relay requires HTTPS URL and token');
  const dataDir = env.DATA_DIR || './data', photoDir = env.PHOTO_DIR || './door_photo';
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(photoDir, { recursive: true })]);
  const db = new DatabaseSync(join(dataDir, 'door.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at TEXT NOT NULL, call_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS photos(call_id TEXT, slot INTEGER, filename TEXT UNIQUE, at TEXT, PRIMARY KEY(call_id,slot));`);
  const peers = new Map();
  const phoneSessions = new Map();
  let pairing, pairWindow = 0, pairAttempts = 0;
  const pairMs = integer('PAIR_SECONDS', 120, 1, 300) * 1000;
  let active = null, timer, lastRing = 0;
  function log(actor, action, detail = {}, callId = active?.id) {
    db.prepare('INSERT INTO events(at,call_id,actor,action,detail) VALUES(?,?,?,?,?)').run(new Date().toISOString(), callId || null, actor, action, JSON.stringify(detail));
  }
  log('system', 'server_started', { relay: mode, previousCallsClosed: true });
  const send = (role, msg) => { const p = peers.get(role); if (p?.readyState === WebSocket.OPEN) p.send(JSON.stringify(msg)); };
  const state = () => ({ type: 'state', call: active && { id: active.id, status: active.status, at: active.at }, online: { door: peers.has('door'), host: peers.has('host') }, relay: mode });
  const broadcast = () => { for (const role of peers.keys()) send(role, state()); };
  function finish(reason, actor = 'system') {
    if (!active) return;
    clearTimeout(timer);
    log(actor, 'call_ended', { reason });
    const count = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE call_id=?').get(active.id).n;
    if (count < 3) log('system', 'photos_incomplete', { saved: count, expected: 3, reason });
    for (const role of peers.keys()) send(role, { type: 'ended', callId: active.id, reason, contact: env.CONTACT_TEXT || '目前無人接聽，請聯絡管理員。' });
    active = null;
    broadcast();
  }
  const arm = ms => { clearTimeout(timer); timer = setTimeout(() => finish(active?.status === 'ringing' ? 'no_answer' : 'call_timeout'), ms); };
  function authorize(req, role) {
    const value = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!['host', 'door'].includes(role)) return false;
    if (role === 'door' && phoneSessions.get(value) > Date.now()) return true;
    return Buffer.byteLength(value) === Buffer.byteLength(tokens[role]) && timingSafeEqual(Buffer.from(value), Buffer.from(tokens[role]));
  }
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  async function body(req, limit) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw Error('Request too large'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/api/pair-code') {
        if (!authorize(req, 'host')) return json(res, 401, { error: 'Unauthorized' });
        pairing = { code: String(randomInt(0, 1000000)).padStart(6, '0'), expiresAt: Date.now() + pairMs, attempts: 0 };
        log('host', 'pair_code_created', { expiresAt: pairing.expiresAt });
        return json(res, 201, { code: pairing.code, expiresAt: pairing.expiresAt });
      }
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        if (Date.now() - pairWindow > 60000) { pairWindow = Date.now(); pairAttempts = 0; }
        if (++pairAttempts > 30) return json(res, 429, { error: '嘗試過於頻繁，請一分鐘後再試。' });
        const input = JSON.parse((await body(req, 128)).toString());
        if (!pairing || pairing.expiresAt <= Date.now() || pairing.attempts >= 5) return json(res, 401, { error: '配對碼已失效，請由主機重新產生。' });
        pairing.attempts++;
        if (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code) || !timingSafeEqual(Buffer.from(input.code), Buffer.from(pairing.code))) return json(res, 401, { error: '配對碼錯誤或已失效。' });
        pairing = null;
        for (const [key, until] of phoneSessions) if (until <= Date.now()) phoneSessions.delete(key);
        if (phoneSessions.size >= 32) phoneSessions.delete(phoneSessions.keys().next().value);
        const token = randomBytes(32).toString('hex'), expiresAt = Date.now() + 8 * 3600000;
        phoneSessions.set(token, expiresAt);
        log('door', 'phone_paired', { expiresAt });
        return json(res, 201, { token, expiresAt });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (!authorize(req, 'host')) return json(res, 401, { error: 'Unauthorized' });
        const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
        return json(res, 200, { events: db.prepare('SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT 100').all(before), photos: db.prepare('SELECT * FROM photos ORDER BY at DESC LIMIT 100').all() });
      }
      const photo = url.pathname.match(/^\/api\/photos\/([a-f0-9-]{36})\/([012])$/);
      if (photo && req.method === 'POST') {
        if (!authorize(req, 'door')) return json(res, 401, { error: 'Unauthorized' });
        const [, id, slot] = photo;
        if (!active || active.id !== id || Date.now() - active.at > 15000) return json(res, 409, { error: 'Capture window closed' });
        if (db.prepare('SELECT 1 FROM photos WHERE call_id=? AND slot=?').get(id, +slot)) return json(res, 409, { error: 'Duplicate' });
        const buffer = await body(req, 1024 * 1024);
        if (buffer.length < 4 || buffer[0] !== 255 || buffer[1] !== 216 || buffer.at(-2) !== 255 || buffer.at(-1) !== 217) return json(res, 400, { error: 'JPEG required' });
        const filename = `${id}_${slot}.jpg`;
        try { await writeFile(join(photoDir, filename), buffer, { flag: 'wx' }); }
        catch (e) { if (e.code === 'EEXIST') return json(res, 409, { error: 'Duplicate' }); throw e; }
        try { db.prepare('INSERT INTO photos VALUES(?,?,?,?)').run(id, +slot, filename, new Date().toISOString()); }
        catch (e) { await unlink(join(photoDir, filename)); throw e; }
        log('door', 'photo_saved', { slot: +slot, filename }, id);
        return json(res, 201, { filename });
      }
      if (req.method === 'GET' && /^\/api\/photo\/[a-f0-9-]{36}_[012]\.jpg$/.test(url.pathname)) {
        if (!authorize(req, 'host')) return json(res, 401, { error: 'Unauthorized' });
        const buffer = await readFile(join(photoDir, url.pathname.split('/').at(-1)));
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); return res.end(buffer);
      }
      const files = { '/': 'index.html', '/door': 'index.html', '/host': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
      if (req.method === 'GET' && files[url.pathname]) {
        const file = files[url.pathname];
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
        return res.end(await readFile(new URL(`./public/${file}`, import.meta.url)));
      }
      json(res, 404, { error: 'Not found' });
    } catch (e) { json(res, e.code === 'ENOENT' ? 404 : 400, { error: 'Request failed' }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    // Only same-origin browser upgrades. Authentication is the first WS message, never a URL token.
    const origin = req.headers.origin;
    let validOrigin = false;
    try { const u = new URL(origin); validOrigin = ['http:', 'https:'].includes(u.protocol) && u.host === req.headers.host; } catch {}
    if (req.url !== '/ws' || !validOrigin) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    let role, sessionTimer, alive = true;
    const authTimer = setTimeout(() => ws.close(4001, 'Authentication timeout'), 5000);
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 10000);
    ws.on('message', async raw => {
      try {
        const m = JSON.parse(raw);
        if (!role) {
          if (m.type !== 'auth' || !authorize({ headers: { authorization: `Bearer ${m.token || ''}` } }, m.role)) return ws.close(4003, 'Unauthorized');
          if (peers.has(m.role)) return ws.close(4009, 'Role already connected');
          role = m.role; clearTimeout(authTimer); peers.set(role, ws); log(role, 'connected'); broadcast();
          if (role === 'door' && phoneSessions.has(m.token)) sessionTimer = setTimeout(() => ws.close(4001, 'Pair session expired'), Math.max(1, phoneSessions.get(m.token) - Date.now()));
          if (role === 'host' && active?.status === 'ringing') send('door', { type: 'preview', callId: active.id });
          return;
        }
        if (m.type === 'ring' && role === 'door') {
          if (active || Date.now() - lastRing < 3000) throw Error('忙碌中，請稍候');
          lastRing = Date.now();
          active = { id: randomUUID(), at: Date.now(), status: 'ringing' };
          log(role, 'ring'); arm(ringMs); broadcast(); send('door', { type: 'capture', callId: active.id }); return;
        }
        if (!active || m.callId !== active.id) throw Error('通話已結束或識別碼不符');
        if (m.type === 'answer' && role === 'host' && active.status === 'ringing') {
          active.status = 'connected'; log(role, 'answered'); arm(callMs); broadcast(); send('door', { type: 'answered', callId: active.id }); return;
        }
        if (m.type === 'hangup') { finish('hangup', role); return; }
        if (m.type === 'unlock' && role === 'host' && ['ringing', 'connected'].includes(active.status)) {
          const id = active.id; active.status = 'unlocking'; log(role, 'unlock_requested', { mode });
          // Claim before awaiting; duplicate commands and disconnected sessions cannot replay a pulse.
          finish('unlock_requested', role);
          try {
            if (mode === 'http') {
              const response = await fetch(env.RELAY_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RELAY_TOKEN}`, 'Idempotency-Key': id }, body: JSON.stringify({ commandId: id, pulseMs }) });
              if (!response.ok) throw Error('Relay rejected');
              const ack = await response.json();
              if (ack.commandId !== id || ack.accepted !== true) throw Error('Invalid acknowledgement');
            }
            log('relay', mode === 'mock' ? 'relay_simulated' : 'relay_acknowledged', { pulseMs }, id);
            send('host', { type: 'notice', text: mode === 'mock' ? '模擬開門完成（未接實體電鎖）' : '控制器已確認脈衝命令（未確認門扇開啟）' });
          } catch { log('relay', 'relay_unknown', { message: 'No retry; inspect controller before another attempt' }, id); send('host', { type: 'notice', text: '開門結果未知，請檢查控制器；系統不會自動重送。' }); }
          return;
        }
        if (m.type === 'signal' && ['ringing', 'connected'].includes(active.status)) {
          if (!m.payload || !['description', 'candidate'].some(k => k in m.payload)) throw Error('Invalid signal');
          send(role === 'door' ? 'host' : 'door', { type: 'signal', callId: active.id, payload: m.payload }); return;
        }
        if (m.type === 'diagnostic') { log(role, 'diagnostic', { message: String(m.message).slice(0, 300) }); return; }
        throw Error('不允許此操作');
      } catch (e) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', text: e.message })); }
    });
    ws.on('close', () => {
      clearTimeout(authTimer); clearTimeout(sessionTimer); clearInterval(heartbeat);
      if (role && peers.get(role) === ws) { peers.delete(role); log(role, 'disconnected'); finish('peer_disconnected'); broadcast(); }
    });
    ws.on('error', () => {});
  });
  return { server, db, close: async () => { clearTimeout(timer); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); db.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp();
  app.server.listen(Number(process.env.PORT || 3900), '0.0.0.0', () => console.log('newdoor2026 http://localhost:3900 (relay: ' + (process.env.RELAY_MODE || 'mock') + ')'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
