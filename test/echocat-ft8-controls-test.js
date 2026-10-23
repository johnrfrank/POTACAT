// SPDX-License-Identifier: Apache-2.0
'use strict';
// Exercise the real browser callbacks without Electron or a radio.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(require('path').join(__dirname, '../renderer/remote.js'), 'utf8');
const main = fs.readFileSync(require('path').join(__dirname, '../main.js'), 'utf8');

function backendStop(multi) {
  function engine() {
    return { _txEnabled: true, _txActive: true, message: 'CQ',
      setTxMessage(m) { this.message = m; }, txComplete() { this._txActive = false; } };
  }
  const engines = [engine(), engine()];
  const states = [], ptt = [], released = [];
  const context = {
    ft8Engine: engines[0],
    jtcatManager: multi ? { sliceIds: ['A', 'B'], txEngine: engines[0],
      getEngine: id => engines[id === 'A' ? 0 : 1], releaseTx: id => released.push(id) } : null,
    remoteJtcatQso: { phase: 'cq', call: 'K3SBP' },
    remoteServer: { broadcastJtcatQsoState: s => states.push(s), broadcastJtcatTxStatus() {} },
    setJtcatHuntMode: mode => { context.huntMode = mode; },
    stopFullAutoCq: () => { context.fullAuto = false; }, fullAuto: true,
    clearJtcatTxFailsafe() {}, clearJtcatIcomHardRelease() {},
    _icomNetworkTransport: null, smartSdrAudio: null,
    handleRemotePtt: on => ptt.push(on),
  };
  const start = main.indexOf('function haltRemoteJtcatTx() {');
  const end = main.indexOf('async function remoteJtcatSetTxMsg', start);
  vm.runInNewContext(main.slice(start, end), context);
  context.haltRemoteJtcatTx();
  context.haltRemoteJtcatTx();
  for (const eng of engines.slice(0, multi ? 2 : 1)) {
    assert.strictEqual(eng._txEnabled, false);
    assert.strictEqual(eng._txActive, false);
    assert.strictEqual(eng.message, '');
  }
  assert(ptt.length === 2 && ptt.every(on => on === false));
  assert.strictEqual(context.huntMode, 'off');
  assert.strictEqual(context.fullAuto, false);
  assert.strictEqual(context.remoteJtcatQso, null);
  assert(states.every(s => s.phase === 'idle' && s.txEnabled === false));
  if (multi) assert.deepStrictEqual(released, ['A', 'B', 'A', 'B']);
}

async function loggingGate() {
  const context = { sendCatLog() {}, settings: { enableWsjtx: true }, wsjtx: { connected: true } };
  const start = main.indexOf('async function jtcatAutoLog(qso, opts) {');
  const end = main.indexOf('// Shared QSO state machine', start);
  vm.runInNewContext(main.slice(start, end), context);
  // The WSJT-X path stops after _logged is set, so these tests never write logs.
  for (const [patch, manual, allowed] of [
    [{ report: null }, false, false],
    [{ sentReport: null }, false, false],
    [{ phase: 'cq-report' }, false, false],
    [{ phase: 'r+report' }, false, false],
    [{ phase: '73' }, false, true],
    [{ phase: 'cq-rr73' }, false, true],
    [{ phase: 'reply', report: null, sentReport: null }, true, true],
    [{ fd: true, theirExch: '1D EMA' }, false, true],
    [{ fd: true }, false, false],
  ]) {
    const q = { call: 'K3SBP', report: '-05', sentReport: '-10', phase: '73', ...patch };
    await context.jtcatAutoLog(q, { manual });
    assert.strictEqual(!!q._logged, allowed, JSON.stringify({ patch, manual }));
  }
}

function disconnectOwnership() {
  const start = main.indexOf("  remoteServer.on('client-disconnected', () => {");
  const end = main.indexOf('    // Band scope:', start);
  for (const [engine, desktop, otherClient, expected] of [
    [true, false, false, 1],
    [true, true, false, 0],
    [true, false, true, 0],
    [false, false, false, 0],
  ]) {
    let stopped = 0;
    vm.runInNewContext(main.slice(start, end) + '  });', {
      ft8Engine: engine ? {} : null,
      jtcatPopoutWin: desktop ? { isDestroyed: () => false } : null,
      remoteServer: { hasClient: () => otherClient, on: (_event, fn) => fn() },
      haltRemoteJtcatTx: () => stopped++,
    });
    assert.strictEqual(stopped, expected, JSON.stringify({ engine, desktop, otherClient }));
  }
}

function completedExchangeDisarmsUi() {
  const frames = [];
  const engine = { _txEnabled: true, _txActive: false,
    setTxMessage(message) { this.message = message; }, setTxSlot() {} };
  const context = {
    _autoSeqEnabled: () => true,
    ft8Engine: engine, jtcatManager: null,
    remoteJtcatQso: { mode: 'reply', phase: '73', call: 'WK3U',
      myCall: 'N9WLY/VE1', txMsg: '<WK3U> N9WLY/VE1 73',
      _txSentMsg: '<WK3U> N9WLY/VE1 73' },
    remoteServer: { broadcastJtcatQsoState: s => frames.push(s) },
    remoteJtcatSetTxMsg() {}, remoteJtcatOnDone: () => () => {},
    advanceJtcatQso: (q, results, setTx, done) =>
      require('../lib/jtcat-state-machine').advanceJtcatQso(q, results, setTx, done, { engine }),
  };
  const broadcast = main.slice(main.indexOf('function remoteJtcatBroadcastQso() {'),
    main.indexOf('async function remoteJtcatSetTxMsg'));
  const process = main.slice(main.indexOf('function processRemoteJtcatQso(results) {'),
    main.indexOf('function processPopoutJtcatQso'));
  vm.runInNewContext(broadcast + process, context);
  context.processRemoteJtcatQso([]);
  assert.strictEqual(engine._txEnabled, false, 'courtesy transmission completed');
  assert(frames.some(s => s.phase === 'done' && s.txEnabled === false),
    'the phone must receive disarmed state when the engine finishes, without waiting another slot');
}

