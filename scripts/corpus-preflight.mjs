import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchDatasetSize, selectCorpusSources, sourceByName } from './corpus-lib.mjs';

const sourcesArg = process.argv.find((arg) => arg.startsWith('--sources='));
const sourceMode = sourcesArg?.split('=')[1] ?? 'runtime';
const sources = resolveSelectedSources(sourceMode);
const reportsDir = resolve(process.cwd(), 'data/corpus/reports');

const rows = [];
let errors = 0;

for (const source of sources) {
  try {
    rows.push(await fetchDatasetSize(source));
  } catch (error) {
    errors += 1;
    rows.push({
      source: source.source,
      dataset: source.dataset,
      config: null,
      split: source.preferredSplit,
      expectedRows: null,
      parquetBytes: null,
      memoryBytes: null,
      runtimeEligible: source.runtimeEligible !== false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  sourceMode,
  sourceCount: rows.length,
  totalExpectedRows: rows.reduce((sum, row) => sum + (row.expectedRows ?? 0), 0),
  totalParquetBytes: rows.reduce((sum, row) => sum + (row.parquetBytes ?? 0), 0),
  totalMemoryBytes: rows.reduce((sum, row) => sum + (row.memoryBytes ?? 0), 0),
  errors,
  sources: rows,
};

mkdirSync(reportsDir, { recursive: true });
writeFileSync(resolve(reportsDir, 'corpus-preflight.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
writeFileSync(resolve(reportsDir, 'corpus-preflight.md'), renderMarkdown(report), 'utf8');

console.log(renderConsole(report));
if (errors) process.exitCode = 1;

function resolveSelectedSources(mode) {
  if (!mode || mode === 'runtime' || mode === 'all' || mode === 'private') {
    return selectCorpusSources(mode || 'runtime');
  }
  return mode.split(',').map((name) => {
    const source = sourceByName(name.trim());
    if (!source) throw new Error(`Unknown corpus source: ${name}`);
    return source;
  });
}

function renderConsole(report) {
  return [
    `Corpus preflight: ${report.sourceCount} sources, ${report.totalExpectedRows} expected rows.`,
    `Parquet bytes: ${formatBytes(report.totalParquetBytes)}; memory bytes: ${formatBytes(report.totalMemoryBytes)}.`,
    `Errors: ${report.errors}`,
    `Reports written to ${reportsDir}`,
  ].join('\n');
}

function renderMarkdown(report) {
  return `# Corpus Preflight

Generated: ${report.generatedAt}

Source mode: ${report.sourceMode}

Expected rows: ${report.totalExpectedRows}

Parquet bytes: ${formatBytes(report.totalParquetBytes)}

Memory bytes: ${formatBytes(report.totalMemoryBytes)}

| Source | Dataset | Config | Split | Rows | Parquet | Runtime | Error |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
${report.sources
  .map((row) => `| ${row.source} | ${row.dataset} | ${row.config ?? ''} | ${row.split ?? ''} | ${row.expectedRows ?? ''} | ${formatBytes(row.parquetBytes)} | ${row.runtimeEligible ? 'yes' : 'no'} | ${row.error ?? ''} |`)
  .join('\n')}
`;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
