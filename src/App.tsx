import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CheckCircle2, Mic, ShieldCheck, UserRoundCog } from 'lucide-react';
import { createActor } from 'xstate';
import { PostSessionReportDialog } from './components/CasePanel';
import { InterviewPanel } from './components/InterviewPanel';
import { TraineeContextDrawer } from './components/TraineeContextDrawer';
import { ApiRequestError, AuthSession, requestAuthSession, requestClientResponse, requestErrorMessage, requestFinalReview, requestTtsAudio, resetSession, startSession, TtsResponse } from './lib/apiClient';
import { affectPresets, avatarAssets, DEFAULT_AVATAR_ID, ExpressionWeights } from './lib/avatarConfig';
import { estimateCantoneseSpeechDuration } from './lib/arkitExpressions';
import type { BrowserVadStatus } from './lib/browserVad';
import { applyClientResponse, createTurn } from './lib/caseEngine';
import { displayCase, johnDoCase } from './lib/caseProfile';
import { requestCases } from './lib/apiClient';
import { caseDisplay, observableLabel, t } from './lib/i18n';
import { RealtimeAudioPlayback, type PlaybackCallbacks } from './lib/realtimeAudioPlayback';
import { RealtimeVoiceClient } from './lib/realtimeVoiceClient';
import type { RealtimeServerMessage, VoiceCaptureBackend, VoicePlaybackBackend } from './lib/realtimeVoiceProtocol';
import {
  AffectLabel,
  CaseProfile,
  ClientResponse,
  InterviewTurn,
  LipSyncTimeline,
  MotionCue,
  PostSessionSupervisorReport,
  ResponseLanguage,
  RetrievalOptions,
  SimulationMethod,
} from './lib/interviewTypes';
import { VoiceSessionEvent, VoiceStatus, voiceSessionMachine, voiceStatusFromSnapshot } from './lib/voiceSessionMachine';

const VrmStage = lazy(() => import('./components/VrmStage').then((module) => ({ default: module.VrmStage })));
const EvidenceCardsPage = lazy(() => import('./components/EvidenceCardsPage').then((module) => ({ default: module.EvidenceCardsPage })));
const InstructorConsole = lazy(() => import('./components/InstructorConsole').then((module) => ({ default: module.InstructorConsole })));

type AppRoute = 'training' | 'instructor' | 'evidence';

const defaultWeights: ExpressionWeights = {
  neutral: 0.12,
};

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export type AvatarBlendshapeDebug = {
  capabilities?: import('./lib/morphExpressionController').ExpressionCapabilities;
  modelPath: string;
  arkitAvailable: boolean;
  arkitTargetCount: number;
  activeExpressionProfile: string;
  activeViseme: string;
  activeVisemeChar: string;
  clockSource: 'audio' | 'timer' | 'none';
  visemeElapsedMs: number;
  timelineEndMs: number;
  activeLipProfile: string;
  expressionTemplateId?: string;
  mouthPolicy?: string;
  drivenMouthTargetCount: number;
  mouthWeight: number;
  browWeight: number;
  eyeWeight: number;
};

export type AvatarMotionDebug = {
  motionLanguage: string;
  activeScriptId: string;
  activeVariant: string;
  validationStatus: 'ok' | 'fallback';
  validationIssues: string[];
  keyframeCount: number;
  durationMs: number;
  reactionFamily: string;
  idleMixOnly: boolean;
  idleAccentFamily: string;
  activeIdlePhrase: string;
  motionEnergy: string;
  reactionReason: string;
  expressionPhase: string;
  expressionOverlayWeight: number;
  motionScale: number;
  mixamoClipId?: string;
  mixamoStatus?: string;
  mixamoWeight?: number;
  reactionWeight: number;
  bridgeProgress: number;
  recentMotionHistory: string[];
  seatedSafety: string;
};

export type VoiceTimingDebug = {
  capture?: { contextState?: string; lastCaptureAgeMs?: number; lastSentAgeMs?: number | null; bufferedBytes?: number; lastReceivedAgeMs?: number | null; realAudioMs?: number; syntheticSilenceMs?: number };
  streamEpoch?: number;
  lateResultsDiscarded?: number;
  recoveryReason?: string;
  micStartedAtMs: number;
  connectionOpenMs?: number;
  listeningReadyMs?: number;
  firstPartialMs?: number;
  utteranceFirstPartialMs?: number;
  lastPartialMs?: number;
  speechStartedMs?: number;
  speechEndMs?: number;
  asrFinalMs?: number;
  commitRequestedMs?: number;
  committedMs?: number;
  turnStartedMs?: number;
  clientResponseMs?: number;
  ttsReadyMs?: number;
  audioPlayStartMs?: number;
  lastServerElapsedMs?: number;
  streamRestartCount: number;
  bargeInCount: number;
  lastCommitReason?: string;
  lastTranscriptLength: number;
  streamId?: string;
  utteranceId?: string;
  responseId?: string;
  protocolVersion?: string;
  captureBackend?: VoiceCaptureBackend;
  playbackBackend?: VoicePlaybackBackend;
  playbackUnderruns: number;
  bargeInStopMs?: number;
  streamingTts: boolean;
  degradedReason?: string;
  vadStatus: BrowserVadStatus;
  vadLastEvent?: string;
  voiceState: VoiceStatus;
  stateTransitionLog: string[];
};

const emptyVoiceTiming: VoiceTimingDebug = {
  micStartedAtMs: 0,
  streamRestartCount: 0,
  bargeInCount: 0,
  lastTranscriptLength: 0,
  playbackUnderruns: 0,
  streamingTts: false,
  vadStatus: 'disabled',
  voiceState: 'idle',
  stateTransitionLog: [],
};

