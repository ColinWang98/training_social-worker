import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CASE_COVERAGE } from './corpus-lib.mjs';

const dbPath = resolve(process.cwd(), 'data/corpus/social-work-client-corpus.sqlite');
const reportsDir = resolve(process.cwd(), 'data/corpus/reports');

if (!existsSync(dbPath)) {
  throw new Error(`Missing SQLite corpus: ${dbPath}. Run node scripts/build-corpus.mjs first.`);
}

const db = new DatabaseSync(dbPath);
const importRunsHasExpected = hasColumn(db, 'import_runs', 'expected_rows');

const summary = {
  generatedAt: new Date().toISOString(),
  database: dbPath,
  tableCounts: {
    importRuns: scalar(db, 'SELECT COUNT(*) FROM import_runs'),
    rawRows: scalar(db, 'SELECT COUNT(*) FROM raw_rows'),
    evidenceCards: scalar(db, 'SELECT COUNT(*) FROM evidence_cards'),
    ftsRows: scalar(db, 'SELECT COUNT(*) FROM evidence_cards_fts'),
    curationFlags: scalar(db, 'SELECT COUNT(*) FROM curation_flags'),
  },
  importRuns: db
    .prepare(
      `SELECT source, dataset, config, split,
        ${importRunsHasExpected ? 'expected_rows AS expectedRows, expected_bytes AS expectedBytes,' : 'NULL AS expectedRows, NULL AS expectedBytes,'}
        row_count AS rowCount,
        card_count AS cardCount, error
       FROM import_runs
       ORDER BY source`,
    )
    .all(),
  bySourceQuality: db
    .prepare(
      `SELECT source, quality, COUNT(*) AS count
       FROM evidence_cards
       GROUP BY source, quality
       ORDER BY source, quality`,
    )
    .all(),
  byCurationFlag: db
    .prepare(
      `SELECT flag, COUNT(*) AS count
       FROM curation_flags
       GROUP BY flag
       ORDER BY count DESC, flag`,
    )
    .all(),
  topRejectReasons: db
    .prepare(
      `SELECT flag, reason, COUNT(*) AS count
       FROM curation_flags
       WHERE flag IN ('reject', 'too_short', 'too_long', 'duplicate', 'pii', 'url', 'date')
       GROUP BY flag, reason
       ORDER BY count DESC, flag
       LIMIT 20`,
    )
    .all(),
  byIssueTag: countJsonArrayValues(db, 'issue_tags'),
  byRiskSignal: countJsonArrayValues(db, 'risk_signals'),
  caseCoverage: caseCoverage(db),
  runtimeEligibleCards: scalar(db, `SELECT COUNT(*) FROM evidence_cards WHERE quality IN ('approved', 'review') AND source != 'reddit_mental_health_private'`),
};

db.close();

mkdirSync(reportsDir, { recursive: true });
writeFileSync(resolve(reportsDir, 'corpus-stats.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
writeFileSync(resolve(reportsDir, 'corpus-stats.md'), renderMarkdown(summary), 'utf8');

console.log(renderConsole(summary));

function scalar(database, sql) {
  const row = database.prepare(sql).get();
  return Object.values(row)[0];
}

function hasColumn(database, table, column) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function countJsonArrayValues(database, column) {
  const rows = database.prepare(`SELECT ${column} FROM evidence_cards WHERE quality IN ('approved', 'review')`).all();
  const counts = new Map();
  rows.forEach((row) => {
    parseJsonArray(row[column]).forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  });
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, 40);
}

function caseCoverage(database) {
  const cards = database
    .prepare(
      `SELECT id, source, client_group AS clientGroup, issue_tags AS issueTags
       FROM evidence_cards
       WHERE quality IN ('approved', 'review')`,
    )
    .all()
    .map((card) => ({
      ...card,
      issueTags: parseJsonArray(card.issueTags),
    }));

  return CASE_COVERAGE.map((coverage) => {
    const matched = cards.filter((card) => {
      const tagOverlap = card.issueTags.some((tag) => coverage.tags.includes(tag));
      const sourceMatch = coverage.sources.includes(card.source);
      const groupMatch = coverage.groups.includes(card.clientGroup);
      return tagOverlap || (sourceMatch && groupMatch);
    });
    return {
      caseType: coverage.caseType,
      usableCards: matched.length,
      meetsV1Minimum: matched.length >= 100,
    };
  });
}

function parseJsonArray(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
}

function renderConsole(report) {
  const missing = report.caseCoverage.filter((entry) => !entry.meetsV1Minimum);
  return [
    `Corpus stats: ${report.tableCounts.rawRows} raw rows, ${report.tableCounts.evidenceCards} cards, ${report.tableCounts.ftsRows} FTS rows.`,
    `Import errors: ${report.importRuns.filter((run) => run.error).length}`,
    `Runtime eligible cards: ${report.runtimeEligibleCards}`,
    `Case coverage below 100: ${missing.length ? missing.map((entry) => `${entry.caseType}=${entry.usableCards}`).join(', ') : 'none'}`,
    `Reports written to ${reportsDir}`,
  ].join('\n');
}

function renderMarkdown(report) {
  return `# Social Work Client Corpus Stats

Generated: ${report.generatedAt}

## Table Counts

| Table | Count |
| --- | ---: |
| import_runs | ${report.tableCounts.importRuns} |
| raw_rows | ${report.tableCounts.rawRows} |
| evidence_cards | ${report.tableCounts.evidenceCards} |
| evidence_cards_fts | ${report.tableCounts.ftsRows} |
| curation_flags | ${report.tableCounts.curationFlags} |

Runtime eligible cards: ${report.runtimeEligibleCards}

## Imports

| Source | Config | Split | Expected Rows | Rows | Cards | Error |
| --- | --- | --- | ---: | ---: | ---: | --- |
${report.importRuns
  .map((run) => `| ${run.source} | ${run.config ?? ''} | ${run.split ?? ''} | ${run.expectedRows ?? ''} | ${run.rowCount} | ${run.cardCount} | ${run.error ?? ''} |`)
  .join('\n')}

## Source / Quality

| Source | Quality | Count |
| --- | --- | ---: |
${report.bySourceQuality.map((row) => `| ${row.source} | ${row.quality} | ${row.count} |`).join('\n')}

## Curation Flags

| Flag | Count |
| --- | ---: |
${report.byCurationFlag.map((row) => `| ${row.flag} | ${row.count} |`).join('\n')}

## Top Reject Reasons

| Flag | Reason | Count |
| --- | --- | ---: |
${report.topRejectReasons.map((row) => `| ${row.flag} | ${row.reason} | ${row.count} |`).join('\n')}

## V1 Case Coverage

| Case | Usable Cards | Meets 100 |
| --- | ---: | --- |
${report.caseCoverage
  .map((row) => `| ${row.caseType} | ${row.usableCards} | ${row.meetsV1Minimum ? 'yes' : 'no'} |`)
  .join('\n')}

## Top Issue Tags

| Tag | Count |
| --- | ---: |
${report.byIssueTag.map((row) => `| ${row.value} | ${row.count} |`).join('\n')}

## Top Risk Signals

| Risk Signal | Count |
| --- | ---: |
${report.byRiskSignal.map((row) => `| ${row.value} | ${row.count} |`).join('\n')}
`;
}
