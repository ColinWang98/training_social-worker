#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(ROOT, 'public', 'avatar-clips', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const allowedLicenseStatuses = new Set(['approved', 'credit_required', 'debug_only']);
const ids = new Set();
const errors = [];

if (!Array.isArray(manifest.clips)) {
  errors.push('manifest.clips must be an array');
} else {
  for (const clip of manifest.clips) {
    if (!clip.id || typeof clip.id !== 'string') errors.push('clip.id is required');
    if (ids.has(clip.id)) errors.push(`duplicate clip id: ${clip.id}`);
    ids.add(clip.id);
    if (!clip.file || typeof clip.file !== 'string') errors.push(`${clip.id}: file is required`);
    const localPath = clip.file?.startsWith('/')
      ? path.join(ROOT, 'public', clip.file.slice(1))
      : path.join(ROOT, 'public', clip.file || '');
    if (clip.file && !existsSync(localPath)) errors.push(`${clip.id}: missing file ${clip.file}`);
    if (!clip.source) errors.push(`${clip.id}: source is required`);
    if (!clip.credit) errors.push(`${clip.id}: credit is required`);
    if (!allowedLicenseStatuses.has(clip.licenseStatus)) errors.push(`${clip.id}: invalid licenseStatus`);
    if (clip.playbackMask !== 'upper_body') errors.push(`${clip.id}: playbackMask must be upper_body`);
    if (clip.seatedRuntime !== true) errors.push(`${clip.id}: seatedRuntime must be true`);
    if (clip.autoLoad === true && clip.playbackMask !== 'upper_body') errors.push(`${clip.id}: autoLoad requires upper_body mask`);
    if (clip.autoLoad === true && clip.seatedRuntime !== true) errors.push(`${clip.id}: autoLoad requires seatedRuntime`);
  }
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, clipCount: manifest.clips.length }, null, 2));
