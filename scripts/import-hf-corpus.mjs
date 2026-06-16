import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SOURCES,
  curateRuntimeCards,
  fetchRows,
  normalizeRow,
  resolveSourceSplit,
} from './corpus-lib.mjs';

const args = new Set(process.argv.slice(2));
const full = args.has('--full');
const dryRun = args.has('--dry-run');
const sampleArg = [...args].find((arg) => arg.startsWith('--sample='));
const sampleSize = full ? undefined : Number(sampleArg?.split('=')[1] ?? 500);
const outPath = resolve(process.cwd(), 'data/corpus/social-work-client-corpus.jsonl');
const cards = [];

for (const source of SOURCES) {
  try {
    const resolved = await resolveSourceSplit(source);
    const rows = await fetchRows({
      dataset: source.dataset,
      config: resolved.config,
      split: resolved.split,
      limit: sampleSize,
    });
    rows.forEach((row) => {
      cards.push(...normalizeRow(source.source, row.row, String(row.row_idx)));
    });
    console.log(`${source.source}: imported ${rows.length} rows, normalized ${cards.length} total cards`);
  } catch (error) {
    console.warn(`${source.source}: skipped because ${error instanceof Error ? error.message : String(error)}`);
  }
}

const curated = curateRuntimeCards(cards);

if (dryRun) {
  console.log(`Dry run: ${curated.length} cards would be written to ${outPath}`);
  process.exit(0);
}

mkdirSync(resolve(process.cwd(), 'data/corpus'), { recursive: true });
writeFileSync(outPath, curated.map((card) => JSON.stringify(card)).join('\n') + '\n', 'utf8');
console.log(`Wrote ${curated.length} curated cards to ${outPath}`);
