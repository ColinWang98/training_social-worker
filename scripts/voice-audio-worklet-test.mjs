import fs from 'node:fs';
import vm from 'node:vm';

function loadProcessor(path, sampleRate = 48000) {
  let Processor;
  class AudioWorkletProcessor {
    constructor() {
      this.messages = [];
      this.port = {
        onmessage: null,
        postMessage: (message) => this.messages.push(message),
      };
    }
  }
  const context = vm.createContext({
    AudioWorkletProcessor,
    Float32Array,
    Math,
    sampleRate,
    registerProcessor: (_name, value) => { Processor = value; },
  });
  vm.runInContext(fs.readFileSync(path, 'utf8'), context, { filename: path });
  return new Processor();
}

const capture = loadProcessor('public/audio/pcm-capture-worklet.js');
for (let index = 0; index < 15; index += 1) {
  capture.process([[new Float32Array(128)]]);
}
const captureFrame = capture.messages[0];
if (!(captureFrame instanceof Float32Array) || captureFrame.length !== 1920) {
  throw new Error(`Capture frame must be 40ms at 48kHz; got ${captureFrame?.length ?? 'none'} samples.`);
}

const playback = loadProcessor('public/audio/pcm-playback-worklet.js');
playback.port.onmessage({ data: { type: 'start_stream' } });
playback.process([], [[new Float32Array(128)]]);
if (playback.underruns !== 0) {
  throw new Error('Playback counted startup buffering as an underrun before audio began.');
}
playback.port.onmessage({ data: { type: 'enqueue', samples: new Float32Array(256).fill(1).buffer } });
const first = [[new Float32Array(128)]];
const second = [[new Float32Array(128)]];
playback.process([], first);
playback.process([], second);
if (!playback.messages.some((message) => message.type === 'started')) {
  throw new Error('Playback did not report the first consumed audio sample.');
}
if (second[0][0][0] < 0.95) {
  throw new Error('Playback reapplied a fade at a PCM chunk boundary.');
}
playback.process([], [[new Float32Array(128)]]);
if (playback.messages.some((message) => message.type === 'drained')) {
  throw new Error('Streaming playback drained before receiving end_stream.');
}
playback.port.onmessage({ data: { type: 'end_stream' } });
playback.process([], [[new Float32Array(128)]]);
if (!playback.messages.some((message) => message.type === 'drained')) {
  throw new Error('Streaming playback did not drain after end_stream.');
}

console.log('Validated 40ms capture, continuous PCM playback, and explicit streaming drain.');
