import { assign, setup } from 'xstate';

export type VoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'user_speaking'
  | 'committing'
  | 'generating'
  | 'avatar_speaking'
  | 'interrupted'
  | 'recovering'
  | 'error';

export type VoiceSessionEvent =
  | { type: 'START' }
  | { type: 'WS_OPEN' }
  | { type: 'LISTENING_READY'; streamId?: string; reconnectCount?: number }
  | { type: 'SPEECH_START'; utteranceId?: string }
  | { type: 'PARTIAL'; transcript?: string; utteranceId?: string }
  | { type: 'COMMIT_REQUEST'; reason?: string }
  | { type: 'ASR_FINAL'; transcript?: string; utteranceId?: string }
  | { type: 'UTTERANCE_COMMITTED'; transcript?: string; utteranceId?: string; reason?: string }
  | { type: 'TURN_STARTED'; responseId?: string; utteranceId?: string }
  | { type: 'CLIENT_RESPONSE' }
  | { type: 'TTS_PLAY'; responseId?: string }
  | { type: 'TTS_END' }
  | { type: 'BARGE_IN'; responseId?: string }
  | { type: 'BARGE_ACK' }
  | { type: 'AVATAR_CANCELLED' }
  | { type: 'RECOVER' }
  | { type: 'ERROR' }
  | { type: 'STOP' };

export type VoiceSessionContext = {
  streamId: string;
  utteranceId: string;
  responseId: string;
  partialTranscript: string;
  finalTranscript: string;
  commitReason: string;
  reconnectCount: number;
  activePlayback: boolean;
  cancelledResponseIds: string[];
};

const initialContext: VoiceSessionContext = {
  streamId: '',
  utteranceId: '',
  responseId: '',
  partialTranscript: '',
  finalTranscript: '',
  commitReason: '',
  reconnectCount: 0,
  activePlayback: false,
  cancelledResponseIds: [],
};

