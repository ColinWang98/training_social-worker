import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CasePanel } from './components/CasePanel';
import { EvidenceCardsPage } from './components/EvidenceCardsPage';
import { InterviewPanel } from './components/InterviewPanel';
import { VrmStage } from './components/VrmStage';
import { requestClientResponse, requestFinalReview, requestTtsAudio, startSession, TtsResponse } from './lib/apiClient';
import { affectPresets, avatarAssets, DEFAULT_AVATAR_ID, ExpressionWeights } from './lib/avatarConfig';
import { estimateCantoneseSpeechDuration } from './lib/arkitExpressions';
import { applyClientResponse, createTurn } from './lib/caseEngine';
import { caseProfiles, johnDoCase } from './lib/caseProfile';
import { t } from './lib/i18n';
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

const defaultWeights: ExpressionWeights = {
  neutral: 0.12,
};

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

type VoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'user_speaking'
  | 'committing'
  | 'generating'
  | 'avatar_speaking'
  | 'interrupted'
  | 'error';

export type AvatarBlendshapeDebug = {
  modelPath: string;
  arkitAvailable: boolean;
  arkitTargetCount: number;
  activeExpressionProfile: string;
  activeViseme: string;
  activeVisemeChar: string;
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
  reactionWeight: number;
  bridgeProgress: number;
  recentMotionHistory: string[];
  seatedSafety: string;
};

