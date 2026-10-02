import { FormEvent, useEffect, useRef } from 'react';
import { Mic, MicOff, RotateCcw, Send, ShieldAlert, Square } from 'lucide-react';
import { ClientResponse, InterviewTurn, ResponseLanguage } from '../lib/interviewTypes';
import { t } from '../lib/i18n';
import { VoiceStatus } from '../lib/voiceSessionMachine';

type InterviewPanelProps = {
  turns: InterviewTurn[];
  inputValue: string;
  isPending: boolean;
  sessionReady: boolean;
  sessionClosing: boolean;
  sessionEnded: boolean;
  errorMessage: string | null;
  latestClientResponse: ClientResponse | null;
  partialTranscript: string;
  finalTranscript: string;
  voiceEnabled: boolean;
  voiceError: string | null;
  voiceStatus: VoiceStatus;
  onInputChange: (value: string) => void;
  onStartVoice: () => void;
  onStopUtterance: () => void;
  onStopVoice: () => void;
  onSubmit: () => void;
  onRetrySession: () => void;
  uiLanguage: ResponseLanguage;
};

export function InterviewPanel({
  turns,
  inputValue,
  isPending,
  sessionReady,
  sessionClosing,
  sessionEnded,
  errorMessage,
  latestClientResponse,
  partialTranscript,
  finalTranscript,
  voiceEnabled,
  voiceError,
  voiceStatus,
  onInputChange,
  onStartVoice,
  onStopUtterance,
  onStopVoice,
  onSubmit,
  onRetrySession,
  uiLanguage,
}: InterviewPanelProps) {
  const hasRisk = Boolean(latestClientResponse?.safetyHint || latestClientResponse?.riskSignals.length);
  const controlsDisabled = isPending || sessionEnded || sessionClosing || !sessionReady;
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'end', behavior: turns.length > 2 ? 'smooth' : 'auto' });
  }, [isPending, turns]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <section className="interviewPanel" aria-label={t(uiLanguage, 'interviewWorkspace')}>
      <div className="workspaceHeader">
        <div>
          <h2>{t(uiLanguage, 'interviewWorkspace')}</h2>
          <p>{t(uiLanguage, 'interviewDescription')}</p>
          {sessionEnded && <p>{t(uiLanguage, 'sessionEndedNotice')}</p>}
        </div>
        {hasRisk && (
          <div className="riskFlag">
            <ShieldAlert size={16} />
            {t(uiLanguage, 'riskSignal')}
          </div>
        )}
      </div>

      <div className="chatLog">
        {turns.length === 0 ? (
          <div className="emptyState">
            <h3>{t(uiLanguage, 'emptyTitle')}</h3>
            <p>{t(uiLanguage, 'emptyBody')}</p>
          </div>
        ) : (
          turns.map((turn) => (
            <article className={`chatBubble ${turn.speaker}`} key={turn.id}>
              <div className="bubbleMeta">
                <span>{turn.speaker === 'student' ? t(uiLanguage, 'studentWorker') : t(uiLanguage, 'serviceUser')}</span>
                <time>{new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              </div>
              <p>{turn.text}</p>
            </article>
          ))
        )}
        <div ref={chatEndRef} />
      </div>

      {errorMessage && <p className="errorText" role="alert">{errorMessage}</p>}
      {!sessionReady && errorMessage && (
        <button type="button" className="secondaryButton" onClick={onRetrySession}>
          <RotateCcw size={16} />
          {uiLanguage === 'english' ? 'Retry connection' : '重試連線'}
        </button>
      )}
      {voiceError && <p className="errorText">{voiceError}</p>}
      {!sessionReady && !errorMessage && <p role="status">{uiLanguage === 'english' ? 'Preparing the interview...' : '正在準備訪談…'}</p>}

      <form className="messageComposer" onSubmit={handleSubmit}>
        <div className="voiceControls" aria-label={t(uiLanguage, 'voiceModeAria')}>
          <div>
            <span className={`voiceStatus ${voiceStatus}`}>{voiceStatusLabel(voiceStatus, uiLanguage)}</span>
            {(partialTranscript || finalTranscript) && (
              <p className="voiceTranscript">
                {partialTranscript || finalTranscript}
              </p>
            )}
          </div>
          <div className="voiceButtons">
            {voiceEnabled ? (
              <>
                <button type="button" className="secondaryButton" disabled={sessionEnded || sessionClosing} onClick={onStopUtterance}>
                  <Square size={15} />
                  {t(uiLanguage, 'stopUtterance')}
                </button>
                <button type="button" className="secondaryButton" onClick={onStopVoice}>
                  <MicOff size={15} />
                  {t(uiLanguage, 'closeVoice')}
                </button>
              </>
            ) : (
              <button type="button" className="secondaryButton" disabled={controlsDisabled} onClick={onStartVoice}>
                <Mic size={15} />
                {voiceError ? (uiLanguage === 'english' ? 'Reconnect voice' : '重新連接語音') : t(uiLanguage, 'voiceMode')}
              </button>
            )}
          </div>
        </div>
        <textarea
          aria-label={t(uiLanguage, 'studentMessage')}
          disabled={controlsDisabled}
          placeholder={sessionEnded ? t(uiLanguage, 'sessionEndedPlaceholder') : t(uiLanguage, 'messagePlaceholder')}
          rows={3}
          value={inputValue}
          onChange={(event) => onInputChange(event.target.value)}
        />
        <button disabled={controlsDisabled || !inputValue.trim()} type="submit">
          {errorMessage ? <RotateCcw size={16} /> : <Send size={16} />}
          {sessionEnded ? t(uiLanguage, 'ended') : sessionClosing ? t(uiLanguage, 'generatingReport') : isPending ? t(uiLanguage, 'generating') : errorMessage ? (uiLanguage === 'english' ? 'Retry' : '重試') : t(uiLanguage, 'send')}
        </button>
      </form>
    </section>
  );
}

function voiceStatusLabel(status: VoiceStatus, language: ResponseLanguage) {
  const labels: Record<ResponseLanguage, Record<VoiceStatus, string>> = {
    cantonese: {
      idle: '語音未啟動',
      connecting: '正在連接語音服務',
      listening: '正在聆聽',
      user_speaking: '正在收錄你的說話',
      committing: '正在提交這句',
      generating: '生成回覆中',
      avatar_speaking: '服務對象說話中，可直接打斷',
      interrupted: '已打斷，正在聆聽',
      recovering: '語音服務恢復中',
      error: '語音服務錯誤',
    },
    english: {
      idle: 'Voice off',
      connecting: 'Connecting voice service',
      listening: 'Listening',
      user_speaking: 'Recording your speech',
      committing: 'Submitting this turn',
      generating: 'Generating response',
      avatar_speaking: 'Client speaking; you can interrupt',
      interrupted: 'Interrupted; listening',
      recovering: 'Recovering voice service',
      error: 'Voice service error',
    },
  };
  return labels[language][status];
}
