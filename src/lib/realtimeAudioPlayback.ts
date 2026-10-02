import type { VoicePlaybackBackend } from './realtimeVoiceProtocol';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export type PlaybackCallbacks = {
  onStart: (backend: VoicePlaybackBackend) => void;
  onClock: (elapsedMs: number, level: number, underruns: number) => void;
  onEnd: (status: 'completed' | 'interrupted' | 'error') => void;
};

export class RealtimeAudioPlayback {
  private context: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private htmlAudio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private callbacks: PlaybackCallbacks | null = null;
  private streamInputRate = 24000;
  private generation = 0;
  private pendingPcm: Array<{ audioPcmBase64: string; sampleRate: number }> = [];
  private pendingStreamEnd = false;

  async playEncoded(audioBase64: string, mimeType: string, callbacks: PlaybackCallbacks) {
    this.clear('interrupted', false);
    const generation = ++this.generation;
    this.callbacks = callbacks;
    try {
      const context = await this.ensureWorklet();
      const bytes = base64ToBytes(audioBase64);
      const decoded = await context.decodeAudioData(bytes.buffer.slice(0));
      if (generation !== this.generation) return;
      const mono = downmix(decoded);
      const samples = resampleFloat32(mono, decoded.sampleRate, context.sampleRate);
      this.enqueue(samples);
    } catch {
      if (generation !== this.generation) return;
      await this.playWithHtmlAudio(audioBase64, mimeType, callbacks, generation);
    }
  }

  async startStream(sampleRate: number, callbacks: PlaybackCallbacks) {
    this.clear('interrupted', false);
    const generation = ++this.generation;
    this.callbacks = callbacks;
    this.streamInputRate = sampleRate || 24000;
    this.pendingPcm = [];
    this.pendingStreamEnd = false;
    await this.ensureWorklet();
    if (generation !== this.generation) return;
    this.worklet?.port.postMessage({ type: 'start_stream' });
    const pending = this.pendingPcm;
    this.pendingPcm = [];
    pending.forEach((item) => this.enqueuePcm16Base64(item.audioPcmBase64, item.sampleRate));
    if (this.pendingStreamEnd) this.finishStream();
  }

  enqueuePcm16Base64(audioPcmBase64: string, sampleRate = this.streamInputRate) {
    if (!this.worklet || !this.context) {
      this.pendingPcm.push({ audioPcmBase64, sampleRate });
      return;
    }
    const bytes = base64ToBytes(audioPcmBase64);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 32768;
    }
    this.enqueue(resampleFloat32(samples, sampleRate, this.context.sampleRate));
  }

  finishStream() {
    if (this.worklet) this.worklet.port.postMessage({ type: 'end_stream' });
    else this.pendingStreamEnd = true;
  }

  clear(status: 'interrupted' | 'error' = 'interrupted', notify = true) {
    this.generation += 1;
    this.pendingPcm = [];
    this.pendingStreamEnd = false;
    this.worklet?.port.postMessage({ type: 'clear' });
    if (this.htmlAudio) {
      this.htmlAudio.pause();
      this.htmlAudio.src = '';
      this.htmlAudio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    const callbacks = this.callbacks;
    this.callbacks = null;
    if (notify && callbacks) callbacks.onEnd(status);
  }

  async close() {
    this.clear('interrupted', false);
    this.worklet?.disconnect();
    this.worklet = null;
    if (this.context) await this.context.close();
    this.context = null;
  }

  private async ensureWorklet() {
    if (this.context && this.worklet) return this.context;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error('Web Audio API is unavailable.');
    const context = this.context ?? new AudioContextCtor();
    if (context.state === 'suspended') await context.resume();
    await context.audioWorklet.addModule('/audio/pcm-playback-worklet.js');
    const worklet = new AudioWorkletNode(context, 'pcm-playback-processor');
    worklet.connect(context.destination);
    worklet.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === 'clock') {
        this.callbacks?.onClock(
          (Number(message.playedSamples) / Math.max(Number(message.sampleRate), 1)) * 1000,
          Number(message.level) || 0,
          Number(message.underruns) || 0,
        );
      } else if (message.type === 'started') {
        this.callbacks?.onStart('audio-worklet');
      } else if (message.type === 'drained') {
        const callbacks = this.callbacks;
        this.callbacks = null;
        callbacks?.onEnd('completed');
      }
    };
    this.context = context;
    this.worklet = worklet;
    return context;
  }

  private enqueue(samples: Float32Array) {
    if (!this.worklet) return;
    this.worklet.port.postMessage({ type: 'enqueue', samples: samples.buffer }, [samples.buffer]);
  }

  private async playWithHtmlAudio(audioBase64: string, mimeType: string, callbacks: PlaybackCallbacks, generation: number) {
    const blob = new Blob([base64ToBytes(audioBase64)], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.objectUrl = url;
    this.htmlAudio = audio;
    const startedAt = performance.now();
    let frame = 0;
    const clock = () => {
      if (generation !== this.generation || this.htmlAudio !== audio) return;
      callbacks.onClock(Number.isFinite(audio.currentTime) ? audio.currentTime * 1000 : performance.now() - startedAt, 0.55, 0);
      frame = requestAnimationFrame(clock);
    };
    audio.onplay = () => {
      callbacks.onStart('html-audio');
      frame = requestAnimationFrame(clock);
    };
    audio.onended = () => {
      cancelAnimationFrame(frame);
      this.htmlAudio = null;
      URL.revokeObjectURL(url);
      this.objectUrl = null;
      this.callbacks = null;
      callbacks.onEnd('completed');
    };
    audio.onerror = () => {
      cancelAnimationFrame(frame);
      this.clear('error');
    };
    await audio.play();
  }
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function downmix(buffer: AudioBuffer) {
  if (buffer.numberOfChannels === 1) return new Float32Array(buffer.getChannelData(0));
  const output = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const input = buffer.getChannelData(channel);
    for (let index = 0; index < output.length; index += 1) output[index] += input[index] / buffer.numberOfChannels;
  }
  return output;
}

function resampleFloat32(input: Float32Array, sourceRate: number, targetRate: number) {
  if (sourceRate === targetRate) return new Float32Array(input);
  const outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const mix = position - left;
    output[index] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}
