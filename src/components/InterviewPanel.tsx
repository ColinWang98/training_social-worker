import { FormEvent } from 'react';
import { Mic, MicOff, Send, ShieldAlert, Square } from 'lucide-react';
import { ClientResponse, InterviewTurn } from '../lib/interviewTypes';

type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'transcribing' | 'recognized' | 'generating' | 'speaking' | 'error';

type InterviewPanelProps = {
  turns: InterviewTurn[];
  inputValue: string;
  isPending: boolean;
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
};

export function InterviewPanel({
  turns,
  inputValue,
  isPending,
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
}: InterviewPanelProps) {
  const hasRisk = Boolean(latestClientResponse?.riskSignals.length);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <section className="interviewPanel" aria-label="訪談工作區">
      <div className="workspaceHeader">
        <div>
          <h2>訪談練習</h2>
          <p>練習建立關係、探索脈絡、風險篩查及安全下一步。</p>
          {sessionEnded && <p>訪談已結束，完整督導報告已移至右側面板。</p>}
        </div>
        {hasRisk && (
          <div className="riskFlag">
            <ShieldAlert size={16} />
            風險訊號
          </div>
        )}
      </div>

      <div className="chatLog">
        {turns.length === 0 ? (
          <div className="emptyState">
            <h3>用平穩的開場開始。</h3>
            <p>可以先問最近發生了甚麼、他想大人明白甚麼，或由一件具體近況慢慢談起。</p>
          </div>
        ) : (
          turns.map((turn) => (
            <article className={`chatBubble ${turn.speaker}`} key={turn.id}>
              <div className="bubbleMeta">
                <span>{turn.speaker === 'student' ? '學生社工' : '服務對象'}</span>
                <time>{new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              </div>
              <p>{turn.text}</p>
              {turn.revealedFacts?.length ? (
                <div className="revealedFacts">已透露：{turn.revealedFacts.join(', ')}</div>
              ) : null}
            </article>
          ))
        )}
      </div>

      {errorMessage && <p className="errorText">{errorMessage}</p>}
      {voiceError && <p className="errorText">{voiceError}</p>}

      <form className="messageComposer" onSubmit={handleSubmit}>
        <div className="voiceControls" aria-label="粵語語音模式">
          <div>
            <span className={`voiceStatus ${voiceStatus}`}>{voiceStatusLabel(voiceStatus)}</span>
            {(partialTranscript || finalTranscript) && (
              <p className="voiceTranscript">
                {finalTranscript || partialTranscript}
              </p>
            )}
          </div>
          <div className="voiceButtons">
            {voiceEnabled ? (
              <>
                <button type="button" className="secondaryButton" disabled={sessionEnded} onClick={onStopUtterance}>
                  <Square size={15} />
                  停止本句
                </button>
                <button type="button" className="secondaryButton" onClick={onStopVoice}>
                  <MicOff size={15} />
                  關閉語音
                </button>
              </>
            ) : (
              <button type="button" className="secondaryButton" disabled={isPending || sessionEnded} onClick={onStartVoice}>
                <Mic size={15} />
                語音模式
              </button>
            )}
          </div>
        </div>
        <textarea
          aria-label="學生社工訊息"
          disabled={isPending || sessionEnded}
          placeholder={sessionEnded ? '訪談已結束。' : '輸入下一句社工訪談提問...'}
          rows={3}
          value={inputValue}
          onChange={(event) => onInputChange(event.target.value)}
        />
        <button disabled={isPending || sessionEnded || !inputValue.trim()} type="submit">
          <Send size={16} />
          {sessionEnded ? '已結束' : isPending ? '生成中' : '送出'}
        </button>
      </form>
    </section>
  );
}

function voiceStatusLabel(status: VoiceStatus) {
  const labels: Record<VoiceStatus, string> = {
    idle: '語音未啟動',
    connecting: '正在連接語音服務',
    listening: '正在聆聽',
    transcribing: '即時轉錄中',
    recognized: '已識別',
    generating: '生成回覆中',
    speaking: '服務對象說話中',
    error: '語音服務錯誤',
  };
  return labels[status];
}