export const voiceSessionMachine = setup({
  types: {} as {
    context: VoiceSessionContext;
    events: VoiceSessionEvent;
  },
  actions: {
    listeningReady: assign(({ context, event }) => event.type === 'LISTENING_READY' ? {
      streamId: event.streamId ?? context.streamId,
      reconnectCount: event.reconnectCount ?? context.reconnectCount,
    } : {}),
    speechStart: assign(({ context, event }) => event.type === 'SPEECH_START'
      ? { utteranceId: event.utteranceId ?? context.utteranceId }
      : {}),
    partial: assign(({ context, event }) => event.type === 'PARTIAL' ? {
      partialTranscript: event.transcript ?? context.partialTranscript,
      utteranceId: event.utteranceId ?? context.utteranceId,
    } : {}),
    final: assign(({ context, event }) => event.type === 'ASR_FINAL' ? {
      finalTranscript: event.transcript ?? context.finalTranscript,
      partialTranscript: '',
      utteranceId: event.utteranceId ?? context.utteranceId,
    } : {}),
    committed: assign(({ context, event }) => event.type === 'UTTERANCE_COMMITTED' ? {
      finalTranscript: event.transcript ?? context.finalTranscript,
      partialTranscript: '',
      commitReason: event.reason ?? context.commitReason,
      utteranceId: event.utteranceId ?? context.utteranceId,
    } : {}),
    turnStarted: assign(({ context, event }) => event.type === 'TURN_STARTED' ? {
      responseId: event.responseId ?? context.responseId,
      utteranceId: event.utteranceId ?? context.utteranceId,
    } : {}),
    ttsPlay: assign(({ context, event }) => event.type === 'TTS_PLAY' ? {
      activePlayback: true,
      responseId: event.responseId ?? context.responseId,
    } : {}),
    ttsEnd: assign({ activePlayback: false }),
    bargeIn: assign(({ context, event }) => {
      if (event.type !== 'BARGE_IN') return {};
      const responseId = event.responseId ?? context.responseId;
      return {
        activePlayback: false,
        cancelledResponseIds: responseId
          ? [...new Set([...context.cancelledResponseIds, responseId])].slice(-20)
          : context.cancelledResponseIds,
      };
    }),
    commitRequest: assign(({ context, event }) => event.type === 'COMMIT_REQUEST'
      ? { commitReason: event.reason ?? context.commitReason }
      : {}),
    reset: assign(() => ({ ...initialContext })),
  },
}).createMachine({
  id: 'voiceSession',
  context: initialContext,
  on: {
    LISTENING_READY: {
      actions: 'listeningReady',
    },
    SPEECH_START: {
      actions: 'speechStart',
    },
    PARTIAL: {
      actions: 'partial',
    },
    ASR_FINAL: {
      actions: 'final',
    },
    UTTERANCE_COMMITTED: {
      actions: 'committed',
    },
    TURN_STARTED: {
      actions: 'turnStarted',
    },
    TTS_PLAY: {
      actions: 'ttsPlay',
    },
    TTS_END: {
      actions: 'ttsEnd',
    },
    BARGE_IN: {
      actions: 'bargeIn',
    },
    COMMIT_REQUEST: {
      actions: 'commitRequest',
    },
    RECOVER: {
      target: '.recovering',
    },
    STOP: {
      target: '.idle',
      actions: 'reset',
    },
  },
  initial: 'idle',
  states: {
    idle: {
      on: {
        START: 'connecting',
        ERROR: 'error',
      },
    },
    connecting: {
      on: {
        WS_OPEN: 'listening',
        LISTENING_READY: { target: 'listening', actions: 'listeningReady' },
        ERROR: 'error',
      },
    },
    listening: {
      on: {
        SPEECH_START: { target: 'user_speaking', actions: 'speechStart' },
        PARTIAL: { target: 'user_speaking', actions: 'partial' },
        COMMIT_REQUEST: { target: 'committing', actions: 'commitRequest' },
        ASR_FINAL: { target: 'committing', actions: 'final' },
        UTTERANCE_COMMITTED: { target: 'committing', actions: 'committed' },
        TURN_STARTED: { target: 'generating', actions: 'turnStarted' },
        TTS_PLAY: { target: 'avatar_speaking', actions: 'ttsPlay' },
        ERROR: 'error',
      },
    },
    user_speaking: {
      on: {
        PARTIAL: { target: 'user_speaking', actions: 'partial' },
        COMMIT_REQUEST: { target: 'committing', actions: 'commitRequest' },
        ASR_FINAL: { target: 'committing', actions: 'final' },
        UTTERANCE_COMMITTED: { target: 'committing', actions: 'committed' },
        TURN_STARTED: { target: 'generating', actions: 'turnStarted' },
        ERROR: 'error',
      },
    },
    committing: {
      on: {
        TURN_STARTED: { target: 'generating', actions: 'turnStarted' },
        CLIENT_RESPONSE: 'generating',
        TTS_PLAY: { target: 'avatar_speaking', actions: 'ttsPlay' },
        LISTENING_READY: { target: 'listening', actions: 'listeningReady' },
        ERROR: 'error',
      },
    },
    generating: {
      on: {
        CLIENT_RESPONSE: 'generating',
        TTS_PLAY: { target: 'avatar_speaking', actions: 'ttsPlay' },
        SPEECH_START: { target: 'interrupted', actions: 'speechStart' },
        PARTIAL: { target: 'interrupted', actions: 'partial' },
        BARGE_IN: { target: 'interrupted', actions: 'bargeIn' },
        AVATAR_CANCELLED: { target: 'listening', actions: 'ttsEnd' },
        LISTENING_READY: { target: 'listening', actions: 'listeningReady' },
        ERROR: 'error',
      },
    },
    avatar_speaking: {
      on: {
        SPEECH_START: { target: 'interrupted', actions: 'speechStart' },
        PARTIAL: { target: 'interrupted', actions: 'partial' },
        BARGE_IN: { target: 'interrupted', actions: 'bargeIn' },
        BARGE_ACK: 'interrupted',
        TTS_END: { target: 'listening', actions: 'ttsEnd' },
        AVATAR_CANCELLED: { target: 'listening', actions: 'ttsEnd' },
        LISTENING_READY: { target: 'listening', actions: 'listeningReady' },
        ERROR: 'error',
      },
    },
    interrupted: {
      on: {
        BARGE_ACK: 'interrupted',
        PARTIAL: { target: 'interrupted', actions: 'partial' },
        COMMIT_REQUEST: { target: 'committing', actions: 'commitRequest' },
        ASR_FINAL: { target: 'committing', actions: 'final' },
        UTTERANCE_COMMITTED: { target: 'committing', actions: 'committed' },
        TURN_STARTED: { target: 'generating', actions: 'turnStarted' },
        LISTENING_READY: { target: 'listening', actions: 'listeningReady' },
        ERROR: 'error',
      },
    },
    recovering: {
      on: {
        LISTENING_READY: { target: 'listening', actions: 'listeningReady' },
        ERROR: 'error',
      },
    },
    error: {
      on: {
        START: 'connecting',
        RECOVER: 'recovering',
        STOP: 'idle',
      },
    },
  },
});

export function voiceStatusFromSnapshot(value: unknown): VoiceStatus {
  return typeof value === 'string' ? (value as VoiceStatus) : 'idle';
}
