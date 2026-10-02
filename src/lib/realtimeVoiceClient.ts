import type { BrowserVadStatus } from './browserVad';
import { RealtimeAudioPlayback, type PlaybackCallbacks } from './realtimeAudioPlayback';
import {
  createVoiceEvent,
  parseRealtimeServerMessage,
  REALTIME_VOICE_PROTOCOL_VERSION,
  type RealtimeServerMessage,
  type VoiceCaptureBackend,
} from './realtimeVoiceProtocol';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export type RealtimeVoiceSessionConfig = {
  sessionId: string | null;
  caseProfile: unknown;
  history: unknown[];
  simulationMethod: string;
  retrievalOptions: Record<string, unknown>;
  responseLanguage: string;
  ttsVoice?: string;
  sampleRate?: number;
};

export type RealtimeVoiceClientCallbacks = {
  onOpen: () => void;
  onMessage: (message: RealtimeServerMessage) => void;
  onClose: () => void;
  onError: (error: Error) => void;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  onVadStatus: (status: BrowserVadStatus, detail?: string) => void;
  onCaptureBackend: (backend: VoiceCaptureBackend) => void;
};

export class RealtimeVoiceClient {
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: AudioNode | null = null;
  private vad: { stop: () => Promise<void> } | null = null;
  private stopped = false;
  private reconnectCount = 0;
  private connectedOnce = false;
  private reconnecting = false;
  private config: RealtimeVoiceSessionConfig | null = null;
  private commitTimer: number | null = null;
  private playback = new RealtimeAudioPlayback();
  private watchdog: number | null = null;
  private lastCaptureAt = 0;
  private lastSentAt = 0;
  private stableAudioSince = 0;
  private captureStartedAt = 0;

  constructor(
    private readonly url: string,
    private readonly callbacks: RealtimeVoiceClientCallbacks,
  ) {}

  async start(config: RealtimeVoiceSessionConfig) {
    if (this.socket || this.stream) return;
    this.stopped = false;
    this.config = config;
    await waitForVoiceReadiness();
    if (this.stopped) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (this.stopped) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error('Web Audio API is unavailable.');
    const context = new AudioContextCtor();
    this.context = context;
    if (context.state === 'suspended') await context.resume();
    this.source = context.createMediaStreamSource(stream);
    await this.connect();
    if (this.stopped) return;
    await this.startCapture();
    this.captureStartedAt = performance.now();
    this.watchdog = window.setInterval(() => this.checkCapture(), 1000);
    void this.startVad();
  }

  send(type: string, payload: Record<string, unknown> = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(createVoiceEvent(type, payload));
    return true;
  }

  commit(reason: string) {
    this.cancelScheduledCommit();
    return this.send('commit_utterance', { reason });
  }

  scheduleCommit(reason: string, delayMs: number) {
    this.cancelScheduledCommit();
    this.commitTimer = window.setTimeout(() => {
      this.commitTimer = null;
      this.commit(reason);
    }, delayMs);
  }

  cancelScheduledCommit() {
    if (this.commitTimer !== null) window.clearTimeout(this.commitTimer);
    this.commitTimer = null;
  }

  bargeIn(utteranceId?: string) {
    this.playback.clear('interrupted', false);
    return this.send('barge_in', { utteranceId });
  }

  playAudio(audioBase64: string, mimeType: string, callbacks: PlaybackCallbacks) {
    return this.playback.playEncoded(audioBase64, mimeType, callbacks);
  }

  startAudioStream(sampleRate: number, callbacks: PlaybackCallbacks) {
    return this.playback.startStream(sampleRate, callbacks);
  }

  enqueueAudioPcm(audioPcmBase64: string, sampleRate?: number) {
    this.playback.enqueuePcm16Base64(audioPcmBase64, sampleRate);
  }

  finishAudioStream() {
    this.playback.finishStream();
  }

  clearPlayback() {
    this.playback.clear('interrupted', false);
  }

