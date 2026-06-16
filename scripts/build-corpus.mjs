import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  curationFlags,
  fetchDatasetSize,
  fetchRows,
  hashText,
  normalizeRow,
  resolveSourceSplit,
  selectCorpusSources,
  sourceByName,
} from './corpus-lib.mjs';

const args = new Set(process.argv.slice(2));
const full = args.has('--full');
const sampleArg = [...args].find((arg) => arg.startsWith('--sample='));
const sourcesArg = [...args].find((arg) => arg.startsWith('--sources='));
const sampleSize = full ? undefined : Number(sampleArg?.split('=')[1] ?? 500);
const sourceMode = sourcesArg?.split('=')[1] ?? 'runtime';
const sources = resolveSelectedSources(sourceMode);
const corpusDir = resolve(process.cwd(), 'data/corpus');
const buildsDir = resolve(corpusDir, 'builds');
const dbPath = resolve(corpusDir, 'social-work-client-corpus.sqlite');
const tmpDbPath = resolve(buildsDir, `social-work-client-corpus.${buildStamp()}.tmp.sqlite`);

mkdirSync(buildsDir, { recursive: true });
unlinkIfExists(tmpDbPath);

const db = new DatabaseSync(tmpDbPath);
createSchema(db);

const seenCards = new Set();
const totals = { rows: 0, cards: 0, errors: 0 };

