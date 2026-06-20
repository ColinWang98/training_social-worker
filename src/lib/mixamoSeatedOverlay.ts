import * as THREE from 'three';
import { AvatarPerformancePlan } from './interviewTypes';
import {
  AvatarReactionFamily,
  SeatedMotionArmOffsets,
  SeatedMotionPoseOffsets,
  SeatedMotionSample,
} from './seatedMotionLanguage';

type MixamoManifestEntry = {
  id: string;
  label?: string;
  file: string;
  family?: AvatarReactionFamily;
  intendedUse?: string;
  licenseStatus?: string;
};

type MixamoManifest = {
  clips: MixamoManifestEntry[];
};

type MixamoUpperBodyBone =
  | 'spine'
  | 'spine1'
  | 'spine2'
  | 'neck'
  | 'head'
  | 'leftShoulder'
  | 'rightShoulder'
  | 'leftUpperArm'
  | 'rightUpperArm'
  | 'leftLowerArm'
  | 'rightLowerArm'
  | 'leftHand'
  | 'rightHand';

type MixamoQuaternionTrack = {
  bone: MixamoUpperBodyBone;
  rest: THREE.Quaternion;
  interpolant: { evaluate: (time: number) => ArrayLike<number> };
};

type MixamoRuntimeClip = {
  id: string;
  label: string;
  family: AvatarReactionFamily;
  duration: number;
  tracks: MixamoQuaternionTrack[];
};

type MixamoPerformanceState = {
  reactionWeight: number;
};

type MixamoOverlayInput = {
  plan?: AvatarPerformancePlan;
  performanceState: MixamoPerformanceState;
  idlePhraseId: string;
  speechLevel: number;
  elapsed: number;
  delta: number;
  activeIntensity: number;
};

export type MixamoOverlayFrame = {
  sample?: SeatedMotionSample;
  clipId: string;
  status: string;
  weight: number;
};

export function createMixamoOverlayController() {
  let loadStarted = false;
  let clips: MixamoRuntimeClip[] = [];
  let status = 'not_loaded';
  let activeClipId = '';
  let activeStartedAt = 0;
  let activeWeight = 0;

  return {
    load() {
      if (loadStarted) return;
      loadStarted = true;
      status = 'loading';
      loadMixamoRuntimeClips()
        .then((loaded) => {
          clips = loaded;
          status = loaded.length ? `loaded:${loaded.length}` : 'unavailable';
        })
        .catch((error) => {
          status = `fallback:${error instanceof Error ? error.message : String(error)}`;
          clips = [];
        });
    },
    update(input: MixamoOverlayInput): MixamoOverlayFrame {
      if (!clips.length) {
        activeWeight = dampValue(activeWeight, 0, input.delta, 0.24);
        return { clipId: 'none', status, weight: activeWeight };
      }

      const selection = selectMixamoOverlayClip(clips, input);
      if (!selection) {
        activeWeight = dampValue(activeWeight, 0, input.delta, 0.35);
        return { clipId: 'none', status, weight: activeWeight };
      }
      if (selection.clip.id !== activeClipId) {
        activeClipId = selection.clip.id;
        activeStartedAt = input.elapsed;
      }
      activeWeight = dampValue(activeWeight, selection.weight, input.delta, 0.52);
      if (activeWeight <= 0.004) {
        return { clipId: selection.clip.id, status, weight: activeWeight };
      }
      return {
        sample: sampleMixamoRuntimeClip(selection.clip, input.elapsed - activeStartedAt, input.activeIntensity),
        clipId: selection.clip.id,
        status,
        weight: activeWeight,
      };
    },
  };
}

async function loadMixamoRuntimeClips(): Promise<MixamoRuntimeClip[]> {
  const manifest = await fetchMixamoManifest();
  if (!manifest?.clips?.length) return [];
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const loader = new FBXLoader();
  const entries = manifest.clips.filter(isRuntimeMixamoCandidate).slice(0, 7);
  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      const group = await loader.loadAsync(publicAssetPath(entry.file));
      const clip = group.animations[0];
      if (!clip) throw new Error(`${entry.label ?? entry.id}: no animation clip`);
      const runtimeClip = createMixamoRuntimeClip(entry, clip);
      if (runtimeClip.tracks.length < 4) {
        throw new Error(`${entry.label ?? entry.id}: too few upper-body tracks`);
      }
      return runtimeClip;
    }),
  );
  return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

async function fetchMixamoManifest(): Promise<MixamoManifest | null> {
  const candidates = [
    '/avatar-clips/_incoming/mixamo/manifest.local.json',
    '/avatar-clips/mixamo-manifest.json',
  ];
  for (const url of candidates) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) continue;
      const manifest = await response.json();
      if (isMixamoManifest(manifest)) return manifest;
    } catch {
      // Missing local Mixamo files are expected on clean clones and deployed builds.
    }
  }
  return null;
}

