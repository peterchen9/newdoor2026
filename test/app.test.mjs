import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../server.mjs';

const HOST_TOKEN = 'host-test-abcdefghijklmnopqrstuvwxyz', DOOR_TOKEN = 'door-test-abcdefghijklmnopqrstuvwxyz';
async function setup(t, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'newdoor-'));
  const app = await createApp({ HOST_TOKEN, DOOR_TOKEN, DATA_DIR: dir, PHOTO_DIR: join(dir, 'photos'), RELAY_MODE: 'mock', ...config });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  async function connect(role, token = role === 'host' ? HOST_TOKEN : DOOR_TOKEN) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { origin: base });
    const messages = [], waiters = [];
    ws.on('message', b => { const m = JSON.parse(b); messages.push(m); for (const check of [...waiters]) check(); });
    ws.wait = (predicate, timeout = 2500) => new Promise((resolve, reject) => {
      let timer;
      const check = () => { const i = messages.findIndex(predicate); if (i >= 0) { clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1); resolve(messages.splice(i, 1)[0]); } };
      timer = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(Error('Message timeout')); }, timeout);
      waiters.push(check); check();
    });
    ws.sendJson = m => ws.send(JSON.stringify(m));
    await once(ws, 'open'); ws.sendJson({ type: 'auth', role, token });
    return ws;
  }
  async function ring(door) { door.sendJson({ type: 'ring' }); return (await door.wait(m => m.type === 'capture')).callId; }
  return { ...app, base, dir, connect, ring };
}

test('authenticated ring, preview, answer, three photos, exactly one mock unlock and persistent audit', async t => {
  const a = await setup(t), host = await a.connect('host'), door = await a.connect('door');
  await host.wait(m => m.type === 'state'); await door.wait(m => m.type === 'state');
  const id = await a.ring(door);
  host.sendJson({ type: 'unlock', callId: 'stale' }); await host.wait(m => m.type === 'error');
  door.sendJson({ type: 'unlock', callId: id }); await door.wait(m => m.type === 'error');
  door.sendJson({ type: 'signal', callId: id, payload: { description: { type: 'offer', sdp: 'test' } } });
  assert.equal((await host.wait(m => m.type === 'signal')).callId, id);
  const bytes = Buffer.from([255,216,255,217]);
  for (const slot of [0,1,2]) {
    const r = await fetch(`${a.base}/api/photos/${id}/${slot}`, { method: 'POST', headers: { Authorization: `Bearer ${DOOR_TOKEN}` }, body: bytes }); assert.equal(r.status, 201);
  }
  const duplicate = await fetch(`${a.base}/api/photos/${id}/0`, { method: 'POST', headers: { Authorization: `Bearer ${DOOR_TOKEN}` }, body: bytes }); assert.equal(duplicate.status, 409);
  host.sendJson({ type: 'answer', callId: id }); await door.wait(m => m.type === 'answered');
  host.sendJson({ type: 'unlock', callId: id }); host.sendJson({ type: 'unlock', callId: id });
  await host.wait(m => m.type === 'notice'); await host.wait(m => m.type === 'error');
  const events = a.db.prepare('SELECT action FROM events').all().map(e => e.action);
  assert.equal(events.filter(e => e === 'relay_simulated').length, 1);
  assert.ok(events.indexOf('call_ended') < events.indexOf('relay_simulated'));
  assert.equal((await readdir(join(a.dir, 'photos'))).length, 3);
  assert.equal((await fetch(`${a.base}/api/events`)).status, 401);
  assert.equal((await fetch(`${a.base}/api/events`, { headers: { Authorization: `Bearer ${DOOR_TOKEN}` } })).status, 401);
  const history = await fetch(`${a.base}/api/events`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
  assert.equal((await history.json()).photos.length, 3);
  assert.equal((await fetch(`${a.base}/api/photo/${id}_0.jpg`)).status, 401);
  assert.equal((await fetch(`${a.base}/api/photo/${id}_0.jpg`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } })).status, 200);
});
test('unanswered ring expires and never unlocks', async t => {
  const a = await setup(t, { RING_SECONDS: '1' }), door = await a.connect('door');
  await a.ring(door); const ended = await door.wait(m => m.type === 'ended');
  assert.equal(ended.reason, 'no_answer'); assert.ok(ended.contact);
  assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM events WHERE action='relay_simulated'").get().n, 0);
  assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM events WHERE action='photos_incomplete'").get().n, 1);
});
test('disconnect terminates call; a late host can request a fresh preview', async t => {
  const a = await setup(t), door = await a.connect('door'); const id = await a.ring(door);
  const host = await a.connect('host'); assert.equal((await door.wait(m => m.type === 'preview')).callId, id);
  host.close(); assert.equal((await door.wait(m => m.type === 'ended')).reason, 'peer_disconnected');
});
test('duplicate roles and invalid credentials are rejected', async t => {
  const a = await setup(t), door = await a.connect('door'); await door.wait(m => m.type === 'state');
  const duplicate = await a.connect('door'); assert.equal((await once(duplicate, 'close'))[0], 4009);
  const invalid = await a.connect('host', 'wrong'); assert.equal((await once(invalid, 'close'))[0], 4003);
});
test('call duration is bounded and malformed uploads are rejected', async t => {
  const a = await setup(t, { CALL_SECONDS: '1' }), host = await a.connect('host'), door = await a.connect('door');
  const id = await a.ring(door);
  const response = await fetch(`${a.base}/api/photos/${id}/0`, { method: 'POST', headers: { Authorization: `Bearer ${DOOR_TOKEN}` }, body: 'not-jpeg' }); assert.equal(response.status, 400);
  host.sendJson({ type: 'answer', callId: id }); await door.wait(m => m.type === 'answered');
  assert.equal((await host.wait(m => m.type === 'ended')).reason, 'call_timeout');
});
