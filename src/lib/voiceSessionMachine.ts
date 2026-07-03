import { createMachine } from 'xstate';

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
  | { type: 'LISTENING_READY' }
  | { type: 'SPEECH_START' }
  | { type: 'PARTIAL' }
  | { type: 'COMMIT_REQUEST' }
  | { type: 'ASR_FINAL' }
  | { type: 'UTTERANCE_COMMITTED' }
  | { type: 'TURN_STARTED' }
  | { type: 'CLIENT_RESPONSE' }
  | { type: 'TTS_PLAY' }
  | { type: 'TTS_END' }
  | { type: 'BARGE_IN' }
  | { type: 'BARGE_ACK' }
  | { type: 'AVATAR_CANCELLED' }
  | { type: 'RECOVER' }
  | { type: 'ERROR' }
  | { type: 'STOP' };

export const voiceSessionMachine = createMachine({
  types: {} as {
    events: VoiceSessionEvent;
  },
  id: 'voiceSession',
  initial: 'idle',
  states: {
    idle: {
      on: {
        START: 'connecting',
        ERROR: 'error',
        STOP: 'idle',
      },
    },
    connecting: {
      on: {
        WS_OPEN: 'listening',
        LISTENING_READY: 'listening',
        ERROR: 'error',
        STOP: 'idle',
      },
    },
    listening: {
      on: {
        SPEECH_START: 'user_speaking',
        PARTIAL: 'user_speaking',
        COMMIT_REQUEST: 'committing',
        ASR_FINAL: 'committing',
        UTTERANCE_COMMITTED: 'committing',
        TURN_STARTED: 'generating',
        TTS_PLAY: 'avatar_speaking',
        ERROR: 'error',
        STOP: 'idle',
      },
    },
    user_speaking: {
      on: {
        PARTIAL: 'user_speaking',
        COMMIT_REQUEST: 'committing',
        ASR_FINAL: 'committing',
        UTTERANCE_COMMITTED: 'committing',
        TURN_STARTED: 'generating',
        ERROR: 'error',
        STOP: 'idle',
      },
    },
    committing: {
      on: {
        TURN_STARTED: 'generating',
        CLIENT_RESPONSE: 'generating',
        TTS_PLAY: 'avatar_speaking',
        LISTENING_READY: 'listening',
        ERROR: 'error',
        STOP: 'idle',
      },
    },
    generating: {
      on: {
        CLIENT_RESPONSE: 'generating',
        TTS_PLAY: 'avatar_speaking',
        SPEECH_START: 'interrupted',
        PARTIAL: 'interrupted',
        BARGE_IN: 'interrupted',
        AVATAR_CANCELLED: 'listening',
        LISTENING_READY: 'listening',
        ERROR: 'error',
        STOP: 'idle',
      },
    },
    avatar_speaking: {
      on: {
        SPEECH_START: 'interrupted',
        PARTIAL: 'interrupted',
        BARGE_IN: 'interrupted',
        BARGE_ACK: 'interrupted',
        TTS_END: 'listening',
        AVATAR_CANCELLED: 'listening',
        LISTENING_READY: 'listening',
        ERROR: 'error',
        STOP: 'idle',
      },
    },
    interrupted: {
      on: {
        BARGE_ACK: 'interrupted',
        PARTIAL: 'interrupted',
        COMMIT_REQUEST: 'committing',
        ASR_FINAL: 'committing',
        UTTERANCE_COMMITTED: 'committing',
        TURN_STARTED: 'generating',
        LISTENING_READY: 'listening',
        ERROR: 'error',
        STOP: 'idle',
      },
    },
    recovering: {
      on: {
        LISTENING_READY: 'listening',
        ERROR: 'error',
        STOP: 'idle',
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