function isMixamoManifest(value: unknown): value is MixamoManifest {
  const manifest = value as MixamoManifest;
  return Array.isArray(manifest?.clips) && manifest.clips.every((clip) =>
    typeof clip.id === 'string' &&
    typeof clip.file === 'string',
  );
}

function isRuntimeMixamoCandidate(entry: MixamoManifestEntry) {
  const label = (entry.label ?? entry.id).toLowerCase();
  if (label.includes('struck')) return false;
  if (entry.licenseStatus && entry.licenseStatus !== 'debug_only') return false;
  return /(sitting idle|sitting talking|rubbing arm|disbelief|^sitting( |$|1|2))/i.test(entry.label ?? entry.id);
}

function publicAssetPath(file: string) {
  const path = file.startsWith('public/') ? `/${file.slice('public/'.length)}` : file.startsWith('/') ? file : `/${file}`;
  return encodeURI(path);
}

function createMixamoRuntimeClip(entry: MixamoManifestEntry, clip: THREE.AnimationClip): MixamoRuntimeClip {
  const tracks = clip.tracks.flatMap((track) => {
    if (!track.name.endsWith('.quaternion')) return [];
    const boneName = track.name.split('.')[0];
    const bone = mixamoUpperBodyBone(boneName);
    if (!bone || track.values.length < 4) return [];
    const rest = new THREE.Quaternion(
      track.values[0],
      track.values[1],
      track.values[2],
      track.values[3],
    ).normalize();
    return [{
      bone,
      rest,
      interpolant: createTrackInterpolant(track),
    }];
  });
  return {
    id: entry.id,
    label: entry.label ?? entry.id,
    family: entry.family ?? 'soft_engagement',
    duration: Math.max(0.4, clip.duration),
    tracks,
  };
}

function createTrackInterpolant(track: THREE.KeyframeTrack): { evaluate: (time: number) => ArrayLike<number> } {
  const runtimeTrack = track as THREE.KeyframeTrack & {
    createInterpolant?: (result: Float32Array) => { evaluate: (time: number) => ArrayLike<number> };
  };
  if (typeof runtimeTrack.createInterpolant === 'function') {
    return runtimeTrack.createInterpolant(new Float32Array(4));
  }
  return {
    evaluate() {
      return track.values.slice(0, 4);
    },
  };
}

function mixamoUpperBodyBone(name: string): MixamoUpperBodyBone | null {
  const clean = name.replace(/^mixamorig/i, '').toLowerCase();
  if (clean === 'spine') return 'spine';
  if (clean === 'spine1') return 'spine1';
  if (clean === 'spine2') return 'spine2';
  if (clean === 'neck') return 'neck';
  if (clean === 'head') return 'head';
  if (clean === 'leftshoulder') return 'leftShoulder';
  if (clean === 'rightshoulder') return 'rightShoulder';
  if (clean === 'leftarm') return 'leftUpperArm';
  if (clean === 'rightarm') return 'rightUpperArm';
  if (clean === 'leftforearm') return 'leftLowerArm';
  if (clean === 'rightforearm') return 'rightLowerArm';
  if (clean === 'lefthand') return 'leftHand';
  if (clean === 'righthand') return 'rightHand';
  return null;
}

function selectMixamoOverlayClip(clips: MixamoRuntimeClip[], input: MixamoOverlayInput) {
  const plan = input.plan;
  const reason = plan?.reactionReason ?? 'idle';
  if (reason === 'risk' || plan?.reactionFamily === 'risk') return null;
  const reactionActive = input.performanceState.reactionWeight > 0.08;
  if (reactionActive && !plan?.idleMixOnly) {
    const defensive = findMixamoClip(clips, 'disbelief');
    return defensive && plan?.reactionFamily === 'defensive'
      ? { clip: defensive, weight: 0.055 }
      : null;
  }
  if (input.speechLevel > 0.05) {
    const talking = findMixamoClip(clips, 'talking');
    if (talking) return { clip: talking, weight: Math.min(0.16, 0.08 + input.speechLevel * 0.12) };
  }
  const family = plan?.idleAccentFamily ?? plan?.reactionFamily ?? familyForIdlePhrase(input.idlePhraseId);
  if (family === 'anxious' || family === 'ashamed' || input.idlePhraseId.includes('fidget') || input.idlePhraseId.includes('hand')) {
    const rubbing = findMixamoClip(clips, 'rubbing');
    if (rubbing) return { clip: rubbing, weight: 0.12 };
  }
  const idle = findMixamoClip(clips, 'idle') ?? findMixamoClip(clips, 'sitting 1') ?? findMixamoClip(clips, 'sitting');
  return idle ? { clip: idle, weight: 0.08 } : null;
}

function findMixamoClip(clips: MixamoRuntimeClip[], labelNeedle: string) {
  const needle = labelNeedle.toLowerCase();
  return clips.find((clip) => clip.label.toLowerCase().includes(needle) || clip.id.toLowerCase().includes(needle));
}

