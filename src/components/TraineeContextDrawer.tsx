import { BookOpen, ChevronRight, ShieldAlert, X } from 'lucide-react';
import { CaseProfile, ClientResponse, DisclosureLedgerEntry, InterviewTurn, ResponseLanguage } from '../lib/interviewTypes';
import { caseDisplay, observableLabel, t } from '../lib/i18n';

type TraineeContextDrawerProps = {
  caseProfile: CaseProfile;
  latestClientResponse: ClientResponse | null;
  turns: InterviewTurn[];
  open: boolean;
  onClose: () => void;
  uiLanguage: ResponseLanguage;
};

export function TraineeContextDrawer({
  caseProfile,
  latestClientResponse,
  turns,
  open,
  onClose,
  uiLanguage,
}: TraineeContextDrawerProps) {
  const learned = uniqueVisibleEntries(turns.flatMap((turn) => turn.disclosureLedger ?? []));
  const display = caseDisplay(caseProfile, uiLanguage);
  const observable = observableLabel(
    uiLanguage,
    latestClientResponse?.avatarDirective?.affect ?? caseProfile.psychologicalState.emotion,
  );

  return (
    <aside aria-hidden={!open} className={`traineeDrawer ${open ? 'open' : ''}`}>
      <header className="traineeDrawerHeader">
        <div>
          <span>{uiLanguage === 'english' ? 'Case context' : '個案摘要'}</span>
          <strong>{display.issueLabel}</strong>
        </div>
        <button aria-label={uiLanguage === 'english' ? 'Close case context' : '關閉個案摘要'} className="iconButton" onClick={onClose} type="button">
          <X size={17} />
        </button>
      </header>

      <section className="drawerSection">
        <div className="drawerSectionTitle"><BookOpen size={15} />{uiLanguage === 'english' ? 'Referral information' : '轉介資料'}</div>
        <h2>{display.title}</h2>
        <p>{display.context}</p>
      </section>

      <section className="drawerSection">
        <span className="drawerEyebrow">{t(uiLanguage, 'observableState')}</span>
        <strong className="observablePill">{observable}</strong>
        <p>{uiLanguage === 'english' ? 'Use the client’s words and observable reactions to decide what to explore next.' : '請根據服務對象的說話和可觀察反應，決定下一步探索方向。'}</p>
      </section>

      {latestClientResponse?.safetyHint ? (
        <section className="drawerRiskHint">
          <ShieldAlert size={16} />
          <span>{latestClientResponse.safetyHint}</span>
        </section>
      ) : null}

      <section className="drawerSection learnedSection">
        <div className="drawerSectionTitle"><ChevronRight size={15} />{uiLanguage === 'english' ? 'New information learned in this interview' : '訪談中新增了解到的資料'}</div>
        {learned.length ? (
          <div className="learnedFactList">
            {learned.map((entry) => <span key={`${entry.kind}-${entry.id}`}>{entry.label}</span>)}
          </div>
        ) : (
          <p>{uiLanguage === 'english' ? 'No new background information has been disclosed yet.' : '暫時未有在訪談中新增透露的背景資料。'}</p>
        )}
      </section>
    </aside>
  );
}

function uniqueVisibleEntries(entries: DisclosureLedgerEntry[]) {
  const accepted = entries.filter((entry) =>
    entry.traineeVisible
    && ['newly_disclosed', 'client_confirmed'].includes(entry.kind),
  );
  return [...new Map(accepted.map((entry) => [entry.id, entry])).values()];
}