for (const source of sources) {
  const runId = `${source.source}-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const expected = await fetchDatasetSize(source).catch((error) => ({
    config: null,
    split: null,
    expectedRows: null,
    parquetBytes: null,
    memoryBytes: null,
    error: error instanceof Error ? error.message : String(error),
  }));
  insertImportRun(db, {
    runId,
    startedAt,
    completedAt: null,
    source: source.source,
    dataset: source.dataset,
    config: expected.config ?? null,
    split: expected.split ?? null,
    expectedRows: expected.expectedRows ?? null,
    expectedBytes: expected.parquetBytes ?? null,
    requestedLimit: sampleSize ?? null,
    rowCount: 0,
    cardCount: 0,
    error: expected.error ? `preflight warning: ${expected.error}` : null,
  });

  try {
    const resolved = await resolveSourceSplit(source);
    const rows = await fetchRows({
      dataset: source.dataset,
      config: resolved.config,
      split: resolved.split,
      limit: sampleSize,
      pageDelayMs: full ? 50 : 0,
      maxRetries: full ? 10 : 8,
      requestTimeoutMs: 45_000,
      onProgress: full ? progressLogger(source.source) : undefined,
    });
    let cardCount = 0;

    db.exec('BEGIN');
    rows.forEach((hfRow) => {
      const rawJson = JSON.stringify(hfRow.row);
      const rawId = insertRawRow(db, {
        runId,
        source: source.source,
        hfRowIndex: hfRow.row_idx,
        rowHash: hashText(rawJson),
        rawJson,
        licenseNote: licenseNoteForSource(source.source),
      });

      const cards = normalizeRow(source.source, hfRow.row, String(hfRow.row_idx));
      cards.forEach((card, cardIndex) => {
        const cardId = `${card.id}-${rawId}-${cardIndex}`;
        const flags = curationFlags(card, seenCards);
        const quality = finalQuality(card.quality, flags);
        insertEvidenceCard(db, {
          ...card,
          id: cardId,
          rawRowId: rawId,
          quality,
          reviewFlags: flags.map((flag) => flag.flag),
        });
        insertFtsCard(db, {
          cardId,
          clientUtterance: card.clientUtterance,
          workerMove: card.workerMove ?? '',
          issueTags: card.issueTags.join(' '),
          riskSignals: card.riskSignals.join(' '),
        });
        flags.forEach((flag) => insertCurationFlag(db, cardId, flag.flag, flag.reason));
        cardCount += 1;
      });
    });
    db.exec('COMMIT');

    updateImportRun(db, {
      runId,
      completedAt: new Date().toISOString(),
      config: resolved.config,
      split: resolved.split,
      expectedRows: expected.expectedRows ?? null,
      expectedBytes: expected.parquetBytes ?? null,
      rowCount: rows.length,
      cardCount,
      error: null,
    });
    totals.rows += rows.length;
    totals.cards += cardCount;
    console.log(`${source.source}: ${rows.length} rows, ${cardCount} normalized cards`);
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction was active.
    }
    totals.errors += 1;
    updateImportRun(db, {
      runId,
      completedAt: new Date().toISOString(),
      config: null,
      split: null,
      expectedRows: expected.expectedRows ?? null,
      expectedBytes: expected.parquetBytes ?? null,
      rowCount: 0,
      cardCount: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    console.warn(`${source.source}: failed - ${error instanceof Error ? error.message : String(error)}`);
  }
}

db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
db.close();
if (totals.errors > 0) {
  console.error(
    `Build failed with ${totals.errors} source error(s). Temporary database preserved at ${tmpDbPath}. Canonical database was not replaced.`,
  );
  process.exitCode = 1;
} else {
  unlinkIfExists(`${dbPath}-wal`);
  unlinkIfExists(`${dbPath}-shm`);
  renameSync(tmpDbPath, dbPath);
}
console.log(
  `Built ${totals.errors ? tmpDbPath : dbPath} with ${totals.rows} raw rows and ${totals.cards} normalized cards. Source errors: ${totals.errors}.`,
);

function createSchema(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE import_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      source TEXT NOT NULL,
      dataset TEXT NOT NULL,
      config TEXT,
      split TEXT,
      expected_rows INTEGER,
      expected_bytes INTEGER,
      requested_limit INTEGER,
      row_count INTEGER NOT NULL DEFAULT 0,
      card_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE raw_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      source TEXT NOT NULL,
      hf_row_idx INTEGER,
      row_hash TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      license_note TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES import_runs(id)
    );

    CREATE TABLE evidence_cards (
      id TEXT PRIMARY KEY,
      raw_row_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      client_group TEXT NOT NULL,
      issue_tags TEXT NOT NULL,
      client_utterance TEXT NOT NULL,
      worker_move TEXT,
      affect TEXT NOT NULL,
      risk_signals TEXT NOT NULL,
      resistance_type TEXT,
      change_talk TEXT NOT NULL,
      disclosure_depth INTEGER NOT NULL,
      quality TEXT NOT NULL,
      license_note TEXT NOT NULL,
      provenance_note TEXT,
      review_flags TEXT NOT NULL,
      FOREIGN KEY (raw_row_id) REFERENCES raw_rows(id)
    );

    CREATE VIRTUAL TABLE evidence_cards_fts USING fts5(
      card_id UNINDEXED,
      client_utterance,
      worker_move,
      issue_tags,
      risk_signals
    );

    CREATE TABLE curation_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      flag TEXT NOT NULL,
      reason TEXT NOT NULL,
      FOREIGN KEY (card_id) REFERENCES evidence_cards(id)
    );

    CREATE INDEX idx_raw_rows_run_id ON raw_rows(run_id);
    CREATE INDEX idx_evidence_source_quality ON evidence_cards(source, quality);
    CREATE INDEX idx_curation_card_id ON curation_flags(card_id);
  `);
}

function resolveSelectedSources(mode) {
  if (!mode || mode === 'runtime' || mode === 'all' || mode === 'private') {
    return selectCorpusSources(mode || 'runtime');
  }
  const names = mode.split(',').map((name) => name.trim()).filter(Boolean);
  const selected = names.map((name) => {
    const source = sourceByName(name);
    if (!source) throw new Error(`Unknown corpus source: ${name}`);
    return source;
  });
  if (!selected.length) throw new Error('No corpus sources selected.');
  return selected;
}

function unlinkIfExists(path) {
  if (existsSync(path)) unlinkSync(path);
}

function buildStamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function progressLogger(sourceName) {
  let lastLogged = 0;
  return ({ rows, totalRows }) => {
    if (rows - lastLogged < 5000 && !(totalRows && rows >= totalRows)) return;
    lastLogged = rows;
    const total = totalRows ? `/${totalRows}` : '';
    console.log(`${sourceName}: fetched ${rows}${total} rows`);
  };
}