  completePlayback(responseId?: string) {
    return this.send('playback_completed', { responseId });
  }

  update(type: 'retrieval_options' | 'response_language', payload: Record<string, unknown>) {
    if (type === 'retrieval_options' && payload.retrievalOptions) {
      this.config = this.config ? { ...this.config, retrievalOptions: payload.retrievalOptions as Record<string, unknown> } : this.config;
    } else if (type === 'response_language' && typeof payload.responseLanguage === 'string') {
      this.config = this.config ? { ...this.config, responseLanguage: payload.responseLanguage } : this.config;
    }
    this.send(type, payload);
  }

  setContext(config: Partial<Pick<RealtimeVoiceSessionConfig, 'sessionId' | 'caseProfile' | 'history'>>) {
    if (this.config) this.config = { ...this.config, ...config };
  }

  async stop() {
    this.stopped = true;
    if (this.watchdog !== null) window.clearInterval(this.watchdog);
    this.watchdog = null;
    this.cancelScheduledCommit();
    this.playback.clear('interrupted', false);
    this.send('cancel');
    if (this.vad) await this.vad.stop().catch(() => undefined);
    this.vad = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.processor = null;
    this.source = null;
    this.socket?.close();
    this.socket = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.context) await this.context.close().catch(() => undefined);
    this.context = null;
    await this.playback.close().catch(() => undefined);
  }

  private async connect() {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      let opened = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = window.setTimeout(() => {
        finish(new Error('Voice connection timed out.'));
        socket.close();
      }, 10000);
      socket.onopen = () => {
        if (this.stopped || this.socket !== socket || settled) { socket.close(); return; }
        opened = true;
        this.connectedOnce = true;
        this.stableAudioSince = 0;
        this.callbacks.onOpen();
        socket.send(createVoiceEvent('session.update', {
          ...this.config,
          protocolVersion: REALTIME_VOICE_PROTOCOL_VERSION,
          sampleRate: this.config?.sampleRate ?? 16000,
        }));
        finish();
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket || this.stopped) return;
        const message = parseRealtimeServerMessage(event.data);
        if (message) {
          this.callbacks.onMessage(message);
          if (message.type === 'error' && message.recoverable === false) void this.fail(new Error(message.message || 'Voice recovery failed.'));
        }
      };
      socket.onerror = () => {
        const error = new Error('Voice WebSocket connection failed.');
        if (this.socket !== socket) return;
        finish(error);
        socket.close();
      };
      socket.onclose = () => {
        finish(new Error('Voice WebSocket closed before it was ready.'));
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.stopped) {
          this.callbacks.onClose();
          return;
        }
        if (opened) void this.reconnect();
      };
    });
  }

  private async reconnect() {
    if (this.reconnecting || this.stopped) return;
    if (this.reconnectCount >= 3) {
      await this.fail(new Error('Voice connection could not be recovered. Reconnect voice to try again.'));
      return;
    }
    this.reconnecting = true;
    this.reconnectCount += 1;
    this.callbacks.onError(new Error('Voice connection interrupted. Reconnecting…'));
    await wait(500 * 2 ** (this.reconnectCount - 1));
    if (this.stopped) return;
    try {
      await this.connect();
      this.reconnecting = false;
    } catch {
      this.reconnecting = false;
      if (!this.stopped) void this.reconnect();
    }
  }

  private async fail(error: Error) {
    if (this.stopped) return;
    await this.stop();
    this.callbacks.onError(error);
    this.callbacks.onClose();
  }

  private checkCapture() {
    if (this.stopped) return;
    const now = performance.now();
    const gap = now - (this.lastCaptureAt || this.captureStartedAt);
    const capture = {
      contextState: this.context?.state,
      lastCaptureAgeMs: Math.round(gap),
      lastSentAgeMs: this.lastSentAt ? Math.round(now - this.lastSentAt) : null,
      bufferedBytes: this.socket?.bufferedAmount ?? 0,
    };
    this.send('capture_status', { capture });
    if (gap >= 5000) {
      void this.fail(new Error('Microphone audio stopped. Reconnect voice to resume.'));
    } else if (gap >= 2000 && this.context?.state === 'suspended') {
      void this.context.resume().catch(() => undefined);
    }
  }

  private sendPcm(input: Float32Array, sourceRate: number, legacy = false) {
    const now = performance.now();
    if (now - this.lastCaptureAt > 500) this.stableAudioSince = now;
    this.lastCaptureAt = now;
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > (legacy ? 44000 : 32000)) {
      this.callbacks.onError(new Error('Voice audio fell behind the network. Reconnecting…'));
      this.socket.close();
      return;
    }
    const pcm = downsampleTo16Khz(input, sourceRate);
    this.socket.send(legacy ? createVoiceEvent('audio', { audioBase64: pcm16ToBase64(pcm) }) : pcm.buffer);
    this.lastSentAt = now;
    if (!this.stableAudioSince) this.stableAudioSince = now;
    if (now - this.stableAudioSince >= 10000) this.reconnectCount = 0;
  }

  private async startCapture() {
    if (!this.context || !this.source) return;
    const context = this.context;
    let processor: AudioNode;
    try {
      await context.audioWorklet.addModule('/audio/pcm-capture-worklet.js');
      const worklet = new AudioWorkletNode(context, 'pcm-capture-processor');
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        this.sendPcm(event.data, context.sampleRate);
      };
      processor = worklet;
      this.callbacks.onCaptureBackend('audio-worklet');
    } catch {
      const fallback = context.createScriptProcessor(4096, 1, 1);
      fallback.onaudioprocess = (event) => {
        this.sendPcm(event.inputBuffer.getChannelData(0), context.sampleRate, true);
      };
      processor = fallback;
      this.callbacks.onCaptureBackend('script-processor');
    }
    const mutedOutput = context.createGain();
    mutedOutput.gain.value = 0;
    this.processor = processor;
    this.source.connect(processor);
    processor.connect(mutedOutput);
    mutedOutput.connect(context.destination);
  }

  private async startVad() {
    if (!this.stream || !this.context) return;
    try {
      const { startBrowserVad } = await import('./browserVad');
      this.vad = await startBrowserVad({
        stream: this.stream,
        audioContext: this.context,
        onSpeechStart: () => {
          this.cancelScheduledCommit();
          this.send('speech_start');
          this.callbacks.onSpeechStart();
        },
        onSpeechEnd: () => {
          this.send('speech_end');
          this.callbacks.onSpeechEnd();
        },
        onStatus: this.callbacks.onVadStatus,
      });
    } catch (error) {
      this.callbacks.onVadStatus('fallback', error instanceof Error ? error.message : String(error));
    }
  }
}

function downsampleTo16Khz(input: Float32Array, sourceRate: number) {
  if (sourceRate === 16000) return floatToPcm16(input);
  const ratio = sourceRate / 16000;
  const output = new Int16Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor];
    output[index] = Math.max(-1, Math.min(1, sum / Math.max(end - start, 1))) * 0x7fff;
  }
  return output;
}

function floatToPcm16(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = Math.max(-1, Math.min(1, input[index])) * 0x7fff;
  }
  return output;
}

function pcm16ToBase64(input: Int16Array) {
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForVoiceReadiness(timeoutMs = 15000) {
  const startedAt = performance.now();
  let lastError = '';
  while (performance.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      const health = await response.json().catch(() => null);
      if (response.ok && health?.adk?.googleSttReady) return;
      lastError = health?.adk?.googleSttReady === false
        ? 'Google speech recognition is not ready.'
        : health?.adk?.error || `Voice service returned ${response.status}.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await wait(750);
  }
  throw new Error(lastError || 'Voice service is still starting. Please try again shortly.');
}
