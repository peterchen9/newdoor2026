const $ = id => document.getElementById(id);
const role = location.pathname.slice(1);
if (['door', 'host'].includes(role)) {
  let testNoAuth = false;
  $('welcome').hidden = true; $('console').hidden = false;
  $('roleLabel').textContent = role === 'door' ? 'DOOR / 手機門口端' : 'HOST / 電腦主機端';
  $('heading').textContent = role === 'door' ? '歡迎來訪' : '門口接待控制台';
  $('history').hidden = role !== 'host';
  $('login').hidden = role === 'door'; $('pairLogin').hidden = role !== 'door'; $('phoneSettings').hidden = role !== 'door';
  let ws, token, call, pc, local, remote, pending = [], signalQueue = Promise.resolve(), captureTimers = [], failureTimer, photoUrls = [], connecting = false, generation = 0, chime, onlineState = {}, authenticated = false, wakeLock, keepAwake = false, pairTimer;
  const say = text => { $('notice').textContent = text; };
  const send = (type, more = {}) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, callId: call?.id, ...more })); };
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  function cleanup() {
    generation++;
    clearTimeout(failureTimer); captureTimers.forEach(clearTimeout); captureTimers = [];
    if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = null; }
    local?.getTracks().forEach(t => t.stop()); local = null; remote = null; pending = [];
    $('video').srcObject = null; $('remoteAudio').srcObject = null; $('placeholder').hidden = false; $('play').hidden = true;
  }
  function render(online = onlineState) {
    onlineState = online;
    const active = !!call;
    $('status').textContent = call ? ({ ringing: '來訪呼叫中', connected: '雙向通話中' }[call.status] || call.status) : '待命';
    $('online').textContent = `門口 ${online.door ? '●' : '○'} / 主機 ${online.host ? '●' : '○'}`;
    $('ring').hidden = role !== 'door'; $('ring').disabled = active || connecting || !authenticated;
    $('camera').disabled = active || connecting;
    $('createPair').hidden = testNoAuth || role !== 'host' || !authenticated;
    $('testConnect').hidden = !testNoAuth || (role === 'door' && authenticated);
    $('testConnect').textContent = authenticated ? '啟用提示音' : '重新連線';
    $('disconnect').hidden = !authenticated;
    $('answer').hidden = role !== 'host' || call?.status !== 'ringing';
    $('unlock').hidden = role !== 'host' || !active;
    $('hangup').hidden = !active;
  }
  async function play() {
    try { await $('remoteAudio').play(); $('play').hidden = true; }
    catch { $('play').hidden = false; }
  }
  function peer() {
    if (pc) return pc;
    const current = new RTCPeerConnection({ iceServers: [] }); pc = current;
    current.onicecandidate = e => { if (e.candidate) send('signal', { payload: { candidate: e.candidate.toJSON() } }); };
    current.ontrack = e => {
      remote ||= new MediaStream(); remote.addTrack(e.track);
      if (role === 'host' && e.track.kind === 'video') { $('video').srcObject = remote; $('placeholder').hidden = true; }
      $('remoteAudio').srcObject = remote; play();
    };
    current.onconnectionstatechange = () => {
      clearTimeout(failureTimer);
      if (['failed', 'disconnected'].includes(current.connectionState)) {
        say('影音連線不穩，正在等待恢復。');
        failureTimer = setTimeout(() => { send('diagnostic', { message: 'WebRTC connection failed' }); send('hangup'); cleanup(); say('影音中斷，已結束連線，請重新按鈴。'); }, 8000);
      }
    };
    if (role === 'door' && local) local.getTracks().forEach(t => current.addTrack(t, local));
    return current;
  }
  async function signal(m) {
    if (!call || m.callId !== call.id) return;
    const p = peer(), payload = m.payload;
    if (payload.description) {
      await p.setRemoteDescription(payload.description);
      for (const candidate of pending.splice(0)) await p.addIceCandidate(candidate);
      if (payload.description.type === 'offer') {
        await p.setLocalDescription(await p.createAnswer());
        send('signal', { payload: { description: p.localDescription } });
      }
    } else if (payload.candidate) {
      if (p.remoteDescription) await p.addIceCandidate(payload.candidate); else pending.push(payload.candidate);
    }
  }
  async function capture(id, slot) {
    if (!call || call.id !== id || !local) return;
    try {
      const video = $('video'), canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      if (!canvas.width) throw Error('鏡頭尚未就緒');
      canvas.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', .85));
      const response = await fetch(`/api/photos/${id}/${slot}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: blob });
      if (!response.ok) throw Error('照片儲存失敗');
    } catch (e) { send('diagnostic', { message: `photo ${slot}: ${e.message}` }); say(`第 ${slot + 1} 張照片未存檔：${e.message}`); }
  }
  function connect(key) {
    if (role === 'host') { try { chime ||= new AudioContext(); chime.resume(); } catch {} }
    if (ws && ws.readyState < 2) return;
    token = key; ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', role, token }));
    ws.onmessage = async e => {
      const m = JSON.parse(e.data);
      try {
        if (m.type === 'state') {
          const was = call; call = m.call;
          authenticated = true; $('login').hidden = true; $('pairLogin').hidden = true; $('token').value = ''; $('pairCode').value = ''; $('connection').textContent = '● 已連線'; $('relay').textContent = m.relay === 'mock' ? 'MOCK / 模擬電鎖' : 'HTTP / 實體控制器';
          render(m.online);
          if (!call && was) cleanup();
          if (!call && !was) say('已就緒，等待來訪。');
          if (call && !was && role === 'host') {
            say('有人按鈴。可先查看畫面，再接聽通話。'); if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
            if (chime?.state === 'running') for (let i = 0; i < 3; i++) { const tone = chime.createOscillator(), gain = chime.createGain(), at = chime.currentTime + i * .4; tone.frequency.value = 660; gain.gain.setValueAtTime(.07, at); gain.gain.exponentialRampToValueAtTime(.001, at + .25); tone.connect(gain).connect(chime.destination); tone.start(at); tone.stop(at + .3); }
          }
        }
        if (m.type === 'capture' || m.type === 'preview') {
          const p = peer();
          if (m.type === 'capture') {
            capture(m.callId, 0);
            for (const slot of [1, 2]) captureTimers.push(setTimeout(() => capture(m.callId, slot), slot * 1000));
          }
          await p.setLocalDescription(await p.createOffer()); send('signal', { payload: { description: p.localDescription } });
        }
        if (m.type === 'signal') signalQueue = signalQueue.then(() => signal(m)).catch(e => { say(`影音協商失敗：${e.message}`); send('diagnostic', { message: e.message }); send('hangup'); });
        if (m.type === 'answered') { local?.getAudioTracks().forEach(t => { t.enabled = true; }); say('對方已接聽，現在可以通話。'); }
        if (m.type === 'ended') { call = null; cleanup(); render(); say(m.reason === 'unlock_requested' ? '通話已結束，正在處理開門命令。' : m.contact); }
        if (['error', 'notice'].includes(m.type)) { say(m.text); if (m.type === 'error' && !call) cleanup(); }
      } catch (e) { say(e.message); send('diagnostic', { message: e.message }); send('hangup'); cleanup(); }
    };
    ws.onclose = e => { authenticated = false; call = null; cleanup(); $('login').hidden = testNoAuth || role === 'door'; $('pairLogin').hidden = testNoAuth || role !== 'door'; $('connection').textContent = '○ 已離線'; clearInterval(pairTimer); $('pairOutput').textContent = ''; say(testNoAuth ? `已離線（${e.code}），請按「重新連線」。` : role === 'door' ? `已離線（${e.code}），請保持此頁在前景，並由主機產生新配對碼。` : `連線已關閉（${e.code}），請重新連線。`); render({}); };
    ws.onerror = () => say('無法連線主機。');
  }
  $('login').onsubmit = e => { e.preventDefault(); connect($('token').value); };
  $('testConnect').onclick = () => { connect(); if (authenticated && role === 'host') say('已啟用提示音，等待來訪。'); };
  $('pairLogin').onsubmit = async e => {
    e.preventDefault(); const button = $('pairLogin').querySelector('button'); button.disabled = true;
    try {
      const r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('pairCode').value.trim() }) });
      const result = await r.json(); if (!r.ok) throw Error(result.error); connect(result.token);
    } catch (e) { say(e.message); } finally { button.disabled = false; }
  };
  $('createPair').onclick = async () => {
    try {
      const r = await fetch('/api/pair-code', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const result = await r.json(); if (!r.ok) throw Error('請先連線主機端');
      clearInterval(pairTimer);
      const update = () => { const seconds = Math.max(0, Math.ceil((result.expiresAt - Date.now()) / 1000)); $('pairOutput').textContent = seconds ? `${result.code} · ${seconds} 秒內有效，僅限一支手機` : '配對碼已到期，請重新產生'; if (!seconds) clearInterval(pairTimer); };
      update(); pairTimer = setInterval(update, 1000);
    } catch (e) { say(e.message); }
  };
  $('disconnect').onclick = () => { cleanup(); ws?.close(); };
  async function acquireWakeLock() {
    try {
      if (!navigator.wakeLock) throw Error('此瀏覽器不支援，請暫時手動延長自動鎖定時間');
      wakeLock = await navigator.wakeLock.request('screen');
      $('wakeStatus').textContent = '已保持螢幕開啟'; $('wake').textContent = '恢復自動鎖定';
      wakeLock.addEventListener('release', () => { $('wakeStatus').textContent = '螢幕保持已釋放，請留在此頁'; });
    } catch (e) { $('wakeStatus').textContent = e.message; }
  }
  $('wake').onclick = async () => {
    keepAwake = !keepAwake;
    if (keepAwake) await acquireWakeLock();
    else { await wakeLock?.release(); wakeLock = null; $('wake').textContent = '保持螢幕開啟'; }
  };
  $('ring').onclick = async () => {
    if (connecting || call) return;
    connecting = true; render(); const epoch = generation;
    try {
      if (!navigator.mediaDevices) throw Error('攝影機需要 localhost 或受信任 HTTPS');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: $('camera').value }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 15 } }, audio });
      if (epoch !== generation || ws?.readyState !== WebSocket.OPEN) { stream.getTracks().forEach(t => t.stop()); return; }
      local = stream;
      local.getAudioTracks().forEach(t => { t.enabled = false; });
      $('video').srcObject = local; await $('video').play();
      if (!$('video').videoWidth) await new Promise(r => $('video').addEventListener('loadeddata', r, { once: true }));
      if (epoch !== generation || !authenticated) { cleanup(); return; }
      $('placeholder').hidden = true; send('ring'); say('正在呼叫，請稍候。');
    } catch (e) { cleanup(); say(`無法啟動攝影機／麥克風：${e.message}`); }
    finally { connecting = false; render(); }
  };
  $('answer').onclick = async () => {
    $('answer').disabled = true; const id = call?.id;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      if (!call || call.id !== id || call.status !== 'ringing') { stream.getTracks().forEach(t => t.stop()); return; }
      local = stream;
      // Wait for the initial door offer to finish, then renegotiate host microphone.
      await signalQueue; const p = peer();
      const transceiver = p.getTransceivers().find(t => t.receiver.track.kind === 'audio');
      if (!transceiver) throw Error('門口音訊尚未就緒，請稍候重試');
      await transceiver.sender.replaceTrack(local.getAudioTracks()[0]); transceiver.direction = 'sendrecv';
      send('answer');
      await p.setLocalDescription(await p.createOffer()); send('signal', { payload: { description: p.localDescription } });
      say('已接聽，雙向通話中。'); play();
    } catch (e) { local?.getTracks().forEach(t => t.stop()); local = null; say(`接聽失敗：${e.message}`); }
    finally { $('answer').disabled = false; }
  };
  $('unlock').onclick = () => { send('unlock'); cleanup(); $('unlock').hidden = true; };
  $('hangup').onclick = () => { send('hangup'); cleanup(); };
  $('play').onclick = play;
  const labels = { pair_code_created: '產生手機配對碼', phone_paired: '手機配對', photos_incomplete: '照片不足三張', ring: '按鈴', answered: '接聽', call_ended: '結束通話', photo_saved: '照片存檔', unlock_requested: '要求開門', relay_simulated: '模擬繼電器', relay_acknowledged: '繼電器確認', relay_unknown: '開門結果未知', connected: '連線', disconnected: '離線', diagnostic: '異常診斷', server_started: '系統啟動' };
  $('refresh').onclick = async () => {
    try {
      const headers = { Authorization: `Bearer ${token}` }, r = await fetch('/api/events', { headers });
      if (!r.ok) throw Error('請先使用主機端金鑰連線');
      const data = await r.json(); $('events').replaceChildren();
      for (const e of data.events) {
        const tr = document.createElement('tr');
        for (const value of [new Date(e.at).toLocaleString('zh-TW'), e.actor, labels[e.action] || e.action, e.detail]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
        $('events').append(tr);
      }
      photoUrls.forEach(URL.revokeObjectURL); photoUrls = []; $('photos').replaceChildren();
      for (const p of data.photos.slice(0, 12).reverse()) {
        const r = await fetch(`/api/photo/${p.filename}`, { headers }); if (!r.ok) continue;
        const url = URL.createObjectURL(await r.blob()); photoUrls.push(url);
        const figure = document.createElement('figure'), img = document.createElement('img'), caption = document.createElement('figcaption');
        img.src = url; img.alt = `來訪擷取第 ${p.slot + 1} 張`; caption.textContent = `${new Date(p.at).toLocaleString('zh-TW')} / ${p.slot + 1}`;
        figure.append(img, caption); $('photos').append(figure);
      }
    } catch (e) { say(e.message); }
  };
  document.addEventListener('visibilitychange', () => {
    if (role !== 'door') return;
    if (document.hidden) { cleanup(); ws?.close(); }
    else if (keepAwake && !wakeLock || keepAwake && wakeLock.released) acquireWakeLock();
  });
  window.addEventListener('pagehide', () => { cleanup(); ws?.close(); wakeLock?.release(); });
  if (role === 'door' && !window.isSecureContext) say('手機鏡頭需要受信任 HTTPS。請依手機設定說明安裝本機憑證，使用 https://電腦區網IP:3443/door。');
  render();
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw Error('無法讀取連線設定，請重新整理');
    const config = await response.json(); testNoAuth = config.testNoAuth === true;
    if (testNoAuth) { $('login').hidden = true; $('pairLogin').hidden = true; $('testMode').hidden = false; connect(); render(); }
  } catch (e) { say(e.message); }
}