function familyForIdlePhrase(id: string): AvatarReactionFamily {
  if (id.includes('fidget')) return 'anxious';
  if (id.includes('ashamed')) return 'ashamed';
  if (id.includes('downward') || id.includes('low_energy')) return 'withdrawn';
  if (id.includes('guarded')) return 'defensive';
  if (id.includes('nod')) return 'reflective';
  return 'soft_engagement';
}

function sampleMixamoRuntimeClip(
  clip: MixamoRuntimeClip,
  localTime: number,
  activeIntensity: number,
): SeatedMotionSample {
  const sample: SeatedMotionSample = { pose: {}, armPose: {} };
  const scale = Math.min(0.42, Math.max(0.12, activeIntensity * 0.22));
  const time = positiveModulo(localTime, clip.duration);
  clip.tracks.forEach((track) => {
    const raw = track.interpolant.evaluate(time);
    const current = new THREE.Quaternion(raw[0], raw[1], raw[2], raw[3]).normalize();
    const delta = track.rest.clone().invert().multiply(current);
    const euler = new THREE.Euler().setFromQuaternion(delta, 'XYZ');
    addMixamoEulerToSample(sample, track.bone, euler, scale);
  });
  return sample;
}

function addMixamoEulerToSample(
  sample: SeatedMotionSample,
  bone: MixamoUpperBodyBone,
  euler: THREE.Euler,
  scale: number,
) {
  const x = THREE.MathUtils.clamp(euler.x, -0.65, 0.65) * scale;
  const y = THREE.MathUtils.clamp(euler.y, -0.65, 0.65) * scale;
  const z = THREE.MathUtils.clamp(euler.z, -0.65, 0.65) * scale;

  if (bone === 'spine') {
    addSamplePose(sample, 'spineX', x * 0.42);
    addSamplePose(sample, 'spineY', y * 0.32);
  } else if (bone === 'spine1' || bone === 'spine2') {
    addSamplePose(sample, 'chestX', x * 0.38);
    addSamplePose(sample, 'chestY', y * 0.34);
    addSamplePose(sample, 'chestZ', z * 0.26);
  } else if (bone === 'neck') {
    addSamplePose(sample, 'neckX', x * 0.34);
    addSamplePose(sample, 'neckY', y * 0.34);
  } else if (bone === 'head') {
    addSamplePose(sample, 'headX', x * 0.36);
    addSamplePose(sample, 'headY', y * 0.36);
    addSamplePose(sample, 'headZ', z * 0.28);
  } else if (bone === 'leftUpperArm') {
    addSampleArm(sample, 'upperArmX', x * 0.16);
    addSampleArm(sample, 'leftUpperArmY', y * 0.22);
    addSampleArm(sample, 'leftUpperArmZ', z * 0.2);
  } else if (bone === 'rightUpperArm') {
    addSampleArm(sample, 'upperArmX', x * 0.16);
    addSampleArm(sample, 'rightUpperArmY', y * 0.22);
    addSampleArm(sample, 'rightUpperArmZ', z * 0.2);
  } else if (bone === 'leftLowerArm') {
    addSampleArm(sample, 'leftLowerArmX', x * 0.2);
    addSampleArm(sample, 'leftLowerArmY', y * 0.18);
    addSampleArm(sample, 'leftLowerArmZ', z * 0.16);
  } else if (bone === 'rightLowerArm') {
    addSampleArm(sample, 'rightLowerArmX', x * 0.2);
    addSampleArm(sample, 'rightLowerArmY', y * 0.18);
    addSampleArm(sample, 'rightLowerArmZ', z * 0.16);
  } else if (bone === 'leftHand') {
    addSampleArm(sample, 'handX', x * 0.12);
    addSampleArm(sample, 'leftHandY', y * 0.16);
    addSampleArm(sample, 'leftHandZ', z * 0.12);
  } else if (bone === 'rightHand') {
    addSampleArm(sample, 'handX', x * 0.12);
    addSampleArm(sample, 'rightHandY', y * 0.16);
    addSampleArm(sample, 'rightHandZ', z * 0.12);
  }
}

function addSamplePose(sample: SeatedMotionSample, key: keyof SeatedMotionPoseOffsets, value: number) {
  sample.pose[key] = (sample.pose[key] ?? 0) + value;
}

function addSampleArm(sample: SeatedMotionSample, key: keyof SeatedMotionArmOffsets, value: number) {
  sample.armPose[key] = (sample.armPose[key] ?? 0) + value;
}

function positiveModulo(value: number, modulus: number) {
  if (!Number.isFinite(value) || !Number.isFinite(modulus) || modulus <= 0) return 0;
  return ((value % modulus) + modulus) % modulus;
}

function dampValue(current: number, target: number, delta: number, timeConstant: number) {
  const alpha = 1 - Math.exp(-delta / Math.max(timeConstant, 0.001));
  return current + (target - current) * Math.min(1, Math.max(0, alpha));
}
