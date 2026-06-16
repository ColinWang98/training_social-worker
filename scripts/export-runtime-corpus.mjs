import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CASE_COVERAGE, sanitizeRuntimeText } from './corpus-lib.mjs';

const dbPath = resolve(process.cwd(), 'data/corpus/social-work-client-corpus.sqlite');
const outPath = resolve(process.cwd(), 'data/corpus/social-work-client-corpus.jsonl');
const args = new Set(process.argv.slice(2));
const balanced = args.has('--balanced');
const maxPerCase = numberArg('--max-per-case=', 3000);
const maxPerSourcePerCase = numberArg('--max-per-source-per-case=', 800);

if (!existsSync(dbPath)) {
  throw new Error(`Missing SQLite corpus: ${dbPath}. Run node scripts/build-corpus.mjs first.`);
}

const db = new DatabaseSync(dbPath);
const rows = db
  .prepare(
    `SELECT
      id, source, client_group, issue_tags, client_utterance, worker_move,
      affect, risk_signals, resistance_type, change_talk, disclosure_depth,
      quality, license_note, provenance_note
    FROM evidence_cards
    WHERE quality IN ('approved', 'review')
      AND source != 'reddit_mental_health_private'
    ORDER BY source, id`,
  )
  .all();

const allCards = rows.map((row) => ({
  id: row.id,
  source: row.source,
  clientGroup: row.client_group,
  issueTags: parseJsonArray(row.issue_tags),
  clientUtterance: sanitizeRuntimeText(row.client_utterance),
  workerMove: row.worker_move ? sanitizeRuntimeText(row.worker_move) : undefined,
  affect: row.affect,
  riskSignals: parseJsonArray(row.risk_signals),
  resistanceType: row.resistance_type ?? undefined,
  changeTalk: parseJsonArray(row.change_talk),
  disclosureDepth: row.disclosure_depth,
  quality: row.quality,
  licenseNote: row.license_note,
  provenanceNote: row.provenance_note ?? 'SQLite corpus export.',
}));
const cards = balanced ? balancedRuntimeCards(allCards, maxPerCase, maxPerSourcePerCase) : allCards;

db.close();
mkdirSync(resolve(process.cwd(), 'data/corpus'), { recursive: true });
writeFileSync(outPath, cards.map((card) => JSON.stringify(card)).join('\n') + '\n', 'utf8');

const bySource = cards.reduce((acc, card) => {
  acc[card.source] = (acc[card.source] ?? 0) + 1;
  return acc;
}, {});

console.log(`Exported ${cards.length} runtime evidence cards to ${outPath}${balanced ? ' (balanced)' : ''}`);
console.log(`By source: ${JSON.stringify(bySource)}`);

function balancedRuntimeCards(cards, perCaseLimit, perSourceLimit) {
  const selected = new Map();
  CASE_COVERAGE.forEach((coverage) => {
    const bySource = new Map();
    let caseCount = 0;
    const matches = cards
      .filter((card) => matchesCaseCoverage(card, coverage))
      .sort(cardRuntimeSort);
    for (const card of matches) {
      if (caseCount >= perCaseLimit) break;
      if (selected.has(card.id)) continue;
      const sourceCount = bySource.get(card.source) ?? 0;
      if (sourceCount >= perSourceLimit) continue;
      selected.set(card.id, { ...card, provenanceNote: `${card.provenanceNote} Balanced fallback export for ${coverage.caseType}.` });
      bySource.set(card.source, sourceCount + 1);
      caseCount += 1;
    }
  });
  return [...selected.values()];
}

function matchesCaseCoverage(card, coverage) {
  const tagOverlap = card.issueTags.some((tag) => coverage.tags.includes(tag));
  const sourceGroupMatch = coverage.sources.includes(card.source) && coverage.groups.includes(card.clientGroup);
  return tagOverlap || sourceGroupMatch;
}

function cardRuntimeSort(left, right) {
  const quality = qualityRank(left.quality) - qualityRank(right.quality);
  if (quality !== 0) return quality;
  return left.source.localeCompare(right.source) || left.id.localeCompare(right.id);
}

function qualityRank(quality) {
  return quality === 'approved' ? 0 : 1;
}

function numberArg(prefix, fallback) {
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseJsonArray(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
}
