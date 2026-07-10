import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Eye, EyeOff, Search } from 'lucide-react';
import { EvidenceCard, ResponseLanguage } from '../lib/interviewTypes';
import { EvidenceCardListRequest, listEvidenceCards } from '../lib/apiClient';

const pageSize = 40;

const sourceOptions = [
  'annomi',
  'student_mh_en',
  'amod',
  'therapytalk',
  'addiction_sft',
  'esconv',
  'counsel_chat',
  'multilingual_therapy',
  'empathetic_dialogues',
];

const qualityOptions = ['approved', 'review', 'reject'];
const clientGroupOptions = ['student', 'adult', 'substance_use', 'depression', 'anxiety', 'trauma'];
const affectOptions = ['neutral', 'defensive', 'ashamed', 'anxious', 'reflective', 'withdrawn', 'irritated', 'sad'];

type EvidenceCardsPageProps = {
  onBack: () => void;
  uiLanguage: ResponseLanguage;
};

export function EvidenceCardsPage({ onBack, uiLanguage }: EvidenceCardsPageProps) {
  const [cards, setCards] = useState<EvidenceCard[]>([]);
  const [total, setTotal] = useState(0);
  const [backend, setBackend] = useState('loading');
  const [offset, setOffset] = useState(0);
  const [source, setSource] = useState('');
  const [quality, setQuality] = useState('approved');
  const [clientGroup, setClientGroup] = useState('');
  const [affect, setAffect] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [appliedTag, setAppliedTag] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [privateReview, setPrivateReview] = useState(false);

  const request = useMemo<EvidenceCardListRequest>(
    () => ({
      search: appliedSearch,
      tag: appliedTag,
      source,
      quality,
      clientGroup,
      affect,
      limit: pageSize,
      offset,
    }),
    [affect, appliedSearch, appliedTag, clientGroup, offset, quality, source],
  );

  useEffect(() => {
    let ignore = false;
    setIsLoading(true);
    setErrorMessage(null);
    listEvidenceCards(request)
      .then((response) => {
        if (ignore) return;
        setCards(response.cards);
        setTotal(response.total);
        setBackend(response.backend);
        setSelectedCardId((current) => response.cards.some((card) => card.id === current) ? current : response.cards[0]?.id ?? null);
      })
      .catch((error: Error) => {
        if (ignore) return;
        setCards([]);
        setTotal(0);
        setErrorMessage(error.message);
      })
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [request]);

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + pageSize, total);
  const canGoBack = offset > 0;
  const canGoForward = offset + pageSize < total;

  const handleFilterSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setOffset(0);
    setAppliedSearch(searchDraft.trim());
    setAppliedTag(tagDraft.trim());
  };

  const resetFilters = () => {
    setOffset(0);
    setSource('');
    setQuality('approved');
    setClientGroup('');
    setAffect('');
    setSearchDraft('');
    setTagDraft('');
    setAppliedSearch('');
    setAppliedTag('');
  };
  const selectedCard = cards.find((card) => card.id === selectedCardId) ?? null;

  return (
    <main className="evidencePage">
      <header className="evidencePageHeader">
        <div>
          <button className="backButton" type="button" onClick={onBack}>
            <ArrowLeft size={16} />
            {uiLanguage === 'english' ? 'Back to training' : '返回訓練頁'}
          </button>
          <h1>{uiLanguage === 'english' ? 'Evidence Cards Browser' : 'Evidence Cards 查看器'}</h1>
          <p>{uiLanguage === 'english' ? 'Shows normalized evidence cards only; raw SQLite rows and private JSON are not displayed.' : '只顯示 normalized evidence cards；不讀取 SQLite raw rows，也不顯示原始私有 JSON。'}</p>
        </div>
        <div className="evidenceStats">
          <span>Backend</span>
          <strong>{backend}</strong>
          <span>Cards</span>
          <strong>{total.toLocaleString()}</strong>
        </div>
      </header>

      <form className="evidenceFilters" onSubmit={handleFilterSubmit}>
        <label>
          {uiLanguage === 'english' ? 'Search' : '搜尋'}
          <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="client text / source / tag" />
        </label>
        <label>
          {uiLanguage === 'english' ? 'Tag' : '標籤'}
          <input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="bullying, alcohol, anxiety..." />
        </label>
        <label>
          Source
          <select value={source} onChange={(event) => { setOffset(0); setSource(event.target.value); }}>
            <option value="">{uiLanguage === 'english' ? 'All' : '全部'}</option>
            {sourceOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          Quality
          <select value={quality} onChange={(event) => { setOffset(0); setQuality(event.target.value); }}>
            <option value="">{uiLanguage === 'english' ? 'All' : '全部'}</option>
            {qualityOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          Client group
          <select value={clientGroup} onChange={(event) => { setOffset(0); setClientGroup(event.target.value); }}>
            <option value="">{uiLanguage === 'english' ? 'All' : '全部'}</option>
            {clientGroupOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          Affect
          <select value={affect} onChange={(event) => { setOffset(0); setAffect(event.target.value); }}>
            <option value="">{uiLanguage === 'english' ? 'All' : '全部'}</option>
            {affectOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <div className="evidenceFilterActions">
          <button type="submit">
            <Search size={15} />
            {uiLanguage === 'english' ? 'Apply' : '套用'}
          </button>
          <button className="secondaryButton" type="button" onClick={resetFilters}>{uiLanguage === 'english' ? 'Reset' : '重置'}</button>
        </div>
      </form>

      <section className="evidenceToolbar" aria-label="Evidence card pagination">
        <span>{isLoading ? (uiLanguage === 'english' ? 'Loading...' : '載入中...') : uiLanguage === 'english' ? `Showing ${pageStart}-${pageEnd} / ${total.toLocaleString()}` : `顯示 ${pageStart}-${pageEnd} / ${total.toLocaleString()}`}</span>
        <div>
          <button className={privateReview ? 'privateReviewActive' : ''} type="button" onClick={() => setPrivateReview((current) => !current)}>
            {privateReview ? <Eye size={14} /> : <EyeOff size={14} />}
            {uiLanguage === 'english' ? 'Private raw review' : '私有原文审阅'}
          </button>
          <button type="button" disabled={!canGoBack || isLoading} onClick={() => setOffset(Math.max(0, offset - pageSize))}>{uiLanguage === 'english' ? 'Previous' : '上一頁'}</button>
          <button type="button" disabled={!canGoForward || isLoading} onClick={() => setOffset(offset + pageSize)}>{uiLanguage === 'english' ? 'Next' : '下一頁'}</button>
        </div>
      </section>

      {errorMessage ? <div className="evidenceError">{errorMessage}</div> : null}

      <section className="evidenceBrowserWorkspace">
        <div className="evidenceTableWrap" aria-label="Evidence cards">
          <div className="evidenceTableHeader">
            <span>ID / Source</span><span>Group</span><span>Affect</span><span>Depth</span><span>Quality</span>
          </div>
          <div className="evidenceTableBody">
            {cards.map((card) => (
              <button className={`evidenceTableRow ${selectedCardId === card.id ? 'selected' : ''}`} key={card.id} type="button" onClick={() => setSelectedCardId(card.id)}>
                <span><strong>{card.id}</strong><small>{card.source}</small></span>
                <span>{card.clientGroup}</span><span>{card.affect}</span><span>{card.disclosureDepth}</span><span>{card.quality}</span>
              </button>
            ))}
            {!isLoading && cards.length === 0 && !errorMessage ? <div className="emptyEvidenceState">{uiLanguage === 'english' ? 'No evidence cards match the filters.' : '沒有符合條件的 evidence cards。'}</div> : null}
          </div>
        </div>
        <EvidenceInspector card={selectedCard} privateReview={privateReview} uiLanguage={uiLanguage} />
      </section>
    </main>
  );
}

function EvidenceInspector({ card, privateReview, uiLanguage }: { card: EvidenceCard | null; privateReview: boolean; uiLanguage: ResponseLanguage }) {
  if (!card) return <aside className="evidenceInspector"><p>{uiLanguage === 'english' ? 'Select a card to inspect it.' : '请选择一张 Evidence Card。'}</p></aside>;
  return (
    <aside className="evidenceInspector">
      <header>
        <div>
          <strong>{card.id}</strong>
          <span>{card.source} · {card.clientGroup}</span>
        </div>
        <div className="evidenceBadges">
          <span>{card.quality}</span>
          <span>{card.affect}</span>
          <span>depth {card.disclosureDepth}</span>
        </div>
      </header>
      <div className="reactionPatternBox">
        <span>{uiLanguage === 'english' ? 'Abstract reaction pattern' : '抽象反应模式'}</span>
        <strong>{reactionPattern(card)}</strong>
      </div>
      <TagLine label={uiLanguage === 'english' ? 'Issue tags' : '議題標籤'} values={card.issueTags} />
      <TagLine label={uiLanguage === 'english' ? 'Risk signals' : '風險標籤'} values={card.riskSignals} />
      <TagLine label="Change talk" values={card.changeTalk ?? []} />
      <TagLine label="Review flags" values={card.reviewFlags ?? []} />
      {privateReview ? <div className="privateRawText">
        <p className="evidenceUtterance">{card.clientUtterance}</p>
        {card.workerMove ? <p className="evidenceWorkerMove">{uiLanguage === 'english' ? 'Worker move' : '社工話術'}: {card.workerMove}</p> : null}
      </div> : <p className="privateReviewNotice">{uiLanguage === 'english' ? 'Raw utterance is hidden. Enable private raw review to inspect it.' : '原始语句已隐藏；只有明确开启私有原文审阅后才会显示。'}</p>}
      <footer>
        <span>{card.licenseNote}</span>
        {card.provenanceNote ? <span>{card.provenanceNote}</span> : null}
      </footer>
    </aside>
  );
}

function reactionPattern(card: EvidenceCard) {
  if (card.riskSignals.length) return 'risk_cue_low_detail';
  if (card.changeTalk?.length) return 'ambivalence_or_change_talk';
  if (card.resistanceType) return `${card.resistanceType}_response_pattern`;
  return `${card.affect || 'neutral'}_service_user_response`;
}

function TagLine({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null;
  return (
    <div className="evidenceTagLine">
      <span>{label}</span>
      <div>
        {values.map((value) => <em key={value}>{value}</em>)}
      </div>
    </div>
  );
}