export default function App() {
  const [activeRoute, setActiveRoute] = useState<AppRoute>(() => routeFromLocation());
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isContextDrawerOpen, setIsContextDrawerOpen] = useState(false);
  const [isReportDialogOpen, setIsReportDialogOpen] = useState(false);
  const [caseProfile, setCaseProfile] = useState<CaseProfile>(johnDoCase);
  const [caseProfiles, setCaseProfiles] = useState<CaseProfile[]>([]);
  const stateVersionRef = useRef(0);
  const pendingResetSessionIdRef = useRef<string | null>(null);
  const pendingTurnRef = useRef<{ text: string; id: string } | null>(null);
  const submittedRef = useRef(false);
  const reviewSubmittedRef = useRef(false);
  const sessionEpochRef = useRef(0);
  const committedTurnIdsRef = useRef(new Set<string>());
  const [turns, setTurns] = useState<InterviewTurn[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [latestClientResponse, setLatestClientResponse] = useState<ClientResponse | null>(null);
  const [postSessionReport, setPostSessionReport] = useState<PostSessionSupervisorReport | null>(null);
  const [isFinalReviewPending, setIsFinalReviewPending] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [autoBlink] = useState(true);
  const [vrmaFile, setVrmaFile] = useState<File | null>(null);
  const [statusMessage, setStatusMessage] = useState('正在載入 VRM 模型...');
  const [avatarBlendshapeDebug, setAvatarBlendshapeDebug] = useState<AvatarBlendshapeDebug | null>(null);
  const [avatarMotionDebug, setAvatarMotionDebug] = useState<AvatarMotionDebug | null>(null);
  const [motionCue, setMotionCue] = useState<MotionCue>('neutral');
  const [simulationMethod, setSimulationMethod] = useState<SimulationMethod>('social_work_default');
  const [responseLanguage, setResponseLanguage] = useState<ResponseLanguage>('cantonese');
  const [retrievalOptions, setRetrievalOptions] = useState<RetrievalOptions>({ embeddingEnabled: false });
  const [avatarAssetId, setAvatarAssetId] = useState(DEFAULT_AVATAR_ID);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceTiming, setVoiceTiming] = useState<VoiceTimingDebug>(emptyVoiceTiming);
  const [speechLevel, setSpeechLevel] = useState(0);
  const [visemePlayback, setVisemePlayback] = useState({
    text: '',
    startedAtMs: 0,
    durationMs: 0,
    active: false,
    clockSource: 'none' as 'audio' | 'timer' | 'none',
    audioCurrentTimeMs: 0,
    lipSync: undefined as LipSyncTimeline | undefined,
  });
  const caseProfileRef = useRef(caseProfile);
  const turnsRef = useRef(turns);
  const sessionIdRef = useRef(sessionId);
  const retrievalOptionsRef = useRef(retrievalOptions);
  const voiceClientRef = useRef<RealtimeVoiceClient | null>(null);
  const audioPlaybackRef = useRef<RealtimeAudioPlayback | null>(null);
  const activeResponseIdRef = useRef('');
  const bargeInStartedAtRef = useRef(0);
  const suppressAutoTtsRef = useRef(false);
  const lastVoiceTranscriptRef = useRef('');
  const lastAsrSeqRef = useRef(0);
  const lastVoiceTtsTextRef = useRef('');
  const bargeInSentRef = useRef(false);
  const voiceStatusRef = useRef<VoiceStatus>(voiceStatus);
  const voiceActorRef = useRef<ReturnType<typeof createActor<typeof voiceSessionMachine>> | null>(null);
  const voiceTimingStartedAtRef = useRef(0);
  const selectedAvatar = useMemo(
    () => avatarAssets.find((asset) => asset.id === avatarAssetId) ?? avatarAssets[0],
    [avatarAssetId],
  );

  useEffect(() => {
    const handlePopState = () => setActiveRoute(routeFromLocation());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    requestAuthSession()
      .then(setAuthSession)
      .catch((error: Error) => setAuthError(error.message));
  }, []);

  useEffect(() => {
    if (!authSession?.authenticated) return;
    let cancelled = false;
    requestCases()
      .then((profiles) => {
        if (cancelled || profiles.length === 0) return;
        setCaseProfiles(profiles);
        setCaseProfile((current) => profiles.find((profile) => profile.id === current.id) ?? profiles[0]);
      })
      .catch((error: Error) => {
        if (!cancelled) setErrorMessage(error.message);
      });
    return () => { cancelled = true; };
  }, [authSession?.authenticated]);

  const navigate = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    setActiveRoute(routeFromLocation());
  }, []);

  const expressionWeights = useMemo<ExpressionWeights>(
    () => {
      if (!latestClientResponse) return baselineExpressionWeights(caseProfile.avatarBaseline.baselineMood);
      return (latestClientResponse.avatarDirective?.expressionWeights as ExpressionWeights | undefined)
        ?? affectPresets[latestClientResponse.affect]
        ?? baselineExpressionWeights(caseProfile.avatarBaseline.baselineMood);
    },
    [caseProfile.avatarBaseline.baselineMood, latestClientResponse],
  );
  const motionIntensity = latestClientResponse?.avatarDirective?.intensity ?? caseProfile.avatarBaseline.idleIntensity;
  const reactionKey = latestClientResponse?.agentTraceId ?? latestClientResponse?.clientText ?? 'idle';

  useEffect(() => {
    caseProfileRef.current = caseProfile;
  }, [caseProfile]);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    voiceStatusRef.current = voiceStatus;
    setVoiceTiming((current) => ({
      ...current,
      voiceState: voiceStatus,
    }));
  }, [voiceStatus]);

  useEffect(() => {
    const actor = createActor(voiceSessionMachine);
    voiceActorRef.current = actor;
    const subscription = actor.subscribe((snapshot) => {
      const nextStatus = voiceStatusFromSnapshot(snapshot.value);
      voiceStatusRef.current = nextStatus;
      setVoiceStatus(nextStatus);
      setVoiceTiming((current) => ({
        ...current,
        voiceState: nextStatus,
      }));
    });
    actor.start();
    return () => {
      subscription.unsubscribe();
      actor.stop();
      voiceActorRef.current = null;
    };
  }, []);

  const sendVoiceStateEvent = useCallback((event: VoiceSessionEvent | VoiceSessionEvent['type']) => {
    const actor = voiceActorRef.current;
    if (!actor) return;
    const voiceEvent = typeof event === 'string' ? { type: event } as VoiceSessionEvent : event;
    const before = voiceStatusFromSnapshot(actor.getSnapshot().value);
    actor.send(voiceEvent);
    const after = voiceStatusFromSnapshot(actor.getSnapshot().value);
    setVoiceTiming((current) => ({
      ...current,
      voiceState: after,
      stateTransitionLog: [
        ...current.stateTransitionLog,
        before === after ? `${voiceEvent.type}:${after}` : `${before}-${voiceEvent.type}->${after}`,
      ].slice(-8),
    }));
  }, []);

  const setVadStatus = useCallback((status: BrowserVadStatus, detail?: string) => {
    setVoiceTiming((current) => ({
      ...current,
      vadStatus: status,
      vadLastEvent: detail ?? status,
    }));
  }, []);

  useEffect(() => {
    retrievalOptionsRef.current = retrievalOptions;
    voiceClientRef.current?.update('retrieval_options', { retrievalOptions });
  }, [retrievalOptions]);

  useEffect(() => {
    voiceClientRef.current?.update('response_language', { responseLanguage });
  }, [responseLanguage]);

  const voiceElapsedMs = useCallback(() => (
    voiceTimingStartedAtRef.current
      ? Math.round(performance.now() - voiceTimingStartedAtRef.current)
      : 0
  ), []);

  const serverElapsedMs = (message: Record<string, unknown>) => (
    typeof message.serverElapsedMs === 'number' ? Math.round(message.serverElapsedMs) : undefined
  );

  const stopPlayback = useCallback(() => {
    voiceClientRef.current?.clearPlayback();
    audioPlaybackRef.current?.clear('interrupted', false);
    window.speechSynthesis?.cancel();
    setSpeechLevel(0);
    setVisemePlayback((current) => ({
      ...current,
      active: false,
      clockSource: 'none',
      audioCurrentTimeMs: 0,
    }));
    sendVoiceStateEvent('TTS_END');
  }, [sendVoiceStateEvent]);

  const playBrowserSpeech = useCallback((response: ClientResponse) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(response.clientText);
    utterance.lang = responseLanguage === 'english' ? 'en-US' : 'zh-HK';
    const browserVoice = pickBrowserMaleVoice(responseLanguage);
    if (browserVoice) utterance.voice = browserVoice;
    if (response.affect === 'anxious') {
      utterance.rate = 1.12;
    } else if (response.affect === 'withdrawn' || response.affect === 'sad' || response.affect === 'ashamed') {
      utterance.rate = 0.98;
    } else if (response.affect === 'irritated' || response.affect === 'defensive') {
      utterance.rate = 1.08;
    } else {
      utterance.rate = 1.04;
    }
    utterance.pitch = response.affect === 'withdrawn' || response.affect === 'sad' ? 0.72 : 0.84;
    utterance.onstart = () => {
      const text = response.avatarDirective?.ttsText || response.clientText;
      bargeInSentRef.current = false;
      sendVoiceStateEvent('TTS_PLAY');
      setSpeechLevel(0.55);
      setVisemePlayback({
        text,
        startedAtMs: performance.now(),
        durationMs: estimateSpeechDuration(text, responseLanguage),
        active: true,
        clockSource: 'timer',
        audioCurrentTimeMs: 0,
        lipSync: undefined,
      });
    };
    utterance.onend = () => {
      setSpeechLevel(0);
      setVisemePlayback((current) => ({ ...current, active: false, clockSource: 'none', audioCurrentTimeMs: 0 }));
      sendVoiceStateEvent('TTS_END');
    };
    utterance.onerror = () => {
      setSpeechLevel(0);
      setVisemePlayback((current) => ({ ...current, active: false, clockSource: 'none', audioCurrentTimeMs: 0 }));
      sendVoiceStateEvent('TTS_END');
    };
    window.speechSynthesis.speak(utterance);
  }, [responseLanguage, sendVoiceStateEvent]);

  const playTtsAudio = useCallback(async (tts: TtsResponse, text: string) => {
    stopPlayback();
    const voiceClient = voiceClientRef.current;
    const responseId = activeResponseIdRef.current;
    const standalonePlayback = audioPlaybackRef.current ?? new RealtimeAudioPlayback();
    if (!voiceClient) audioPlaybackRef.current = standalonePlayback;
    bargeInSentRef.current = false;
    const callbacks: PlaybackCallbacks = {
      onStart: (backend) => {
        sendVoiceStateEvent({ type: 'TTS_PLAY', responseId: activeResponseIdRef.current });
        setVoiceTiming((current) => ({
          ...current,
          audioPlayStartMs: voiceElapsedMs(),
          playbackBackend: backend,
          streamingTts: false,
        }));
        setVisemePlayback({
          text,
          startedAtMs: performance.now(),
          durationMs: tts.lipSync?.mappedVisemes[tts.lipSync.mappedVisemes.length - 1]?.endMs ?? estimateSpeechDuration(text, responseLanguage),
          active: true,
          clockSource: 'audio',
          audioCurrentTimeMs: 0,
          lipSync: tts.lipSync,
        });
      },
      onClock: (audioCurrentTimeMs, level, underruns) => {
        setSpeechLevel(level);
        setVisemePlayback((current) => current.active ? { ...current, audioCurrentTimeMs } : current);
        setVoiceTiming((current) => ({ ...current, playbackUnderruns: underruns }));
      },
      onEnd: (status) => {
        setSpeechLevel(0);
        setVisemePlayback((current) => ({ ...current, active: false, clockSource: 'none', audioCurrentTimeMs: 0 }));
        sendVoiceStateEvent('TTS_END');
        if (status === 'completed') voiceClient?.completePlayback(responseId);
      },
    };
    if (voiceClient) await voiceClient.playAudio(tts.audioBase64, tts.mimeType, callbacks);
    else await standalonePlayback.playEncoded(tts.audioBase64, tts.mimeType, callbacks);
  }, [responseLanguage, sendVoiceStateEvent, stopPlayback, voiceElapsedMs]);

  const playTtsForResponse = useCallback(async (response: ClientResponse) => {
    const text = response.avatarDirective?.ttsText || response.clientText;
    try {
      const tts = await requestTtsAudio({
        text,
        affect: response.affect,
        voiceStyle: response.avatarDirective?.voiceStyle,
        voice: responseLanguage === 'cantonese' ? selectedAvatar.ttsVoice : undefined,
        language: responseLanguage,
      });
      await playTtsAudio(tts, text);
    } catch {
      playBrowserSpeech(response);
    }
  }, [playBrowserSpeech, playTtsAudio, responseLanguage, selectedAvatar.ttsVoice]);

  useEffect(() => {
    if (!latestClientResponse?.clientText) {
      return;
    }
    if (suppressAutoTtsRef.current) {
      suppressAutoTtsRef.current = false;
      return;
    }
    void playTtsForResponse(latestClientResponse);
    return () => {
      window.speechSynthesis?.cancel();
    };
  }, [latestClientResponse, playTtsForResponse]);

  const handleStatusChange = useCallback((status: {
    message?: string;
    blendshapeDebug?: AvatarBlendshapeDebug;
    motionDebug?: AvatarMotionDebug;
  }) => {
    if (status.message) setStatusMessage(status.message);
    if (status.blendshapeDebug) setAvatarBlendshapeDebug(status.blendshapeDebug);
    if (status.motionDebug) setAvatarMotionDebug(status.motionDebug);
  }, []);

  useEffect(() => {
    if (!caseProfile.id) return;
    let cancelled = false;
    setErrorMessage(null);
    const previousSessionId = sessionIdRef.current ?? pendingResetSessionIdRef.current;
    const openSession = previousSessionId
      ? resetSession({ caseProfile, sessionId: previousSessionId })
      : startSession({ caseProfile });
    openSession
      .then((session) => {
        if (cancelled) return;
        stateVersionRef.current = session.stateVersion;
        sessionIdRef.current = session.sessionId;
        pendingResetSessionIdRef.current = null;
        setSessionId(session.sessionId);
        setCaseProfile(displayCase(session.sessionView));
      })
      .catch((error) => {
        if (!cancelled) {
          setSessionId(null);
          sessionIdRef.current = null;
          setErrorMessage(requestErrorMessage(error, responseLanguage));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [caseProfile.id, sessionAttempt]);

  const commitClientResponse = useCallback(async (studentText: string, clientResponse: ClientResponse, responseId?: string) => {
    if (clientResponse.sessionId && clientResponse.sessionId !== sessionIdRef.current) return;
    if (typeof clientResponse.stateVersion === 'number' && clientResponse.stateVersion < stateVersionRef.current) return;
    const turnId = clientResponse.turnId;
    if (turnId && committedTurnIdsRef.current.has(turnId)) return;
    if (turnId) committedTurnIdsRef.current.add(turnId);
    const currentCase = caseProfileRef.current;
    const currentTurns = turnsRef.current;
    const studentTurn = createTurn('student', studentText);
    const historyWithStudent = [...currentTurns, studentTurn];
    const clientTurn: InterviewTurn = {
      ...createTurn('client', clientResponse.clientText),
      revealedFacts: clientResponse.revealedFacts,
      disclosureLedger: clientResponse.disclosureLedger,
      responseId: responseId ?? clientResponse.responseId,
      deliveryStatus: clientResponse.deliveryStatus ?? 'completed',
    };
    const nextCase = clientResponse.sessionView
      ? displayCase(clientResponse.sessionView)
      : applyClientResponse(currentCase, clientResponse);
    const nextHistory = [...historyWithStudent, clientTurn];

    if (typeof clientResponse.stateVersion === 'number') stateVersionRef.current = clientResponse.stateVersion;
    pendingTurnRef.current = null;
    caseProfileRef.current = nextCase;
    turnsRef.current = nextHistory;
    setCaseProfile(nextCase);
    setLatestClientResponse(clientResponse);
    setMotionCue(clientResponse.avatarDirective?.motionCue ?? clientResponse.motionCue);
    setTurns(nextHistory);
    voiceClientRef.current?.setContext({
      sessionId: sessionIdRef.current,
      caseProfile: nextCase,
      history: nextHistory,
    });
  }, []);

  const clearVoiceCommitTimer = useCallback(() => {
    voiceClientRef.current?.cancelScheduledCommit();
  }, []);

  const sendVoiceCommit = useCallback((reason: string) => {
    if (!voiceClientRef.current?.commit(reason)) return;
    sendVoiceStateEvent({ type: 'COMMIT_REQUEST', reason });
    setVoiceTiming((current) => ({
      ...current,
      commitRequestedMs: voiceElapsedMs(),
      lastCommitReason: reason,
    }));
  }, [sendVoiceStateEvent, voiceElapsedMs]);

  const stopVoiceCapture = useCallback(() => {
    clearVoiceCommitTimer();
    const client = voiceClientRef.current;
    voiceClientRef.current = null;
    if (client) void client.stop();
    setVadStatus('disabled');
    setVoiceEnabled(false);
    setPartialTranscript('');
    sendVoiceStateEvent('STOP');
  }, [clearVoiceCommitTimer, sendVoiceStateEvent, setVadStatus]);

  useEffect(() => {
    return () => {
      stopVoiceCapture();
      stopPlayback();
      void audioPlaybackRef.current?.close();
      audioPlaybackRef.current = null;
      window.speechSynthesis?.cancel();
    };
  }, [stopPlayback, stopVoiceCapture]);

  const startVoiceCapture = useCallback(async () => {
    if (!sessionIdRef.current || reviewSubmittedRef.current) return;
    if (voiceEnabled || isPending) return;
    setVoiceEnabled(true);
    sendVoiceStateEvent('START');
    setVoiceError(null);
    setPartialTranscript('');
    setFinalTranscript('');
    voiceTimingStartedAtRef.current = performance.now();
    setVoiceTiming({
      ...emptyVoiceTiming,
      micStartedAtMs: Math.round(voiceTimingStartedAtRef.current),
      voiceState: 'connecting',
      protocolVersion: '2',
    });

    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = env?.VITE_VOICE_WS_URL ?? `${wsProtocol}//${window.location.host}/api/voice-stream`;
    const utteranceTexts = new Map<string, string>();
    const receivedResponses = new Set<string>();

    const markInterrupted = (responseId?: string) => {
      const id = responseId || activeResponseIdRef.current;
      if (!id) return;
      setTurns((current) => current.map((turn) => (
        turn.responseId === id ? { ...turn, deliveryStatus: 'interrupted' } : turn
      )));
    };

    const handleBargeIn = (utteranceId?: string) => {
      if (bargeInSentRef.current) return;
      bargeInSentRef.current = true;
      bargeInStartedAtRef.current = performance.now();
      stopPlayback();
      voiceClientRef.current?.bargeIn(utteranceId);
      sendVoiceStateEvent({ type: 'BARGE_IN', responseId: activeResponseIdRef.current });
      markInterrupted();
      setVoiceTiming((current) => ({ ...current, bargeInCount: current.bargeInCount + 1 }));
    };

    const handleMessage = (message: RealtimeServerMessage) => {
      const sequence = message.sequence;
      if (typeof sequence === 'number' && sequence <= lastAsrSeqRef.current) return;
      if (typeof sequence === 'number') lastAsrSeqRef.current = sequence;
      if (message.responseId && ['tts_audio', 'tts_stream_started', 'tts_audio_delta', 'tts_audio_done', 'avatar_speech_cancelled', 'response_cancelled', 'error'].includes(message.type)) {
        if (message.responseId !== activeResponseIdRef.current) return;
        if (message.type.startsWith('tts_') && voiceActorRef.current?.getSnapshot().context.cancelledResponseIds.includes(message.responseId)) return;
      }
      if (message.type === 'audio_gap' || message.type === 'recovery_status') {
        sendVoiceStateEvent('RECOVER');
        setVoiceTiming((current) => ({ ...current, recoveryReason: message.reason, streamEpoch: message.streamEpoch }));
        return;
      }
      if (message.type === 'capture_status') {
        setVoiceTiming((current) => ({ ...current, capture: message.capture, streamEpoch: message.streamEpoch, lateResultsDiscarded: message.lateResultsDiscarded }));
        return;
      }
      const commonTiming = {
        lastServerElapsedMs: serverElapsedMs(message) ?? undefined,
        streamId: message.streamId,
        utteranceId: message.utteranceId,
        responseId: message.responseId,
        protocolVersion: message.protocolVersion,
      };

      if (message.type === 'voice_ready' || message.type === 'listening_ready') {
        clearVoiceCommitTimer();
        bargeInSentRef.current = false;
        sendVoiceStateEvent({ type: 'LISTENING_READY', streamId: message.streamId, reconnectCount: message.streamRestartCount });
        setVoiceTiming((current) => ({
          ...current,
          ...definedTiming(commonTiming),
          listeningReadyMs: message.type === 'listening_ready' ? voiceElapsedMs() : current.listeningReadyMs,
          streamRestartCount: message.streamRestartCount ?? current.streamRestartCount,
        }));
        return;
      }
      if (message.type === 'speech_started') {
        setFinalTranscript('');
        sendVoiceStateEvent({ type: 'SPEECH_START', utteranceId: message.utteranceId });
        setVoiceTiming((current) => ({
          ...current,
          speechStartedMs: voiceElapsedMs(),
          speechEndMs: undefined,
          utteranceFirstPartialMs: undefined,
          asrFinalMs: undefined,
          committedMs: undefined,
          turnStartedMs: undefined,
          clientResponseMs: undefined,
          ttsReadyMs: undefined,
          audioPlayStartMs: undefined,
        }));
        return;
      }
      if (message.type === 'asr_partial') {
        const transcript = message.transcript ?? '';
        const statusBeforePartial = voiceStatusRef.current;
        sendVoiceStateEvent({ type: 'PARTIAL', transcript, utteranceId: message.utteranceId });
        setVoiceTiming((current) => {
          const elapsed = voiceElapsedMs();
          return {
            ...current,
            ...definedTiming(commonTiming),
            firstPartialMs: current.firstPartialMs ?? elapsed,
            utteranceFirstPartialMs: current.utteranceFirstPartialMs ?? elapsed,
            lastPartialMs: elapsed,
            streamRestartCount: message.streamRestartCount ?? current.streamRestartCount,
            lastTranscriptLength: transcript.trim().length,
          };
        });
        setPartialTranscript(transcript);
        if (
          (statusBeforePartial === 'avatar_speaking' || statusBeforePartial === 'generating')
          && shouldTriggerBargeIn(transcript, lastVoiceTtsTextRef.current)
        ) {
          handleBargeIn(message.utteranceId);
        }
        return;
      }
      if (message.type === 'asr_final') {
        clearVoiceCommitTimer();
        const transcript = message.transcript ?? '';
        sendVoiceStateEvent({ type: 'ASR_FINAL', transcript, utteranceId: message.utteranceId });
        lastVoiceTranscriptRef.current = transcript;
        setFinalTranscript(transcript);
        setPartialTranscript('');
        setInputValue(transcript);
        setVoiceTiming((current) => ({ ...current, ...definedTiming(commonTiming), asrFinalMs: voiceElapsedMs(), lastTranscriptLength: transcript.trim().length }));
        return;
      }
      if (message.type === 'utterance_committed') {
        clearVoiceCommitTimer();
        const transcript = message.transcript ?? '';
        sendVoiceStateEvent({ type: 'UTTERANCE_COMMITTED', transcript, utteranceId: message.utteranceId, reason: message.reason });
        if (transcript) {
          if (message.utteranceId) utteranceTexts.set(message.utteranceId, transcript);
          lastVoiceTranscriptRef.current = transcript;
          setInputValue(transcript);
        }
        setVoiceTiming((current) => ({ ...current, ...definedTiming(commonTiming), committedMs: voiceElapsedMs(), lastCommitReason: message.reason ?? current.lastCommitReason, lastTranscriptLength: transcript.trim().length }));
        return;
      }
      if (message.type === 'turn_started') {
        clearVoiceCommitTimer();
        activeResponseIdRef.current = message.responseId ?? '';
        sendVoiceStateEvent({ type: 'TURN_STARTED', responseId: message.responseId, utteranceId: message.utteranceId });
        setVoiceTiming((current) => ({ ...current, ...definedTiming(commonTiming), turnStartedMs: voiceElapsedMs() }));
        return;
      }
      if (message.type === 'client_response' && message.response) {
        if (message.responseId && receivedResponses.has(message.responseId)) return;
        const cancelled = voiceActorRef.current?.getSnapshot().context.cancelledResponseIds.includes(message.responseId ?? '') ?? false;
        if (cancelled) return;
        if (message.responseId) receivedResponses.add(message.responseId);
        sendVoiceStateEvent('CLIENT_RESPONSE');
        setVoiceTiming((current) => ({ ...current, ...definedTiming(commonTiming), clientResponseMs: voiceElapsedMs() }));
        const studentText = utteranceTexts.get(message.utteranceId ?? '') ?? lastVoiceTranscriptRef.current;
        if (message.utteranceId) utteranceTexts.delete(message.utteranceId);
        lastVoiceTtsTextRef.current = message.response.avatarDirective?.ttsText || message.response.clientText;
        suppressAutoTtsRef.current = true;
        void commitClientResponse(studentText, message.response, message.responseId);
        return;
      }
      if (message.type === 'tts_audio' && message.audioBase64 && message.mimeType) {
        activeResponseIdRef.current = message.responseId ?? activeResponseIdRef.current;
        setVoiceTiming((current) => ({ ...current, ...definedTiming(commonTiming), ttsReadyMs: voiceElapsedMs(), streamingTts: false }));
        void playTtsAudio({
          mimeType: message.mimeType,
          audioBase64: message.audioBase64,
          provider: message.provider ?? 'google-tts',
          voice: message.voice ?? '',
          lipSync: message.lipSync,
        }, lastVoiceTtsTextRef.current);
        return;
      }
      if (message.type === 'tts_stream_started') {
        activeResponseIdRef.current = message.responseId ?? activeResponseIdRef.current;
        const streamingResponseId = message.responseId;
        void voiceClientRef.current?.startAudioStream(message.sampleRate ?? 24000, {
          onStart: (backend) => {
            sendVoiceStateEvent({ type: 'TTS_PLAY', responseId: message.responseId });
            setVoiceTiming((current) => ({ ...current, ...definedTiming(commonTiming), ttsReadyMs: voiceElapsedMs(), audioPlayStartMs: voiceElapsedMs(), playbackBackend: backend, streamingTts: true }));
            setVisemePlayback({ text: lastVoiceTtsTextRef.current, startedAtMs: performance.now(), durationMs: estimateSpeechDuration(lastVoiceTtsTextRef.current, responseLanguage), active: true, clockSource: 'audio', audioCurrentTimeMs: 0, lipSync: undefined });
          },
          onClock: (audioCurrentTimeMs, level, underruns) => {
            setSpeechLevel(level);
            setVisemePlayback((current) => current.active ? { ...current, audioCurrentTimeMs } : current);
            setVoiceTiming((current) => ({ ...current, playbackUnderruns: underruns }));
          },
          onEnd: (status) => {
            setSpeechLevel(0);
            setVisemePlayback((current) => ({ ...current, active: false, clockSource: 'none', audioCurrentTimeMs: 0 }));
            sendVoiceStateEvent('TTS_END');
            if (status === 'completed') voiceClientRef.current?.completePlayback(streamingResponseId);
          },
        }).catch((error) => {
          setVoiceError(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      if (message.type === 'tts_audio_delta' && message.audioPcmBase64) {
        voiceClientRef.current?.enqueueAudioPcm(message.audioPcmBase64, message.sampleRate);
        return;
      }
      if (message.type === 'tts_audio_done') {
        voiceClientRef.current?.finishAudioStream();
        return;
      }
      if (message.type === 'barge_in_ack') {
        sendVoiceStateEvent('BARGE_ACK');
        markInterrupted(message.responseId);
        setVoiceTiming((current) => ({ ...current, ...definedTiming(commonTiming), bargeInStopMs: bargeInStartedAtRef.current ? Math.round(performance.now() - bargeInStartedAtRef.current) : current.bargeInStopMs }));
        return;
      }
      if (message.type === 'avatar_speech_cancelled' || message.type === 'response_cancelled') {
        stopPlayback();
        markInterrupted(message.responseId);
        sendVoiceStateEvent('AVATAR_CANCELLED');
        return;
      }
      if (message.type === 'error') {
        setVoiceError(message.message ?? (responseLanguage === 'english' ? 'Voice service is temporarily unavailable.' : '語音服務暫時不可用。'));
        setVoiceTiming((current) => ({ ...current, degradedReason: message.message }));
        if (message.recoverable && message.responseId) {
          stopPlayback();
          sendVoiceStateEvent({ type: 'LISTENING_READY', streamId: message.streamId });
        } else {
          sendVoiceStateEvent(message.recoverable ? 'RECOVER' : 'ERROR');
        }
      }
    };

    const client = new RealtimeVoiceClient(wsUrl, {
      onOpen: () => {
        sendVoiceStateEvent('WS_OPEN');
        setVoiceTiming((current) => ({ ...current, connectionOpenMs: voiceElapsedMs() }));
        lastAsrSeqRef.current = 0;
        lastVoiceTranscriptRef.current = '';
      },
      onMessage: handleMessage,
      onClose: () => {
        if (voiceClientRef.current !== client) return;
        setVoiceEnabled(false);
        sendVoiceStateEvent('STOP');
        stopPlayback();
      },
      onError: (error) => {
        setVoiceError(error.message);
        setVoiceTiming((current) => ({ ...current, degradedReason: error.message }));
        sendVoiceStateEvent('RECOVER');
      },
      onSpeechStart: () => {
        setFinalTranscript('');
        const status = voiceStatusRef.current;
        sendVoiceStateEvent('SPEECH_START');
        setVadStatus('ready', 'speech_start');
        setVoiceTiming((current) => ({
          ...current,
          speechStartedMs: voiceElapsedMs(),
          speechEndMs: undefined,
          utteranceFirstPartialMs: undefined,
          asrFinalMs: undefined,
          committedMs: undefined,
          turnStartedMs: undefined,
          clientResponseMs: undefined,
          ttsReadyMs: undefined,
          audioPlayStartMs: undefined,
        }));
        if (status === 'avatar_speaking' || status === 'generating') handleBargeIn('vad-speech-start');
      },
      onSpeechEnd: () => {
        setVadStatus('ready', 'speech_end');
        setVoiceTiming((current) => ({ ...current, speechEndMs: voiceElapsedMs() }));
      },
      onVadStatus: setVadStatus,
      onCaptureBackend: (captureBackend) => setVoiceTiming((current) => ({ ...current, captureBackend })),
    });
    voiceClientRef.current = client;
    try {
      await client.start({
        sessionId: sessionIdRef.current,
        caseProfile: caseProfileRef.current,
        history: turnsRef.current,
        simulationMethod,
        retrievalOptions: retrievalOptionsRef.current as Record<string, unknown>,
        responseLanguage,
        ttsVoice: selectedAvatar.ttsVoice,
        sampleRate: 16000,
      });
    } catch (error) {
      if (voiceClientRef.current === client) voiceClientRef.current = null;
      await client.stop();
      setVoiceEnabled(false);
      setVoiceError(error instanceof Error ? error.message : responseLanguage === 'english' ? 'Unable to start the microphone.' : '無法啟動麥克風。');
      sendVoiceStateEvent('ERROR');
    }
  }, [clearVoiceCommitTimer, commitClientResponse, isPending, playTtsAudio, responseLanguage, selectedAvatar.ttsVoice, sendVoiceStateEvent, setVadStatus, simulationMethod, stopPlayback, voiceElapsedMs, voiceEnabled]);

  const stopCurrentUtterance = useCallback(() => {
    clearVoiceCommitTimer();
    sendVoiceCommit('manual');
  }, [clearVoiceCommitTimer, sendVoiceCommit]);

  const handleCaseChange = useCallback((caseId: string) => {
    const nextCase = caseProfiles.find((profile) => profile.id === caseId);
    if (!nextCase) return;
    if (caseId === caseProfileRef.current.id) return;
    sessionEpochRef.current += 1;
    submittedRef.current = false;
    reviewSubmittedRef.current = false;
    setIsPending(false);
    stopPlayback();
    stopVoiceCapture();
    setCaseProfile(nextCase);
    setTurns([]);
    setInputValue('');
    setErrorMessage(null);
    setLatestClientResponse(null);
    setPostSessionReport(null);
    setIsReportDialogOpen(false);
    setIsContextDrawerOpen(false);
    setIsFinalReviewPending(false);
    setSessionEnded(false);
    setMotionCue('neutral');
    pendingResetSessionIdRef.current = sessionIdRef.current;
    setSessionId(null);
    sessionIdRef.current = null;
    stateVersionRef.current = 0;
    pendingTurnRef.current = null;
    committedTurnIdsRef.current.clear();
    setPartialTranscript('');
    setFinalTranscript('');
    voiceTimingStartedAtRef.current = 0;
    setVoiceTiming(emptyVoiceTiming);
    setVoiceError(null);
    sendVoiceStateEvent('STOP');
  }, [caseProfiles, sendVoiceStateEvent, stopPlayback, stopVoiceCapture]);

  const handleSubmit = useCallback(async () => {
    const studentText = inputValue.trim();
    if (!studentText || !sessionId || submittedRef.current || reviewSubmittedRef.current || isPending || sessionEnded) return;
    const epoch = sessionEpochRef.current;
    submittedRef.current = true;

    setErrorMessage(null);
    setPostSessionReport(null);
    setIsPending(true);
    const pending = pendingTurnRef.current?.text === studentText
      ? pendingTurnRef.current
      : { text: studentText, id: `turn-${crypto.randomUUID()}` };
    pendingTurnRef.current = pending;

    try {
      const clientResponse = await requestClientResponse({
        turnId: pending.id,
        expectedStateVersion: stateVersionRef.current,
        caseProfile,
        studentText,
        history: [...turns, createTurn('student', studentText)],
        sessionId,
        simulationMethod,
        retrievalOptions,
        responseLanguage,
      });
      if (epoch !== sessionEpochRef.current) return;
      await commitClientResponse(studentText, clientResponse);
      setInputValue('');
    } catch (error) {
      if (epoch !== sessionEpochRef.current) return;
      if (error instanceof ApiRequestError && error.code === 'state_version_conflict') {
        try {
          const current = await startSession({ sessionId, caseProfile });
          if (epoch !== sessionEpochRef.current) return;
          stateVersionRef.current = current.stateVersion;
          setCaseProfile(displayCase(current.sessionView));
        } catch { /* Keep the original error and input available for retry. */ }
      }
      if (epoch === sessionEpochRef.current) setErrorMessage(requestErrorMessage(error, responseLanguage));
    } finally {
      if (epoch === sessionEpochRef.current) {
        submittedRef.current = false;
        setIsPending(false);
      }
    }
  }, [caseProfile, commitClientResponse, inputValue, isPending, responseLanguage, retrievalOptions, sessionEnded, sessionId, simulationMethod, turns]);

  const handleEndSession = useCallback(async () => {
    if (turns.length === 0 || !sessionId || submittedRef.current || reviewSubmittedRef.current || isPending || isFinalReviewPending) return;
    const epoch = sessionEpochRef.current;
    reviewSubmittedRef.current = true;
    stopVoiceCapture();
    stopPlayback();
    setErrorMessage(null);
    setIsFinalReviewPending(true);
    try {
      const report = await requestFinalReview({
        caseProfile,
        history: turns,
        sessionId,
        responseLanguage,
      });
      if (epoch !== sessionEpochRef.current) return;
      setPostSessionReport(report);
      setIsReportDialogOpen(true);
      setSessionEnded(true);
      stopVoiceCapture();
      stopPlayback();
    } catch (error) {
      if (epoch === sessionEpochRef.current) setErrorMessage(requestErrorMessage(error, responseLanguage));
    } finally {
      if (epoch === sessionEpochRef.current) {
        reviewSubmittedRef.current = false;
        setIsFinalReviewPending(false);
      }
    }
  }, [caseProfile, isFinalReviewPending, isPending, responseLanguage, sessionId, stopPlayback, stopVoiceCapture, turns]);

  const canEndSession = turns.some((turn) => turn.speaker === 'student') && !sessionEnded;
  const instructorProps = {
    caseProfile,
    caseProfiles,
    evidenceSummary: latestClientResponse?.evidenceSummary ?? null,
    avatarDirective: latestClientResponse?.avatarDirective ?? null,
    realismAssessment: latestClientResponse?.realismAssessment ?? null,
    reactionPlan: latestClientResponse?.reactionPlan,
    reactionPlanValidation: latestClientResponse?.reactionPlanValidation,
    adaptivePolicySnapshot: latestClientResponse?.adaptivePolicySnapshot ?? null,
    sessionContinuitySnapshot: latestClientResponse?.sessionContinuitySnapshot ?? null,
    contextConsistencyAssessment: latestClientResponse?.contextConsistencyAssessment ?? null,
    profileGroundingSnapshot: latestClientResponse?.profileGroundingSnapshot ?? null,
    pieContextSnapshot: latestClientResponse?.pieContextSnapshot ?? null,
    simulationMethod,
    retrievalOptions,
    simulationStrategySnapshot: latestClientResponse?.simulationStrategySnapshot ?? null,
    safetyFlags: latestClientResponse?.safetyFlags ?? [],
    motionCue,
    statusMessage,
    avatarBlendshapeDebug,
    avatarMotionDebug,
    voiceTimingDebug: voiceTiming,
    postSessionReport,
    isFinalReviewPending,
    canEndSession,
    safetyHint: latestClientResponse?.safetyHint ?? null,
    onCaseChange: handleCaseChange,
    onEndSession: handleEndSession,
    onSimulationMethodChange: setSimulationMethod,
    onRetrievalOptionsChange: setRetrievalOptions,
    onVrmaFile: setVrmaFile,
    uiLanguage: responseLanguage,
  };

  if (authError) return <main className="routeState"><ShieldCheck size={28} /><h1>Authentication unavailable</h1><p>{authError}</p></main>;
  if (!authSession) return <main className="routeState"><div className="loadingSpinner" /><p>{responseLanguage === 'english' ? 'Loading workspace…' : '正在載入工作區…'}</p></main>;
  if ((activeRoute === 'instructor' || activeRoute === 'evidence') && authSession.role !== 'instructor') {
    return <main className="routeState"><ShieldCheck size={28} /><h1>403</h1><p>{responseLanguage === 'english' ? 'Instructor access is required.' : '此頁面只供督導／研究者使用。'}</p><button type="button" onClick={() => navigate('/training')}>{responseLanguage === 'english' ? 'Back to training' : '返回訓練'}</button></main>;
  }
  if (activeRoute === 'evidence') return <Suspense fallback={<RouteLoading language={responseLanguage} />}><EvidenceCardsPage onBack={() => navigate('/instructor')} uiLanguage={responseLanguage} /></Suspense>;
  if (activeRoute === 'instructor') return (
    <Suspense fallback={<RouteLoading language={responseLanguage} />}>
      <InstructorConsole
        {...instructorProps}
        avatarAssetId={avatarAssetId}
        onAvatarAssetChange={(avatarId) => { stopPlayback(); setAvatarAssetId(avatarId); }}
        onBackToTraining={() => navigate('/training')}
        onOpenEvidence={() => navigate('/instructor/evidence')}
        username={authSession.username}
      />
    </Suspense>
  );

  return (
    <main className="trainingWorkspace">
      <header className="trainingToolbar">
        <div className="trainingBrand"><span>Social Work Avatar Lab</span><strong>{t(responseLanguage, 'appTitle')}</strong></div>
        <label className="toolbarCaseSelector">
          <span>{t(responseLanguage, 'issueType')}</span>
          <select value={caseProfile.id} onChange={(event) => handleCaseChange(event.target.value)}>
            {caseProfiles.map((profile) => <option key={profile.id} value={profile.id}>{caseDisplay(profile, responseLanguage).issueLabel}</option>)}
          </select>
        </label>
        <div className="toolbarSpacer" />
        <div className="languageControl" role="group" aria-label={t(responseLanguage, 'voiceLabel')}>
          <button className={responseLanguage === 'cantonese' ? 'active' : ''} type="button" onClick={() => setResponseLanguage('cantonese')}>粵語</button>
          <button className={responseLanguage === 'english' ? 'active' : ''} type="button" onClick={() => setResponseLanguage('english')}>English</button>
        </div>
        <div className={`toolbarVoiceState ${voiceStatus}`}><Mic size={14} /><span>{desktopVoiceStatusLabel(voiceStatus, responseLanguage)}</span></div>
        <button className="toolbarAction" type="button" onClick={() => setIsContextDrawerOpen(true)}><BookOpen size={16} />{responseLanguage === 'english' ? 'Case context' : '個案摘要'}</button>
        <button className="toolbarPrimary" disabled={(!canEndSession && !postSessionReport) || isFinalReviewPending} type="button" onClick={() => postSessionReport ? setIsReportDialogOpen(true) : void handleEndSession()}><CheckCircle2 size={16} />{postSessionReport ? t(responseLanguage, 'viewReport') : isFinalReviewPending ? t(responseLanguage, 'generatingReport') : t(responseLanguage, 'endSession')}</button>
        {authSession.role === 'instructor' ? <button className="toolbarIconAction" type="button" title={responseLanguage === 'english' ? 'Instructor Console' : '督導控制台'} onClick={() => navigate('/instructor')}><UserRoundCog size={17} /></button> : null}
        <div className="toolbarAccount"><span>{authSession.username}</span><strong>{authSession.role}</strong></div>
      </header>

      <div className="trainingMain">
        <section className="avatarWorkspace" aria-label="Avatar preview">
          <div className="avatarIdentity"><div><span>{responseLanguage === 'english' ? 'Service user' : '服務對象'}</span><strong>{caseProfile.client.displayName}</strong></div><span>{observableLabel(responseLanguage, latestClientResponse?.avatarDirective?.affect ?? caseProfile.avatarBaseline.baselineMood)}</span></div>
          <Suspense fallback={<div className="avatarLoading"><div className="loadingSpinner" /><span>{responseLanguage === 'english' ? 'Loading avatar…' : '正在載入 Avatar…'}</span></div>}>
            <VrmStage
              debugEnabled={authSession.role === 'instructor'}
              avatarPath={selectedAvatar.modelPath}
              avatarFallbackPaths={selectedAvatar.fallbackPaths}
              avatarLabel={selectedAvatar.displayName}
              autoBlink={autoBlink}
              expressionWeights={expressionWeights}
              motionIntensity={motionIntensity}
              motionCue={motionCue}
              expressionProfile={latestClientResponse?.avatarDirective?.affect ?? caseProfile.avatarBaseline.baselineMood}
              expressionPlan={latestClientResponse?.avatarDirective?.expressionPlan}
              caseBaselineMood={caseProfile.avatarBaseline.baselineMood}
              caseRestingCue={caseProfile.avatarBaseline.restingCue}
              caseGazePattern={caseProfile.avatarBaseline.gazePattern}
              caseIdleIntensity={caseProfile.avatarBaseline.idleIntensity}
              baselineMood={latestClientResponse?.avatarDirective?.baselineMood}
              gesture={latestClientResponse?.avatarDirective?.gesture}
              transitionMs={latestClientResponse?.avatarDirective?.transitionMs}
              holdMs={latestClientResponse?.avatarDirective?.holdMs}
              priority={latestClientResponse?.avatarDirective?.priority}
              performancePlan={latestClientResponse?.avatarDirective?.performancePlan}
              reactionKey={reactionKey}
              speechLevel={speechLevel}
              visemePlayback={visemePlayback}
              lipSyncProfile={selectedAvatar.lipSyncProfile}
              vrmaFile={vrmaFile}
              onStatusChange={handleStatusChange}
            />
          </Suspense>
          <div className="avatarRuntimeState"><span>{selectedAvatar.displayName}</span><span>{statusMessage}</span></div>
        </section>

        <InterviewPanel
          errorMessage={errorMessage}
          inputValue={inputValue}
          isPending={isPending}
          sessionReady={Boolean(sessionId)}
          sessionClosing={isFinalReviewPending}
          onRetrySession={() => setSessionAttempt((attempt) => attempt + 1)}
          sessionEnded={sessionEnded}
          latestClientResponse={latestClientResponse}
          partialTranscript={partialTranscript}
          finalTranscript={finalTranscript}
          voiceEnabled={voiceEnabled}
          voiceError={voiceError}
          voiceStatus={voiceStatus}
          turns={turns}
          onInputChange={setInputValue}
          onStartVoice={startVoiceCapture}
          onStopUtterance={stopCurrentUtterance}
          onStopVoice={stopVoiceCapture}
          onSubmit={handleSubmit}
          uiLanguage={responseLanguage}
        />
      </div>

      {isContextDrawerOpen ? <>
        <button aria-label="Close drawer" className="drawerScrim" type="button" onClick={() => setIsContextDrawerOpen(false)} />
        <TraineeContextDrawer caseProfile={caseProfile} latestClientResponse={latestClientResponse} onClose={() => setIsContextDrawerOpen(false)} open turns={turns} uiLanguage={responseLanguage} />
      </> : null}
      <PostSessionReportDialog detailed={false} onClose={() => setIsReportDialogOpen(false)} open={isReportDialogOpen} report={postSessionReport} uiLanguage={responseLanguage} />
    </main>
  );
}

function baselineExpressionWeights(mood: AffectLabel): ExpressionWeights {
  const preset = affectPresets[mood] ?? defaultWeights;
  return Object.fromEntries(
    Object.entries(preset).map(([name, value]) => [name, Math.min(0.26, value * 0.42)]),
  ) as ExpressionWeights;
}

function estimateSpeechDuration(text: string, language: ResponseLanguage) {
  if (language === 'english') {
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(900, Math.min(14000, wordCount * 360 + 450));
  }
  return estimateCantoneseSpeechDuration(text);
}

function pickBrowserMaleVoice(language: ResponseLanguage) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  const languagePrefix = language === 'english' ? 'en' : 'zh';
  const maleNamePattern = /(male|男|alex|daniel|david|fred|google uk english male|microsoft.*(guy|david|mark|george))/i;
  const femaleNamePattern = /(female|女|samantha|victoria|zira|susan|karen|moira|tessa|mei-jia|ting-ting)/i;
  return voices.find((voice) =>
    voice.lang.toLowerCase().startsWith(languagePrefix) &&
    maleNamePattern.test(voice.name) &&
    !femaleNamePattern.test(voice.name),
  ) ?? null;
}

function shouldTriggerBargeIn(transcript: string, ttsText: string) {
  const normalizedTranscript = normalizeVoiceText(transcript);
  if (normalizedTranscript.length < 2) return false;
  const normalizedTts = normalizeVoiceText(ttsText);
  if (!normalizedTts) return true;
  if (normalizedTts.includes(normalizedTranscript) && normalizedTranscript.length < 8) return false;
  if (normalizedTranscript.includes(normalizedTts.slice(0, Math.min(12, normalizedTts.length)))) return false;
  return true;
}

function normalizeVoiceText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function routeFromLocation(): AppRoute {
  if (window.location.pathname.startsWith('/instructor/evidence')) return 'evidence';
  if (window.location.pathname.startsWith('/instructor')) return 'instructor';
  return 'training';
}

function RouteLoading({ language }: { language: ResponseLanguage }) {
  return <main className="routeState"><div className="loadingSpinner" /><p>{language === 'english' ? 'Loading workspace…' : '正在載入工作區…'}</p></main>;
}

function desktopVoiceStatusLabel(status: VoiceStatus, language: ResponseLanguage) {
  if (language === 'english') {
    if (status === 'idle') return 'Voice off';
    if (status === 'avatar_speaking') return 'Client speaking';
    if (status === 'user_speaking') return 'Listening';
    if (status === 'generating' || status === 'committing') return 'Processing';
    return status.replace(/_/g, ' ');
  }
  if (status === 'idle') return '語音未啟用';
  if (status === 'avatar_speaking') return '服務對象說話中';
  if (status === 'user_speaking' || status === 'listening') return '正在聆聽';
  if (status === 'generating' || status === 'committing') return '正在處理';
  if (status === 'error') return '語音錯誤';
  return '語音連接中';
}

function definedTiming<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
