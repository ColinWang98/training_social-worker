import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync('src/lib/realtimeVoiceClient.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
let now = 0;
let id = 0;
const timers = new Map();
class Socket {
  static OPEN = 1;
  readyState = 0;
  bufferedAmount = 0;
  send() {}
  close() { this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
  open() { this.readyState = 1; this.onopen?.(); }
}
class Playback { clear() {} async close() {} }
const module = { exports: {} };
const context = vm.createContext({
  exports: module.exports, module, WebSocket: Socket, performance: { now: () => now },
  Float32Array, Int16Array, Uint8Array, console,
  window: {
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: (key) => timers.delete(key), clearInterval: (key) => timers.delete(key),
  },
  require: (name) => name.includes('realtimeAudioPlayback') ? { RealtimeAudioPlayback: Playback } : {
    createVoiceEvent: (type, data) => JSON.stringify({ type, ...data }),
    parseRealtimeServerMessage: JSON.parse, REALTIME_VOICE_PROTOCOL_VERSION: '2',
  },
});
vm.runInContext(source, context);
const Client = module.exports.RealtimeVoiceClient;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function nextTimer() {
  const [key, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
  timers.delete(key); now = timer.at; timer.fn(); await flush();
}
function make() {
  const events = [];
  const callbacks = Object.fromEntries(['onOpen', 'onClose', 'onError', 'onMessage', 'onSpeechStart', 'onSpeechEnd', 'onVadStatus', 'onCaptureBackend'].map((name) => [name, (...args) => events.push({ name, args })]));
  return { client: new Client('ws://test', callbacks), events };
}
let { client } = make();
let pending = client.connect();
let rejected = assert.rejects(pending, /timed out/);
await nextTimer(); await rejected;
({ client } = make());
pending = client.connect(); rejected = assert.rejects(pending, /closed/);
client.socket.close(); await rejected;
let setup = make(); client = setup.client;
pending = client.connect(); const old = client.socket; old.open(); await pending;
client.socket = new Socket();
old.onmessage({ data: '{"type":"asr_final"}' });
assert.equal(setup.events.filter((e) => e.name === 'onMessage').length, 0);
await client.stop();
setup = make(); client = setup.client;
void client.reconnect(); await flush();
for (let step = 0; !client.stopped && step < 12; step++) await nextTimer();
assert.equal(client.stopped, true, 'Failed connections must terminate after bounded retries');
assert.equal(client.reconnectCount, 3);
setup = make(); client = setup.client;
let resumed = 0;
client.context = { state: 'suspended', resume: async () => { resumed++; }, close: async () => {} };
client.captureStartedAt = now;
now += 2500; client.checkCapture(); assert.equal(resumed, 1);
now += 3000; client.checkCapture(); await flush();
assert.equal(client.stopped, true, 'A dead microphone must leave listening');
assert.ok(setup.events.some((e) => e.name === 'onClose'));
console.log('Passed connection timeout/close, stale socket, three bounded retries and capture watchdog.');