function insertImportRun(database, run) {
  database
    .prepare(
      `INSERT INTO import_runs (
        id, started_at, completed_at, source, dataset, config, split,
        expected_rows, expected_bytes, requested_limit, row_count, card_count, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.runId,
      run.startedAt,
      run.completedAt,
      run.source,
      run.dataset,
      run.config,
      run.split,
      run.expectedRows,
      run.expectedBytes,
      run.requestedLimit,
      run.rowCount,
      run.cardCount,
      run.error,
    );
}

function updateImportRun(database, run) {
  database
    .prepare(
      `UPDATE import_runs
       SET completed_at = ?, config = ?, split = ?, expected_rows = ?, expected_bytes = ?,
           row_count = ?, card_count = ?, error = ?
       WHERE id = ?`,
    )
    .run(
      run.completedAt,
      run.config,
      run.split,
      run.expectedRows,
      run.expectedBytes,
      run.rowCount,
      run.cardCount,
      run.error,
      run.runId,
    );
}

function insertRawRow(database, row) {
  const result = database
    .prepare(
      `INSERT INTO raw_rows (
        run_id, source, hf_row_idx, row_hash, raw_json, license_note, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.runId,
      row.source,
      row.hfRowIndex,
      row.rowHash,
      row.rawJson,
      row.licenseNote,
      new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}

function insertEvidenceCard(database, card) {
  database
    .prepare(
      `INSERT INTO evidence_cards (
        id, raw_row_id, source, client_group, issue_tags, client_utterance,
        worker_move, affect, risk_signals, resistance_type, change_talk,
        disclosure_depth, quality, license_note, provenance_note, review_flags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      card.id,
      card.rawRowId,
      card.source,
      card.clientGroup,
      JSON.stringify(card.issueTags),
      card.clientUtterance,
      card.workerMove ?? null,
      card.affect,
      JSON.stringify(card.riskSignals),
      card.resistanceType ?? null,
      JSON.stringify(card.changeTalk ?? []),
      card.disclosureDepth,
      card.quality,
      card.licenseNote,
      card.provenanceNote ?? null,
      JSON.stringify(card.reviewFlags),
    );
}

function insertFtsCard(database, card) {
  database
    .prepare(
      `INSERT INTO evidence_cards_fts (
        card_id, client_utterance, worker_move, issue_tags, risk_signals
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(card.cardId, card.clientUtterance, card.workerMove, card.issueTags, card.riskSignals);
}

function insertCurationFlag(database, cardId, flag, reason) {
  database
    .prepare('INSERT INTO curation_flags (card_id, flag, reason) VALUES (?, ?, ?)')
    .run(cardId, flag, reason);
}

function finalQuality(quality, flags) {
  if (
    quality === 'reject' ||
    flags.some((flag) => flag.flag === 'duplicate' || flag.flag === 'too_short' || flag.flag === 'too_long')
  ) {
    return 'reject';
  }
  return quality;
}

function licenseNoteForSource(source) {
  if (source === 'therapytalk') {
    return 'Public help-seeking corpus; keep raw text local, remove identifying details from runtime export.';
  }
  if (source === 'addiction_sft') {
    return 'Addiction SFT corpus; mark normalized cards review before study use.';
  }
  if (source === 'esconv') {
    return 'ESConv emotional support dialogues; CC-BY-NC-4.0, local non-commercial research/training use only.';
  }
  if (source === 'counsel_chat') {
    return 'CounselChat forum scrape; keep raw text local, remove identifying details from runtime export.';
  }
  if (source === 'multilingual_therapy') {
    return 'Multilingual Therapy Dialogues; MIT, patient-side turns used as style patterns.';
  }
  if (source === 'empathetic_dialogues') {
    return 'Empathetic Dialogues LLM formatted corpus; use user-side emotional reaction patterns only.';
  }
  if (source === 'reddit_mental_health_private') {
    return 'Reddit mental-health posts; private/review candidate only, not runtime export by default.';
  }
  return 'Hugging Face dataset row; verify upstream license before redistribution.';
}
