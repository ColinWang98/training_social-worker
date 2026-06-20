import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localManifestPath = path.join(ROOT, 'public', 'avatar-clips', '_incoming', 'mixamo', 'manifest.local.json');
const trackedManifestPath = path.join(ROOT, 'public', 'avatar-clips', 'mixamo-manifest.json');
const manifestPath = fs.existsSync(localManifestPath) ? localManifestPath : trackedManifestPath;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const loader = new FBXLoader();
const errors = [];
const runtimeCandidates = [];

for (const clip of manifest.clips ?? []) {
  if (isRuntimeCandidate(clip)) runtimeCandidates.push(clip);
  if (/struck/i.test(clip.label ?? clip.id) && isRuntimeCandidate(clip)) {
    errors.push(`${clip.id}: dramatic Struck In Head clip must not be runtime eligible.`);
  }
}

const inspected = [];
for (const clip of runtimeCandidates) {
  const filePath = path.join(ROOT, clip.file.replace(/^public\//, 'public/'));
  if (!fs.existsSync(filePath)) {
    inspected.push({ id: clip.id, status: 'missing_local_file' });
    continue;
  }
  const bytes = fs.readFileSync(filePath);
  const group = loader.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const animation = group.animations?.[0];
  if (!animation) {
    errors.push(`${clip.id}: no animation in FBX.`);
    continue;
  }
  const upperBodyTracks = animation.tracks.filter((track) => track.name.endsWith('.quaternion') && isUpperBodyMixamoTrack(track.name));
  const lowerBodyTracks = animation.tracks.filter((track) => /(hips|leg|foot|toe)/i.test(track.name));
  if (upperBodyTracks.length < 4) {
    errors.push(`${clip.id}: expected at least 4 upper-body quaternion tracks, found ${upperBodyTracks.length}.`);
  }
  inspected.push({
    id: clip.id,
    label: clip.label,
    status: 'ok',
    duration: Number(animation.duration.toFixed(3)),
    upperBodyTracks: upperBodyTracks.length,
    lowerBodyTracksIgnored: lowerBodyTracks.length,
  });
}

if (!runtimeCandidates.length && fs.existsSync(localManifestPath)) {
  errors.push('Local Mixamo manifest exists but no runtime candidates were selected.');
}

const result = {
  ok: errors.length === 0,
  manifest: path.relative(ROOT, manifestPath),
  runtimeCandidateCount: runtimeCandidates.length,
  inspected,
  errors,
};

console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exit(1);

function isRuntimeCandidate(clip) {
  const label = String(clip.label ?? clip.id ?? '').toLowerCase();
  if (label.includes('struck')) return false;
  if (clip.licenseStatus && clip.licenseStatus !== 'debug_only') return false;
  return /(sitting idle|sitting talking|rubbing arm|disbelief|^sitting( |$|1|2))/i.test(clip.label ?? clip.id ?? '');
}

function isUpperBodyMixamoTrack(trackName) {
  const name = trackName.toLowerCase();
  if (/(hips|root|upperleg|lowerleg|foot|toe|leg)/.test(name)) return false;
  return /(spine|neck|head|shoulder|arm|forearm|hand)/.test(name);
}
