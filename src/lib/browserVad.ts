import { MicVAD } from '@ricky0123/vad-web';

export type BrowserVadStatus = 'disabled' | 'loading' | 'ready' | 'fallback' | 'error';

export type BrowserVadController = {
  stop: () => Promise<void>;
};

type BrowserVadOptions = {
  stream: MediaStream;
  audioContext: AudioContext;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  onStatus: (status: BrowserVadStatus, detail?: string) => void;
};

export async function startBrowserVad({
  stream,
  audioContext,
  onSpeechStart,
  onSpeechEnd,
  onStatus,
}: BrowserVadOptions): Promise<BrowserVadController | null> {
  if (typeof window === 'undefined') return null;

  onStatus('loading');
  try {
    const vad = await MicVAD.new({
      model: 'v5',
      baseAssetPath: '/vad/',
      onnxWASMBasePath: '/vad/',
      audioContext,
      getStream: async () => stream,
      pauseStream: async () => undefined,
      resumeStream: async () => stream,
      startOnLoad: false,
      processorType: 'auto',
      positiveSpeechThreshold: 0.55,
      negativeSpeechThreshold: 0.36,
      redemptionMs: 520,
      preSpeechPadMs: 180,
      minSpeechMs: 360,
      submitUserSpeechOnPause: false,
      onSpeechRealStart: onSpeechStart,
      onSpeechEnd: () => onSpeechEnd(),
      onVADMisfire: () => onStatus('fallback', 'vad_misfire'),
      onFrameProcessed: () => undefined,
      ortConfig: (ort) => {
        ort.env.logLevel = 'error';
        ort.env.wasm.numThreads = 1;
      },
    });
    await vad.start();
    onStatus('ready');
    return {
      stop: async () => {
        await vad.destroy();
      },
    };
  } catch (error) {
    onStatus('fallback', error instanceof Error ? error.message : String(error));
    return null;
  }
}
