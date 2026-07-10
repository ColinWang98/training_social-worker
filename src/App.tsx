import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CheckCircle2, Mic, ShieldCheck, UserRoundCog } from 'lucide-react';
import { createActor } from 'xstate';
import { PostSessionReportDialog } from './components/CasePanel';
import { InterviewPanel } from './components/InterviewPanel';
import { TraineeContextDrawer } from './components/TraineeContextDrawer';
import { AuthSession, requestAuthSession, requestClientResponse, requestFinalReview, requestTtsAudio, startSession, TtsResponse } from './lib/apiClient';
import { affectPresets, avatarAssets, DEFAULT_AVATAR_ID, ExpressionWeights } from './lib/avatarConfig';
import { estimateCantoneseSpeechDuration } from './lib/arkitExpressions';
import type { BrowserVadController, BrowserVadStatus } from './lib/browserVad';
import { applyClientResponse, createTurn } from './lib/caseEngine';
import { caseProfiles, johnDoCase } from './lib/caseProfile';
import { caseDisplay, observableLabel, t } from './lib/i18n';
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
  micStartedAtMs: number;
  connectionOpenMs?: number;
  listeningReadyMs?: number;
  firstPartialMs?: number;
  lastPartialMs?: number;
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
  const [turns, setTurns] = useState<InterviewTurn[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isPending, setIsPending] = useState(false);
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
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const playbackFrameRef = useRef<number | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  const micProcessorRef = useRef<AudioNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const browserVadRef = useRef<BrowserVadController | null>(null);
  const suppressAutoTtsRef = useRef(false);
  const lastVoiceTranscriptRef = useRef('');
  const lastAsrSeqRef = useRef(0);
  const lastVoiceTtsTextRef = useRef('');
  const bargeInSentRef = useRef(false);
  const voiceCommitTimerRef = useRef<number | null>(null);
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

  const sendVoiceStateEvent = useCallback((type: VoiceSessionEvent['type']) => {
    const actor = voiceActorRef.current;
    if (!actor) return;
    const before = voiceStatusFromSnapshot(actor.getSnapshot().value);
    actor.send({ type });
    const after = voiceStatusFromSnapshot(actor.getSnapshot().value);
    setVoiceTiming((current) => ({
      ...current,
      voiceState: after,
      stateTransitionLog: [
        ...current.stateTransitionLog,
        before === after ? `${type}:${after}` : `${before}-${type}->${after}`,
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
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'retrieval_options', retrievalOptions }));
    }
  }, [retrievalOptions]);

  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'response_language', responseLanguage }));
    }
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
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.src = '';
      audioElementRef.current = null;
    }
    if (playbackFrameRef.current) {
      cancelAnimationFrame(playbackFrameRef.current);
      playbackFrameRef.current = null;
    }
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
    const blob = base64ToBlob(tts.audioBase64, tts.mimeType);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audioElementRef.current = audio;
    bargeInSentRef.current = false;
    sendVoiceStateEvent('TTS_PLAY');
    let lastVisemeClockUpdate = 0;
    const syncAudioClock = (now: number) => {
      if (now - lastVisemeClockUpdate < 33) return;
      lastVisemeClockUpdate = now;
      const currentTimeMs = Number.isFinite(audio.currentTime) ? audio.currentTime * 1000 : 0;
      setVisemePlayback((current) => {
        if (!current.active || current.clockSource !== 'audio') return current;
        return { ...current, audioCurrentTimeMs: currentTimeMs };
      });
    };
    const updateClockOnly = () => {
      syncAudioClock(performance.now());
      playbackFrameRef.current = requestAnimationFrame(updateClockOnly);
    };

    try {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (AudioContextCtor) {
        const context = playbackContextRef.current ?? new AudioContextCtor();
        playbackContextRef.current = context;
        const source = context.createMediaElementSource(audio);
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyser.connect(context.destination);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const updateLevel = () => {
          analyser.getByteFrequencyData(data);
          const average = data.reduce((sum, value) => sum + value, 0) / Math.max(data.length, 1);
          setSpeechLevel(Math.min(1, Math.max(0, average / 90)));
          syncAudioClock(performance.now());
          playbackFrameRef.current = requestAnimationFrame(updateLevel);
        };
        updateLevel();
      } else {
        updateClockOnly();
      }
    } catch {
      setSpeechLevel(0.55);
      updateClockOnly();
    }

    audio.onplay = () => {
      setVoiceTiming((current) => ({
        ...current,
        audioPlayStartMs: voiceElapsedMs(),
      }));
      setVisemePlayback({
        text,
        startedAtMs: performance.now(),
        durationMs: Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : estimateSpeechDuration(text, responseLanguage),
        active: true,
        clockSource: 'audio',
        audioCurrentTimeMs: Number.isFinite(audio.currentTime) ? audio.currentTime * 1000 : 0,
        lipSync: tts.lipSync,
      });
    };
    audio.onended = () => {
      URL.revokeObjectURL(url);
      stopPlayback();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      stopPlayback();
    };
    await audio.play();
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
    let cancelled = false;
    startSession({ caseProfile })
      .then((session) => {
        if (!cancelled) setSessionId(session.sessionId);
      })
      .catch((error) => {
        if (!cancelled) {
          setSessionId(null);
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'ADK session 建立失敗，請確認 sidecar 已啟動。',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [caseProfile.id]);

  const commitClientResponse = useCallback(async (studentText: string, clientResponse: ClientResponse) => {
    const currentCase = caseProfileRef.current;
    const currentTurns = turnsRef.current;
    const studentTurn = createTurn('student', studentText);
    const historyWithStudent = [...currentTurns, studentTurn];
    const clientTurn: InterviewTurn = {
      ...createTurn('client', clientResponse.clientText),
      revealedFacts: clientResponse.revealedFacts,
      disclosureLedger: clientResponse.disclosureLedger,
    };
    const nextCase = applyClientResponse(currentCase, clientResponse);
    const nextHistory = [...historyWithStudent, clientTurn];

    setCaseProfile(nextCase);
    setLatestClientResponse(clientResponse);
    setMotionCue(clientResponse.avatarDirective?.motionCue ?? clientResponse.motionCue);
    setTurns(nextHistory);
  }, []);

  const clearVoiceCommitTimer = useCallback(() => {
    if (voiceCommitTimerRef.current !== null) {
      window.clearTimeout(voiceCommitTimerRef.current);
      voiceCommitTimerRef.current = null;
    }
  }, []);

  const sendVoiceCommit = useCallback((reason: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    sendVoiceStateEvent('COMMIT_REQUEST');
    setVoiceTiming((current) => ({
      ...current,
      commitRequestedMs: voiceElapsedMs(),
      lastCommitReason: reason,
    }));
    wsRef.current.send(JSON.stringify({ type: 'commit_utterance', reason }));
  }, [sendVoiceStateEvent, voiceElapsedMs]);

  const scheduleVoiceCommit = useCallback((reason: string, delayMs = 760) => {
    clearVoiceCommitTimer();
    voiceCommitTimerRef.current = window.setTimeout(() => {
      voiceCommitTimerRef.current = null;
      const status = voiceStatusRef.current;
      if (status === 'user_speaking' || status === 'interrupted' || status === 'listening') {
        sendVoiceCommit(reason);
      }
    }, delayMs);
  }, [clearVoiceCommitTimer, sendVoiceCommit]);

  const stopVoiceCapture = useCallback(() => {
    clearVoiceCommitTimer();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (browserVadRef.current) {
      void browserVadRef.current.stop();
      browserVadRef.current = null;
    }
    setVadStatus('disabled');
    if (micProcessorRef.current) {
      micProcessorRef.current.disconnect();
      micProcessorRef.current = null;
    }
    if (micSourceRef.current) {
      micSourceRef.current.disconnect();
      micSourceRef.current = null;
    }
    if (micContextRef.current) {
      void micContextRef.current.close();
      micContextRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }
    setVoiceEnabled(false);
    setPartialTranscript('');
    sendVoiceStateEvent('STOP');
  }, [clearVoiceCommitTimer, sendVoiceStateEvent, setVadStatus]);

  useEffect(() => {
    return () => {
      stopVoiceCapture();
      stopPlayback();
      window.speechSynthesis?.cancel();
    };
  }, [stopPlayback, stopVoiceCapture]);

  const startVoiceCapture = useCallback(async () => {
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
      vadStatus: 'disabled',
      voiceState: 'connecting',
    });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error(responseLanguage === 'english' ? 'This browser does not support the Web Audio API.' : '此瀏覽器不支援 Web Audio API。');
      }
      const context = new AudioContextCtor();
      micContextRef.current = context;
      const source = context.createMediaStreamSource(stream);
      micSourceRef.current = source;

      void import('./lib/browserVad').then(({ startBrowserVad }) => startBrowserVad({
        stream,
        audioContext: context,
        onSpeechStart: () => {
          const statusBeforeSpeech = voiceStatusRef.current;
          sendVoiceStateEvent('SPEECH_START');
          setVadStatus('ready', 'speech_start');
          if (
            (statusBeforeSpeech === 'avatar_speaking' || statusBeforeSpeech === 'generating') &&
            !bargeInSentRef.current
          ) {
            bargeInSentRef.current = true;
            stopPlayback();
            wsRef.current?.send(JSON.stringify({ type: 'barge_in', utteranceId: 'vad-speech-start' }));
            sendVoiceStateEvent('BARGE_IN');
            setVoiceTiming((current) => ({
              ...current,
              bargeInCount: current.bargeInCount + 1,
            }));
          }
        },
        onSpeechEnd: () => {
          setVadStatus('ready', 'speech_end');
          scheduleVoiceCommit('vad_speech_end', responseLanguage === 'cantonese' ? 260 : 340);
        },
        onStatus: setVadStatus,
      })).then((controller) => {
        if (!controller) return;
        if (micStreamRef.current !== stream) {
          void controller.stop();
          return;
        }
        browserVadRef.current = controller;
      });

      const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = env?.VITE_VOICE_WS_URL ?? `${wsProtocol}//${window.location.host}/api/voice-stream`;
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        sendVoiceStateEvent('WS_OPEN');
        setVoiceTiming((current) => ({
          ...current,
          connectionOpenMs: voiceElapsedMs(),
        }));
        lastAsrSeqRef.current = 0;
        lastVoiceTranscriptRef.current = '';
        setPartialTranscript('');
        setFinalTranscript('');
        socket.send(JSON.stringify({
          type: 'start',
          sessionId: sessionIdRef.current,
          caseProfile: caseProfileRef.current,
          history: turnsRef.current,
          simulationMethod,
          retrievalOptions: retrievalOptionsRef.current,
          responseLanguage,
          ttsVoice: selectedAvatar.ttsVoice,
          sampleRate: 16000,
        }));
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const asrSeq = typeof message.utteranceSeq === 'number' ? message.utteranceSeq : undefined;
        if (asrSeq !== undefined && asrSeq < lastAsrSeqRef.current) {
          return;
        }
        if (asrSeq !== undefined) {
          lastAsrSeqRef.current = asrSeq;
        }
        if (message.type === 'voice_ready' || message.type === 'listening_ready') {
          clearVoiceCommitTimer();
          bargeInSentRef.current = false;
          sendVoiceStateEvent('LISTENING_READY');
          setVoiceTiming((current) => ({
            ...current,
            listeningReadyMs: message.type === 'listening_ready' ? voiceElapsedMs() : current.listeningReadyMs,
            lastServerElapsedMs: serverElapsedMs(message) ?? current.lastServerElapsedMs,
            streamRestartCount: typeof message.streamRestartCount === 'number' ? message.streamRestartCount : current.streamRestartCount,
          }));
          return;
        }
        if (message.type === 'speech_started') {
          sendVoiceStateEvent('SPEECH_START');
          return;
        }
        if (message.type === 'asr_partial') {
          const transcript = message.transcript ?? '';
          const statusBeforePartial = voiceStatusRef.current;
          sendVoiceStateEvent('PARTIAL');
          setVoiceTiming((current) => {
            const elapsed = voiceElapsedMs();
            return {
              ...current,
              firstPartialMs: current.firstPartialMs ?? elapsed,
              lastPartialMs: elapsed,
              lastServerElapsedMs: serverElapsedMs(message) ?? current.lastServerElapsedMs,
              streamRestartCount: typeof message.streamRestartCount === 'number' ? message.streamRestartCount : current.streamRestartCount,
              lastTranscriptLength: String(transcript).trim().length,
            };
          });
          setPartialTranscript(transcript);
          if (
            (statusBeforePartial === 'avatar_speaking' || statusBeforePartial === 'generating') &&
            !bargeInSentRef.current &&
            shouldTriggerBargeIn(transcript, lastVoiceTtsTextRef.current)
          ) {
            bargeInSentRef.current = true;
            stopPlayback();
            wsRef.current?.send(JSON.stringify({ type: 'barge_in', utteranceId: message.utteranceId }));
            sendVoiceStateEvent('BARGE_IN');
            setVoiceTiming((current) => ({
              ...current,
              bargeInCount: current.bargeInCount + 1,
            }));
            scheduleVoiceCommit('client_silence_after_barge_in', responseLanguage === 'cantonese' ? 620 : 760);
            return;
          }
          if (transcript.trim().length >= 2) {
            scheduleVoiceCommit('client_silence', responseLanguage === 'cantonese' ? 620 : 780);
          }
          return;
        }
        if (message.type === 'asr_final') {
          clearVoiceCommitTimer();
          const transcript = message.transcript ?? '';
          sendVoiceStateEvent('ASR_FINAL');
          setVoiceTiming((current) => ({
            ...current,
            asrFinalMs: voiceElapsedMs(),
            lastServerElapsedMs: serverElapsedMs(message) ?? current.lastServerElapsedMs,
            lastTranscriptLength: String(transcript).trim().length,
          }));
          lastVoiceTranscriptRef.current = transcript;
          setFinalTranscript(transcript);
          setPartialTranscript('');
          setInputValue(transcript);
          return;
        }
        if (message.type === 'utterance_committed') {
          clearVoiceCommitTimer();
          const transcript = message.transcript ?? '';
          sendVoiceStateEvent('UTTERANCE_COMMITTED');
          setVoiceTiming((current) => ({
            ...current,
            committedMs: voiceElapsedMs(),
            lastCommitReason: typeof message.reason === 'string' ? message.reason : current.lastCommitReason,
            lastServerElapsedMs: serverElapsedMs(message) ?? current.lastServerElapsedMs,
            lastTranscriptLength: String(transcript).trim().length,
          }));
          if (transcript) {
            lastVoiceTranscriptRef.current = transcript;
            setInputValue(transcript);
          }
          return;
        }
        if (message.type === 'barge_in_ack') {
          sendVoiceStateEvent('BARGE_ACK');
          setVoiceTiming((current) => ({
            ...current,
            lastServerElapsedMs: serverElapsedMs(message) ?? current.lastServerElapsedMs,
          }));
          return;
        }
        if (message.type === 'avatar_speech_cancelled') {
          stopPlayback();
          sendVoiceStateEvent('AVATAR_CANCELLED');
          return;
        }
        if (message.type === 'turn_started') {
          clearVoiceCommitTimer();
          sendVoiceStateEvent('TURN_STARTED');
          setVoiceTiming((current) => ({
            ...current,
            turnStartedMs: voiceElapsedMs(),
            lastServerElapsedMs: serverElapsedMs(message) ?? current.lastServerElapsedMs,
          }));
          return;
        }
        if (message.type === 'client_response') {
          const response = message.response as ClientResponse;
          sendVoiceStateEvent('CLIENT_RESPONSE');
          setVoiceTiming((current) => ({
            ...current,
            clientResponseMs: voiceElapsedMs(),
            lastServerElapsedMs: serverElapsedMs(message) ?? current.lastServerElapsedMs,
          }));
          const studentText = lastVoiceTranscriptRef.current || finalTranscript || partialTranscript || inputValue;
          lastVoiceTtsTextRef.current = response.avatarDirective?.ttsText || response.clientText;
          suppressAutoTtsRef.current = true;
          void commitClientResponse(studentText, response);
          return;
        }
        if (message.type === 'tts_audio') {
          setVoiceTiming((current) => ({
            ...current,
            ttsReadyMs: voiceElapsedMs(),
            lastServerElapsedMs: serverElapsedMs(message) ?? current.lastServerElapsedMs,
          }));
          void playTtsAudio({
            mimeType: message.mimeType,
            audioBase64: message.audioBase64,
            provider: message.provider,
            voice: message.voice,
            lipSync: message.lipSync,
          }, lastVoiceTtsTextRef.current);
          return;
        }
        if (message.type === 'error') {
          setVoiceError(message.message ?? (responseLanguage === 'english' ? 'Voice service is temporarily unavailable.' : '語音服務暫時不可用。'));
          sendVoiceStateEvent('ERROR');
        }
      };

      socket.onerror = () => {
        setVoiceError(responseLanguage === 'english' ? 'Voice connection failed. Check that the ADK sidecar is running and Google credentials are configured.' : '語音連線失敗，請確認 ADK sidecar 已啟動並已設定 Google credentials。');
        sendVoiceStateEvent('ERROR');
      };
      socket.onclose = () => {
        setVoiceEnabled(false);
        sendVoiceStateEvent('STOP');
      };

      let processor: AudioNode;
      try {
        await context.audioWorklet.addModule('/audio/pcm-capture-worklet.js');
        const worklet = new AudioWorkletNode(context, 'pcm-capture-processor');
        worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const downsampled = downsampleTo16Khz(event.data, context.sampleRate);
          socket.send(downsampled.buffer);
        };
        processor = worklet;
      } catch {
        const scriptProcessor = context.createScriptProcessor(4096, 1, 1);
        scriptProcessor.onaudioprocess = (event) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const input = event.inputBuffer.getChannelData(0);
          const downsampled = downsampleTo16Khz(input, context.sampleRate);
          socket.send(JSON.stringify({ type: 'audio', audioBase64: pcm16ToBase64(downsampled) }));
        };
        processor = scriptProcessor;
      }
      micProcessorRef.current = processor;
      source.connect(processor);
      const mutedOutput = context.createGain();
      mutedOutput.gain.value = 0;
      processor.connect(mutedOutput);
      mutedOutput.connect(context.destination);
    } catch (error) {
      stopVoiceCapture();
      setVoiceError(error instanceof Error ? error.message : responseLanguage === 'english' ? 'Unable to start the microphone.' : '無法啟動麥克風。');
      sendVoiceStateEvent('ERROR');
    }
  }, [clearVoiceCommitTimer, commitClientResponse, finalTranscript, inputValue, isPending, partialTranscript, playTtsAudio, responseLanguage, scheduleVoiceCommit, selectedAvatar.ttsVoice, sendVoiceStateEvent, setVadStatus, simulationMethod, stopPlayback, stopVoiceCapture, voiceElapsedMs, voiceEnabled]);

  const stopCurrentUtterance = useCallback(() => {
    clearVoiceCommitTimer();
    sendVoiceCommit('manual');
  }, [clearVoiceCommitTimer, sendVoiceCommit]);

  const handleCaseChange = useCallback((caseId: string) => {
    const nextCase = caseProfiles.find((profile) => profile.id === caseId);
    if (!nextCase) return;
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
    setSessionId(null);
    setPartialTranscript('');
    setFinalTranscript('');
    voiceTimingStartedAtRef.current = 0;
    setVoiceTiming(emptyVoiceTiming);
    setVoiceError(null);
    sendVoiceStateEvent('STOP');
  }, [sendVoiceStateEvent, stopPlayback, stopVoiceCapture]);

  const handleSubmit = useCallback(async () => {
    const studentText = inputValue.trim();
    if (!studentText || isPending || sessionEnded) return;

    setInputValue('');
    setErrorMessage(null);
    setPostSessionReport(null);
    setIsPending(true);

    try {
      const clientResponse = await requestClientResponse({
        caseProfile,
        studentText,
        history: [...turns, createTurn('student', studentText)],
        sessionId,
        simulationMethod,
        retrievalOptions,
        responseLanguage,
      });
      await commitClientResponse(studentText, clientResponse);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : responseLanguage === 'english'
            ? 'This turn failed. Check the local API or DeepSeek key, then retry.'
            : '本輪生成失敗。請檢查本地 API 或 DeepSeek key 後重試。',
      );
    } finally {
      setIsPending(false);
    }
  }, [caseProfile, commitClientResponse, inputValue, isPending, responseLanguage, retrievalOptions, sessionEnded, sessionId, simulationMethod, turns]);

  const handleEndSession = useCallback(async () => {
    if (turns.length === 0 || isPending || isFinalReviewPending) return;
    setErrorMessage(null);
    setIsFinalReviewPending(true);
    try {
      const report = await requestFinalReview({
        caseProfile,
        history: turns,
        sessionId,
        responseLanguage,
      });
      setPostSessionReport(report);
      setIsReportDialogOpen(true);
      setSessionEnded(true);
      stopVoiceCapture();
      stopPlayback();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : responseLanguage === 'english'
            ? 'Final review generation failed. Check the ADK service or DeepSeek key.'
            : '結束訪談評估生成失敗，請檢查 ADK service 或 DeepSeek key。',
      );
    } finally {
      setIsFinalReviewPending(false);
    }
  }, [caseProfile, isFinalReviewPending, isPending, responseLanguage, sessionId, stopPlayback, stopVoiceCapture, turns]);

  const canEndSession = turns.some((turn) => turn.speaker === 'student') && !sessionEnded;
  const instructorProps = {
    caseProfile,
    caseProfiles,
    evidenceSummary: latestClientResponse?.evidenceSummary ?? null,
    avatarDirective: latestClientResponse?.avatarDirective ?? null,
    realismAssessment: latestClientResponse?.realismAssessment ?? null,
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

function downsampleTo16Khz(input: Float32Array, sourceRate: number) {
  if (sourceRate === 16000) return floatToPcm16(input);
  const ratio = sourceRate / 16000;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    const sample = sum / Math.max(end - start, 1);
    output[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
  }
  return output;
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

function floatToPcm16(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    output[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff;
  }
  return output;
}

function pcm16ToBase64(input: Int16Array) {
  const bytes = new Uint8Array(input.buffer);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}
