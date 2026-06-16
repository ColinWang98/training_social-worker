import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import { EvidenceCard } from '../lib/interviewTypes';
import { EvidenceCardListRequest, listEvidenceCards } from '../lib/apiClient';

const pageSize = 50;

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
};

export function EvidenceCardsPage({ onBack }: EvidenceCardsPageProps) {
  const [cards, setCards] = useState<EvidenceCard[]>([]);
  const [total, setTotal] = useState(0);
  const [backend, setBackend] = useState('loading');
  const [offset, setOffset] = useState(0);
  const [source, setSource] = useState('');
  const [quality, setQuality] = useState('');
  const [clientGroup, setClientGroup] = useState('');
  const [affect, setAffect] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [appliedTag, setAppliedTag] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
    setQuality('');
    setClientGroup('');
    setAffect('');
    setSearchDraft('');
    setTagDraft('');
    setAppliedSearch('');
    setAppliedTag('');
  };

  return (
    <main className="evidencePage">
      <header className="evidencePageHeader">
        <div>
          <button className="backButton" type="button" onClick={onBack}>
            <ArrowLeft size={16} />
            返回訓練頁
          </button>
          <h1>Evidence Cards 查看器</h1>
          <p>只顯示 normalized evidence cards；不讀取 SQLite raw rows，也不顯示原始私有 JSON。</p>
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
          搜尋
          <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="client text / source / tag" />
        </label>
        <label>
          標籤
          <input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="bullying, alcohol, anxiety..." />
        </label>
        <label>
          Source
          <select value={source} onChange={(event) => { setOffset(0); setSource(event.target.value); }}>
            <option value="">全部</option>
            {sourceOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          Quality
          <select value={quality} onChange={(event) => { setOffset(0); setQuality(event.target.value); }}>
            <option value="">全部</option>
            {qualityOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          Client group
          <select value={clientGroup} onChange={(event) => { setOffset(0); setClientGroup(event.target.value); }}>
            <option value="">全部</option>
            {clientGroupOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          Affect
          <select value={affect} onChange={(event) => { setOffset(0); setAffect(event.target.value); }}>
            <option value="">全部</option>
            {affectOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <div className="evidenceFilterActions">
          <button type="submit">
            <Search size={15} />
            套用
          </button>
          <button className="secondaryButton" type="button" onClick={resetFilters}>重置</button>
        </div>
      </form>

      <section className="evidenceToolbar" aria-label="Evidence card pagination">
        <span>{isLoading ? '載入中...' : `顯示 ${pageStart}-${pageEnd} / ${total.toLocaleString()}`}</span>
        <div>
          <button type="button" disabled={!canGoBack || isLoading} onClick={() => setOffset(Math.max(0, offset - pageSize))}>上一頁</button>
          <button type="button" disabled={!canGoForward || isLoading} onClick={() => setOffset(offset + pageSize)}>下一頁</button>
        </div>
      </section>

      {errorMessage ? <div className="evidenceError">{errorMessage}</div> : null}

      <section className="evidenceCardList" aria-label="Evidence cards">
        {cards.map((card) => <EvidenceCardItem card={card} key={card.id} />)}
        {!isLoading && cards.length === 0 && !errorMessage ? <div className="emptyEvidenceState">沒有符合條件的 evidence cards。</div> : null}
      </section>
    </main>
  );
}

function EvidenceCardItem({ card }: { card: EvidenceCard }) {
  return (
    <article className="evidenceCardItem">
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
      <p className="evidenceUtterance">{card.clientUtterance}</p>
      {card.workerMove ? <p className="evidenceWorkerMove">Worker move: {card.workerMove}</p> : null}
      <TagLine label="Issue tags" values={card.issueTags} />
      <TagLine label="Risk signals" values={card.riskSignals} />
      <TagLine label="Change talk" values={card.changeTalk ?? []} />
      <TagLine label="Review flags" values={card.reviewFlags ?? []} />
      <footer>
        <span>{card.licenseNote}</span>
        {card.provenanceNote ? <span>{card.provenanceNote}</span> : null}
      </footer>
    </article>
  );
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
