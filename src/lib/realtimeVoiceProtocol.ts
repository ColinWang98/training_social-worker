import type { ClientResponse, LipSyncTimeline } from './interviewTypes';

export const REALTIME_VOICE_PROTOCOL_VERSION = '2';

export type VoiceCaptureBackend = 'audio-worklet' | 'script-processor';
export type VoicePlaybackBackend = 'audio-worklet' | 'html-audio';
export type VoiceDeliveryStatus = 'completed' | 'interrupted' | 'cancelled';

export type RealtimeEventEnvelope = {
  eventId?: string;
  sessionId?: string;
  streamId?: string;
  utteranceId?: string;
  responseId?: string;
  previousResponseId?: string;
  sequence?: number;
  serverTimeMs?: number;
  serverElapsedMs?: number;
  streamRestartCount?: number;
};

export type RealtimeServerMessage = RealtimeEventEnvelope & {
  streamEpoch?: number;
  lateResultsDiscarded?: number;
  capture?: { contextState?: string; lastCaptureAgeMs?: number; lastSentAgeMs?: number | null; bufferedBytes?: number; lastReceivedAgeMs?: number | null; realAudioMs?: number; syntheticSilenceMs?: number };
  type: string;
  transcript?: string;
  studentText?: string;
  reason?: string;
  message?: string;
  recoverable?: boolean;
  response?: ClientResponse;
  mimeType?: string;
  audioBase64?: string;
  audioPcmBase64?: string;
  sampleRate?: number;
  provider?: string;
  voice?: string;
  lipSync?: LipSyncTimeline;
  deliveryStatus?: VoiceDeliveryStatus;
  protocolVersion?: string;
  streaming?: boolean;
  streamingFallback?: boolean;
  realtimeType?: string;
};

export function parseRealtimeServerMessage(data: unknown): RealtimeServerMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data) as RealtimeServerMessage;
    return parsed && typeof parsed.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function createVoiceEvent(type: string, payload: Record<string, unknown> = {}) {
  return JSON.stringify({ type, protocolVersion: REALTIME_VOICE_PROTOCOL_VERSION, ...payload });
}
