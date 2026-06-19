#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trackedManifestPath = path.join(ROOT, 'public', 'avatar-clips', 'mixamo-manifest.json');
const localManifestPath = path.join(ROOT, 'public', 'avatar-clips', '_incoming', 'mixamo', 'manifest.local.json');
const manifestPath = existsSync(localManifestPath) ? localManifestPath : trackedManifestPath;
const errors = [];
const warnings = [];

if (!existsSync(manifestPath)) {
  errors.push('Missing public/avatar-clips/mixamo-manifest.json.');
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.clips)) errors.push('mixamo-manifest.clips must be an array.');
  const ids = new Set();
  for (const clip of manifest.clips ?? []) {
    if (!clip.id || typeof clip.id !== 'string') errors.push('clip.id is required.');
    if (ids.has(clip.id)) errors.push(`duplicate clip id: ${clip.id}`);
    ids.add(clip.id);
    const file = clip.file ? path.resolve(ROOT, clip.file) : '';
    if (!file || !existsSync(file)) errors.push(`${clip.id}: missing file ${clip.file}`);
    if (!file.startsWith(path.join(ROOT, 'public', 'avatar-clips', '_incoming', 'mixamo'))) {
      errors.push(`${clip.id}: file must stay under public/avatar-clips/_incoming/mixamo.`);
    }
    if (clip.autoLoad !== false) errors.push(`${clip.id}: raw Mixamo clips must use autoLoad=false.`);
    if (clip.seatedRuntime !== false) errors.push(`${clip.id}: raw Mixamo clips must use seatedRuntime=false until converted.`);
    if (clip.playbackMask !== 'upper_body') errors.push(`${clip.id}: playbackMask must be upper_body.`);
    if (clip.licenseStatus !== 'debug_only') errors.push(`${clip.id}: licenseStatus must remain debug_only before promotion.`);
    if (!clip.sha256 || typeof clip.sha256 !== 'string') errors.push(`${clip.id}: sha256 is required.`);
    if (!clip.licenseNote) errors.push(`${clip.id}: licenseNote is required.`);
    if (file && existsSync(file)) {
      const ext = path.extname(file).toLowerCase();
      if (!['.fbx', '.dae', '.glb', '.gltf'].includes(ext)) errors.push(`${clip.id}: unsupported extension ${ext}.`);
      const bytes = readFileSync(file);
      if (bytes.byteLength > 25 * 1024 * 1024) warnings.push(`${clip.id}: file is large; keep only reviewed compact clips.`);
      if (ext === '.glb' || ext === '.gltf' || ext === '.dae') {
        const text = ext === '.glb' ? '' : bytes.toString('utf8').slice(0, 500000);
        if (text && !/Hips|Spine|Head|Arm|mixamorig/i.test(text)) {
          warnings.push(`${clip.id}: humanoid bone names were not detected by text inspection.`);
        }
      }
    }
  }
}

const ok = errors.length === 0;
console.log(JSON.stringify({ ok, errors, warnings }, null, 2));
if (!ok) process.exit(1);