export default function App() {
  const [activePage, setActivePage] = useState(() => (window.location.hash === '#evidence-cards' ? 'evidence-cards' : 'training'));
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
  const [speechLevel, setSpeechLevel] = useState(0);
  const [isShutdownPending, setIsShutdownPending] = useState(false);
  const [visemePlayback, setVisemePlayback] = useState({
    text: '',
    startedAtMs: 0,
    durationMs: 0,
    active: false,
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
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const suppressAutoTtsRef = useRef(false);
  const lastVoiceTranscriptRef = useRef('');
  const lastAsrSeqRef = useRef(0);
  const lastVoiceTtsTextRef = useRef('');
  const bargeInSentRef = useRef(false);
  const voiceStatusRef = useRef<VoiceStatus>(voiceStatus);
  const selectedAvatar = useMemo(
    () => avatarAssets.find((asset) => asset.id === avatarAssetId) ?? avatarAssets[0],
    [avatarAssetId],
  );

  useEffect(() => {
    const handleHashChange = () => {
      setActivePage(window.location.hash === '#evidence-cards' ? 'evidence-cards' : 'training');
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
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
  }, [voiceStatus]);

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
    setVisemePlayback((current) => ({ ...current, active: false }));
    setVoiceStatus((status) => {
      if (status !== 'avatar_speaking') return status;
      return wsRef.current?.readyState === WebSocket.OPEN ? 'listening' : 'idle';
    });
  }, []);

  const playBrowserSpeech = useCallback((response: ClientResponse) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(response.clientText);
    utterance.lang = responseLanguage === 'english' ? 'en-US' : 'zh-HK';
    if (response.affect === 'anxious') {
      utterance.rate = 1.12;
    } else if (response.affect === 'withdrawn' || response.affect === 'sad' || response.affect === 'ashamed') {
      utterance.rate = 0.98;
    } else if (response.affect === 'irritated' || response.affect === 'defensive') {
      utterance.rate = 1.08;
    } else {
      utterance.rate = 1.04;
    }
    utterance.pitch = response.affect === 'withdrawn' || response.affect === 'sad' ? 0.82 : 0.95;
    utterance.onstart = () => {
      const text = response.avatarDirective?.ttsText || response.clientText;
      bargeInSentRef.current = false;
      setVoiceStatus('avatar_speaking');
      setSpeechLevel(0.55);
      setVisemePlayback({
        text,
        startedAtMs: performance.now(),
        durationMs: estimateSpeechDuration(text, responseLanguage),
        active: true,
        lipSync: undefined,
      });
    };
    utterance.onend = () => {
      setSpeechLevel(0);
      setVisemePlayback((current) => ({ ...current, active: false }));
      setVoiceStatus(wsRef.current?.readyState === WebSocket.OPEN ? 'listening' : 'idle');
    };
    utterance.onerror = () => {
      setSpeechLevel(0);
      setVisemePlayback((current) => ({ ...current, active: false }));
      setVoiceStatus(wsRef.current?.readyState === WebSocket.OPEN ? 'listening' : 'idle');
    };
    window.speechSynthesis.speak(utterance);
  }, [responseLanguage]);

  const playTtsAudio = useCallback(async (tts: TtsResponse, text: string) => {
    stopPlayback();
    const blob = base64ToBlob(tts.audioBase64, tts.mimeType);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audioElementRef.current = audio;
    bargeInSentRef.current = false;
    setVoiceStatus('avatar_speaking');

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
          playbackFrameRef.current = requestAnimationFrame(updateLevel);
        };
        updateLevel();
      }
    } catch {
      setSpeechLevel(0.55);
    }

    audio.onplay = () => {
      setVisemePlayback({
        text,
        startedAtMs: performance.now(),
        durationMs: Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : estimateSpeechDuration(text, responseLanguage),
        active: true,
        lipSync: tts.lipSync,
      });
    };
    audio.onended = () => {
      URL.revokeObjectURL(url);
      stopPlayback();
      setVoiceStatus(wsRef.current?.readyState === WebSocket.OPEN ? 'listening' : 'idle');
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      stopPlayback();
      setVoiceStatus(wsRef.current?.readyState === WebSocket.OPEN ? 'listening' : 'idle');
    };
    await audio.play();
  }, [responseLanguage, stopPlayback]);

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
    };
    const nextCase = applyClientResponse(currentCase, clientResponse);
    const nextHistory = [...historyWithStudent, clientTurn];

    setCaseProfile(nextCase);
    setLatestClientResponse(clientResponse);
    setMotionCue(clientResponse.avatarDirective?.motionCue ?? clientResponse.motionCue);
    setTurns(nextHistory);
  }, []);

  const stopVoiceCapture = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
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
    setVoiceStatus((status) => (status === 'avatar_speaking' ? 'idle' : status === 'error' ? 'error' : 'idle'));
  }, []);

  const shutdownServices = useCallback(async () => {
    if (isShutdownPending) return;
    setIsShutdownPending(true);
    setErrorMessage(null);
    stopPlayback();
    stopVoiceCapture();
    setStatusMessage(responseLanguage === 'english' ? 'Stopping local services...' : '正在停止本地服務...');
    try {
      const response = await fetch('/api/shutdown', { method: 'POST' });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
      setStatusMessage(responseLanguage === 'english' ? 'Local services are stopping.' : '本地服務正在停止。');
    } catch (error) {
      setIsShutdownPending(false);
      setStatusMessage(responseLanguage === 'english' ? 'Failed to stop services.' : '停止服務失敗。');
      setErrorMessage(error instanceof Error ? error.message : responseLanguage === 'english' ? 'Failed to stop services.' : '停止服務失敗。');
    }
  }, [isShutdownPending, responseLanguage, stopPlayback, stopVoiceCapture]);

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
    setVoiceStatus('connecting');
    setVoiceError(null);
    setPartialTranscript('');
    setFinalTranscript('');

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
      const processor = context.createScriptProcessor(4096, 1, 1);
      micSourceRef.current = source;
      micProcessorRef.current = processor;

      const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = env?.VITE_VOICE_WS_URL ?? `${wsProtocol}//${window.location.host}/api/voice-stream`;
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
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
        setVoiceStatus('listening');
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
          bargeInSentRef.current = false;
          setVoiceStatus((status) => (
            status === 'generating' || status === 'avatar_speaking' || status === 'committing'
              ? status
              : 'listening'
          ));
          return;
        }
        if (message.type === 'speech_started') {
          if (voiceStatusRef.current !== 'avatar_speaking' && voiceStatusRef.current !== 'generating') {
            setVoiceStatus('user_speaking');
          }
          return;
        }
        if (message.type === 'asr_partial') {
          const transcript = message.transcript ?? '';
          setPartialTranscript(transcript);
          if (
            (voiceStatusRef.current === 'avatar_speaking' || voiceStatusRef.current === 'generating') &&
            !bargeInSentRef.current &&
            shouldTriggerBargeIn(transcript, lastVoiceTtsTextRef.current)
          ) {
            bargeInSentRef.current = true;
            stopPlayback();
            wsRef.current?.send(JSON.stringify({ type: 'barge_in', utteranceId: message.utteranceId }));
            setVoiceStatus('interrupted');
            return;
          }
          setVoiceStatus('user_speaking');
          return;
        }
        if (message.type === 'asr_final') {
          const transcript = message.transcript ?? '';
          lastVoiceTranscriptRef.current = transcript;
          setFinalTranscript(transcript);
          setPartialTranscript('');
          setInputValue(transcript);
          setVoiceStatus('committing');
          return;
        }
        if (message.type === 'utterance_committed') {
          const transcript = message.transcript ?? '';
          if (transcript) {
            lastVoiceTranscriptRef.current = transcript;
            setInputValue(transcript);
          }
          setVoiceStatus('committing');
          return;
        }
        if (message.type === 'barge_in_ack') {
          setVoiceStatus('interrupted');
          return;
        }
        if (message.type === 'avatar_speech_cancelled') {
          stopPlayback();
          setVoiceStatus('listening');
          return;
        }
        if (message.type === 'turn_started') {
          setVoiceStatus('generating');
          return;
        }
        if (message.type === 'client_response') {
          const response = message.response as ClientResponse;
          const studentText = lastVoiceTranscriptRef.current || finalTranscript || partialTranscript || inputValue;
          lastVoiceTtsTextRef.current = response.avatarDirective?.ttsText || response.clientText;
          suppressAutoTtsRef.current = true;
          void commitClientResponse(studentText, response);
          return;
        }
        if (message.type === 'tts_audio') {
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
          setVoiceStatus('error');
        }
      };

      socket.onerror = () => {
        setVoiceError(responseLanguage === 'english' ? 'Voice connection failed. Check that the ADK sidecar is running and Google credentials are configured.' : '語音連線失敗，請確認 ADK sidecar 已啟動並已設定 Google credentials。');
        setVoiceStatus('error');
      };
      socket.onclose = () => {
        setVoiceEnabled(false);
        setVoiceStatus((status) => (status === 'avatar_speaking' ? 'idle' : status === 'error' ? 'error' : 'idle'));
      };

      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleTo16Khz(input, context.sampleRate);
        socket.send(JSON.stringify({
          type: 'audio',
          audioBase64: pcm16ToBase64(downsampled),
        }));
      };
      source.connect(processor);
      const mutedOutput = context.createGain();
      mutedOutput.gain.value = 0;
      processor.connect(mutedOutput);
      mutedOutput.connect(context.destination);
    } catch (error) {
      stopVoiceCapture();
      setVoiceError(error instanceof Error ? error.message : responseLanguage === 'english' ? 'Unable to start the microphone.' : '無法啟動麥克風。');
      setVoiceStatus('error');
    }
  }, [commitClientResponse, finalTranscript, inputValue, isPending, partialTranscript, playTtsAudio, responseLanguage, selectedAvatar.ttsVoice, simulationMethod, stopPlayback, stopVoiceCapture, voiceEnabled]);

  const stopCurrentUtterance = useCallback(() => {
    wsRef.current?.send(JSON.stringify({ type: 'commit_utterance', reason: 'manual' }));
    setVoiceStatus('committing');
  }, []);

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
    setIsFinalReviewPending(false);
    setSessionEnded(false);
    setMotionCue('neutral');
    setSessionId(null);
    setPartialTranscript('');
    setFinalTranscript('');
    setVoiceStatus('idle');
    setVoiceError(null);
  }, [stopPlayback, stopVoiceCapture]);

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

  if (activePage === 'evidence-cards') {
    return (
      <EvidenceCardsPage
        onBack={() => {
          window.location.hash = '';
          setActivePage('training');
        }}
        uiLanguage={responseLanguage}
      />
    );
  }

  return (
    <main className="appShell">
      <section className="avatarColumn" aria-label="Avatar preview">
        <header className="appHeader">
          <div>
            <h1>{t(responseLanguage, 'appTitle')}</h1>
            <p>{t(responseLanguage, 'appSubtitle')}</p>
          </div>
          <div className="headerMeta">
            <div className="headerControl">
              <label htmlFor="avatarAsset">{t(responseLanguage, 'avatarLabel')}</label>
              <select
                id="avatarAsset"
                value={selectedAvatar.id}
                onChange={(event) => {
                  stopPlayback();
                  setAvatarAssetId(event.target.value);
                }}
              >
                {avatarAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="headerControl">
              <span className="headerControlLabel">{t(responseLanguage, 'voiceLabel')}</span>
              <div className="modeSwitch compactModeSwitch" aria-label={t(responseLanguage, 'voiceLabel')}>
                <button
                  type="button"
                  className={responseLanguage === 'cantonese' ? 'active' : ''}
                  onClick={() => setResponseLanguage('cantonese')}
                >
                  粵語
                </button>
                <button
                  type="button"
                  className={responseLanguage === 'english' ? 'active' : ''}
                  onClick={() => setResponseLanguage('english')}
                >
                  English
                </button>
              </div>
            </div>
            <div className="headerActions">
              <button
                type="button"
                className="headerSecondaryButton"
                onClick={() => {
                  window.location.hash = 'evidence-cards';
                  setActivePage('evidence-cards');
                }}
              >
                {t(responseLanguage, 'evidenceCards')}
              </button>
              <button
                type="button"
                className="shutdownButton"
                onClick={shutdownServices}
                disabled={isShutdownPending}
              >
                {isShutdownPending ? t(responseLanguage, 'stopping') : t(responseLanguage, 'stopService')}
              </button>
            </div>
          </div>
        </header>

        <VrmStage
          avatarPath={selectedAvatar.modelPath}
          avatarFallbackPaths={selectedAvatar.fallbackPaths}
          avatarLabel={selectedAvatar.displayName}
          autoBlink={autoBlink}
          expressionWeights={expressionWeights}
          motionIntensity={motionIntensity}
          motionCue={motionCue}
          expressionProfile={latestClientResponse?.avatarDirective?.affect ?? caseProfile.avatarBaseline.baselineMood}
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
          vrmaFile={vrmaFile}
          onStatusChange={handleStatusChange}
        />

        <footer className="appFooter">
          <span>{t(responseLanguage, 'model')}：{selectedAvatar.appAssetPath}</span>
          <span>{t(responseLanguage, 'credit')}：{selectedAvatar.author}；{selectedAvatar.redistribution}</span>
        </footer>
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

      <CasePanel
        caseProfile={caseProfile}
        caseProfiles={caseProfiles}
        evidenceSummary={latestClientResponse?.evidenceSummary ?? null}
        avatarDirective={latestClientResponse?.avatarDirective ?? null}
        realismAssessment={latestClientResponse?.realismAssessment ?? null}
        adaptivePolicySnapshot={latestClientResponse?.adaptivePolicySnapshot ?? null}
        sessionContinuitySnapshot={latestClientResponse?.sessionContinuitySnapshot ?? null}
        contextConsistencyAssessment={latestClientResponse?.contextConsistencyAssessment ?? null}
        profileGroundingSnapshot={latestClientResponse?.profileGroundingSnapshot ?? null}
        pieContextSnapshot={latestClientResponse?.pieContextSnapshot ?? null}
        simulationMethod={simulationMethod}
        retrievalOptions={retrievalOptions}
        simulationStrategySnapshot={latestClientResponse?.simulationStrategySnapshot ?? null}
        safetyFlags={latestClientResponse?.safetyFlags ?? []}
        motionCue={motionCue}
        statusMessage={statusMessage}
        avatarBlendshapeDebug={avatarBlendshapeDebug}
        avatarMotionDebug={avatarMotionDebug}
        postSessionReport={postSessionReport}
        isFinalReviewPending={isFinalReviewPending}
        canEndSession={turns.some((turn) => turn.speaker === 'student') && !sessionEnded}
        safetyHint={latestClientResponse?.safetyHint ?? null}
        onCaseChange={handleCaseChange}
        onEndSession={handleEndSession}
        onSimulationMethodChange={setSimulationMethod}
        onRetrievalOptionsChange={setRetrievalOptions}
        onVrmaFile={setVrmaFile}
        uiLanguage={responseLanguage}
      />
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
