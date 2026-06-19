#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(ROOT, 'public', 'avatar-clips', '_incoming', 'mixamo', 'manifest.local.json');
const allowedFamilies = new Set(['defensive', 'withdrawn', 'anxious', 'ashamed', 'reflective', 'risk', 'soft_engagement']);

const args = parseArgs(process.argv.slice(2));
const fileArg = args.file;
if (!fileArg) fail('Missing --file <path>.');
const family = args.family ?? 'soft_engagement';
if (!allowedFamilies.has(family)) fail(`Invalid --family ${family}.`);

const filePath = path.resolve(ROOT, fileArg);
if (!filePath.startsWith(path.join(ROOT, 'public', 'avatar-clips', '_incoming', 'mixamo'))) {
  fail('Mixamo files must live under public/avatar-clips/_incoming/mixamo/.');
}
if (!existsSync(filePath)) fail(`File does not exist: ${fileArg}`);

const ext = path.extname(filePath).toLowerCase();
if (!['.fbx', '.dae', '.glb', '.gltf'].includes(ext)) {
  fail('Only .fbx, .dae, .glb, or .gltf files can be registered.');
}

const buffer = readFileSync(filePath);
const sha256 = createHash('sha256').update(buffer).digest('hex');
const manifest = readManifest();
const localPath = path.relative(ROOT, filePath);
const id = args.id ?? `mixamo_${slug(path.basename(filePath, ext))}_${sha256.slice(0, 8)}`;
const existingIndex = manifest.clips.findIndex((clip) => clip.id === id || clip.sha256 === sha256);
const entry = {
  id,
  label: args.label ?? path.basename(filePath, ext),
  file: localPath,
  sha256,
  bytes: buffer.byteLength,
  source: 'Mixamo manual download',
  sourceUrl: args.sourceUrl ?? 'https://www.mixamo.com/#/',
  credit: args.credit ?? 'Adobe Mixamo manual animation candidate',
  licenseNote: args.licenseNote ?? 'Mixamo FAQ describes royalty-free use for personal, commercial, and non-profit projects; verify project-specific Adobe terms before redistribution.',
  family,
  intendedUse: args.intendedUse ?? 'upper-body seated reference',
  playbackMask: 'upper_body',
  seatedRuntime: false,
  autoLoad: false,
  licenseStatus: 'debug_only',
  validationStatus: 'pending_review',
  registeredAt: new Date().toISOString(),
};

if (existingIndex >= 0) {
  manifest.clips[existingIndex] = { ...manifest.clips[existingIndex], ...entry };
} else {
  manifest.clips.push(entry);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, entry }, null, 2));

function readManifest() {
  if (!existsSync(manifestPath)) {
    return {
      source: 'mixamo_manual_local',
      notes: [
        'Local-only Mixamo manifest. It references ignored incoming FBX files and should not be committed.',
        'Promote only reviewed upper-body seated derivatives to public/avatar-clips/manifest.json.',
      ],
      clips: [],
    };
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function parseArgs(items) {
  const out = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = items[index + 1];
    if (!next || next.startsWith('--')) out[key] = 'true';
    else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'clip';
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}
