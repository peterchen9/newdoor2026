// Run in the Node Docker image with NODE_EXTRA_CA_CERTS pointing at the exported root.
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const parse = text => Object.fromEntries(text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const at = l.indexOf('='); return [l.slice(0, at), l.slice(at + 1)]; }));
const env = parse(await readFile('.env', 'utf8'));
const phone = parse(await readFile('.env.phone', 'utf8'));
const base = `https://${phone.LAN_IP}:3443`;
const request = (path, options = {}) => fetch(base + path, { ...options, signal: AbortSignal.timeout(10000) });
for (const path of ['/health', '/host', '/door', '/app.js', '/audio-stats.js']) assert.equal((await request(path)).status, 200);
const { testNoAuth } = await (await request('/api/config')).json();
let token;
if (!testNoAuth) {
  const r = await request('/api/pair-code', { method: 'POST', headers: { Authorization: `Bearer ${env.HOST_TOKEN}` } });
  assert.equal(r.status, 201);
  const { code } = await r.json();
  const redeemed = await request('/api/pair', { method: 'POST', body: JSON.stringify({ code }) });
  assert.equal(redeemed.status, 201); ({ token } = await redeemed.json());
}
const ws = new WebSocket(base.replace('https', 'wss') + '/ws', { origin: base });
const deadline = setTimeout(() => ws.terminate(), 10000);
try {
  const received = once(ws, 'message'); await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'auth', role: 'door', token }));
  const [raw] = await received; assert.equal(JSON.parse(raw).type, 'state');
  console.log(`PASS: trusted TLS, HTTPS routes and ${testNoAuth ? 'keyless test WSS' : 'pairing and authenticated WSS'} through Caddy. No camera, microphone or relay was activated.`);
} finally { clearTimeout(deadline); ws.close(); }