async function cqPublishesArmedState() {
  const frames = [];
  let cq;
  const engine = { _txEnabled: false, _lastRxSlot: 'odd', _txFreq: 1500,
    setTxFreq() {}, setTxSlot() {}, async setTxMessage() {}, tryImmediateTx() {} };
  const context = {
    ft8Engine: engine, jtcatManager: null, remoteJtcatQso: null,
    jtcatNoteOperatorAtRadio() {}, remoteJtcatMyCall: () => 'N9WLY/VE1',
    remoteJtcatMyGrid: () => 'FN74', jtcatQuietFreq: 1500,
    buildCqTxMsg: () => 'CQ N9WLY/VE1 FN74', settings: {}, console: { log() {} },
    remoteServer: { on: (_event, fn) => { cq = fn; }, hasClient: () => true,
      broadcastJtcatTxStatus() {}, broadcastJtcatQsoState: state => frames.push(state) },
  };
  const broadcast = main.slice(main.indexOf('function remoteJtcatBroadcastQso() {'),
    main.indexOf('function popoutBroadcastQso'));
  const handler = main.slice(main.indexOf("  remoteServer.on('jtcat-call-cq',"),
    main.indexOf("  remoteServer.on('jtcat-reply',"));
  vm.runInNewContext(broadcast + handler, context);
  await cq();
  assert.strictEqual(engine._txEnabled, true);
  assert(frames.length && frames[frames.length - 1].txEnabled === true,
    'the phone must receive armed state after CQ encoding finishes');
}

function stopButton(cachedEnabled) {
  const sent = [];
  let click;
  const context = {
    ft8TxEnabled: cachedEnabled,
    ft8Send: m => sent.push(m),
    ft8TxBtn: { classList: { toggle() {} }, addEventListener: (_event, fn) => { click = fn; } },
  };
  const start = source.indexOf("  ft8TxBtn.addEventListener('click', () => {");
  const end = source.indexOf('\n  // Slot cycle:', start);
  vm.runInNewContext(source.slice(start, end), context);
  click();
  click();
  assert.deepStrictEqual(sent.map(m => m.type), ['jtcat-halt-tx', 'jtcat-halt-tx'],
    'stop must be absolute even after reply/reconnect leaves a stale local TX flag');
}

async function audioStartup(play) {
  const sent = [];
  const track = { enabled: true };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const classes = { add() {}, remove() {}, toggle() {} };
  const context = {
    console: { warn() {}, error() {} },
    ws: { readyState: 1, send: m => sent.push(JSON.parse(m)) }, WebSocket: { OPEN: 1 },
    micReady: false, localAudioStream: null, remoteAudio: null, audioCtx: null,
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    document: { getElementById: () => ({ play }) },
    MediaStream: function () {},
    window: { AudioContext: function () { throw new Error('no Web Audio'); } },
    RTCPeerConnection: function () { this.addTrack = () => {}; },
    _turnIceServers: null, _useStun: false,
    audioBtn: { classList: classes }, audioDot: { classList: classes },
    volBoostBtn: { classList: classes },
    setAudioStatus() {}, showAudioControls() {}, updateSsbPanelVisibility() {},
    startSessionKeepAlive() {}, alert(message) { throw new Error(message); },
  };
  const start = source.indexOf('  async function startAudio() {');
  const end = source.indexOf('\n  // A session that ends for good', start);
  vm.runInNewContext(source.slice(start, end), context);
  const pending = context.startAudio();
  await new Promise(setImmediate);
  assert(sent.some(m => m.type === 'signal' && m.data.type === 'start-audio'),
    'audio negotiation must proceed while play() waits for an empty stream');
  assert.strictEqual(track.enabled, false, 'microphone remains muted by default');
  await pending;
}

(async () => {
  for (const [name, run] of [
    ['stop with stale false flag', () => stopButton(false)],
    ['stop with true flag', () => stopButton(true)],
    ['single-engine backend halt', () => backendStop(false)],
    ['multi-engine backend halt', () => backendStop(true)],
    ['automatic and manual logging', loggingGate],
    ['disconnect respects engine/client ownership', disconnectOwnership],
    ['completed exchange disarms the phone UI', completedExchangeDisarmsUi],
    ['CQ publishes armed state after encoding', cqPublishesArmedState],
    ['audio with pending playback', () => audioStartup(() => new Promise(() => {}))],
    ['audio with autoplay refusal', () => audioStartup(() => Promise.reject(new Error('autoplay denied')))],
    ['audio with playable stream', () => audioStartup(() => Promise.resolve())],
  ]) {
    try { await run(); console.log('PASS:', name); }
    catch (e) { console.error('FAIL:', name, e.message); process.exitCode = 1; }
  }
})();
