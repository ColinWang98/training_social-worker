#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'avatar-clips', '_incoming', 'xlunar');
const META_PATH = path.join(OUT_DIR, 'download-manifest.json');
const BASE_URL = 'https://raw.githubusercontent.com/iamenahs/xlunar-ai-avatar/main/public/animations';

const CREDIT =
  'Animation candidates from iamenahs/xlunar-ai-avatar. Preserve upstream third-party credits; see public/avatar-clips/ATTRIBUTION.md.';

const CANDIDATES = [
  { file: 'Angry.vrma', priority: 'high', autoLoadCandidate: true },
  { file: 'Blush.vrma', priority: 'high', autoLoadCandidate: true },
  { file: 'LookAround.vrma', priority: 'high', autoLoadCandidate: true },
  { file: 'Relax.vrma', priority: 'high', autoLoadCandidate: true },
  { file: 'Sad.vrma', priority: 'high', autoLoadCandidate: true },
  { file: 'Sleepy.vrma', priority: 'high', autoLoadCandidate: true },
  { file: 'Thinking.vrma', priority: 'high', autoLoadCandidate: true },
  { file: 'Greeting.vrma', priority: 'debug', autoLoadCandidate: false },
  { file: 'Clapping.vrma', priority: 'debug', autoLoadCandidate: false },
  { file: 'Goodbye.vrma', priority: 'debug', autoLoadCandidate: false },
  { file: 'Jump.vrma', priority: 'excluded_full_body', autoLoadCandidate: false },
  { file: 'ModelPose.vrma', priority: 'excluded_full_body', autoLoadCandidate: false },
  { file: 'PeaceSign.vrma', priority: 'excluded_full_body', autoLoadCandidate: false },
  { file: 'Shoot.vrma', priority: 'excluded_full_body', autoLoadCandidate: false },
  { file: 'ShowFullBody.vrma', priority: 'excluded_full_body', autoLoadCandidate: false },
  { file: 'Spin.vrma', priority: 'excluded_full_body', autoLoadCandidate: false },
  { file: 'Squat.vrma', priority: 'excluded_full_body', autoLoadCandidate: false },
];

await mkdir(OUT_DIR, { recursive: true });

const metadata = {
  source: 'iamenahs/xlunar-ai-avatar',
  sourceDirectory: `${BASE_URL}/`,
  license: 'MIT project license with third-party animation credits preserved upstream.',
  credit: CREDIT,
  downloadedAt: new Date().toISOString(),
  candidates: [],
};

for (const candidate of CANDIDATES) {
  const url = `${BASE_URL}/${candidate.file}`;
  const target = path.join(OUT_DIR, candidate.file);
  let buffer;
  if (existsSync(target)) {
    buffer = await readFile(target);
  } else {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
    }
    buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(target, buffer);
  }
  metadata.candidates.push({
    file: candidate.file,
    localPath: path.relative(ROOT, target),
    sourceUrl: url,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
    priority: candidate.priority,
    autoLoadCandidate: candidate.autoLoadCandidate,
    license: metadata.license,
    credit: CREDIT,
  });
}

await writeFile(META_PATH, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, downloaded: metadata.candidates.length, output: path.relative(ROOT, META_PATH) }, null, 2));
