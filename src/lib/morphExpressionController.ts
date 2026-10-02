import type { Mesh, Object3D } from 'three';
import type { ArkitBlendshapeName, ArkitBlendshapeWeights } from './avatarConfig';

export const ARKIT_NAMES: ArkitBlendshapeName[] = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight', 'eyeBlinkLeft', 'eyeBlinkRight',
  'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight', 'mouthClose',
  'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];
const names = new Set<string>(ARKIT_NAMES);
export function isArkitName(name: string): name is ArkitBlendshapeName { return names.has(name); }
export function isMouthArkitName(name: string) { return /^(jaw|mouth|tongue)/.test(name); }
const clamp = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;

export function composeFacialWeights(
  emotion: ArkitBlendshapeWeights, viseme: ArkitBlendshapeWeights,
  blink: ArkitBlendshapeWeights, speaking: boolean,
): ArkitBlendshapeWeights {
  const weights = { ...emotion };
  // During speech the mouth has one owner, including gaps/rest in the audio timeline.
  if (speaking) {
    for (const name of ARKIT_NAMES.filter(isMouthArkitName)) delete weights[name];
  }
  Object.assign(weights, viseme, blink);
  for (const side of ['Left', 'Right'] as const) {
    const closure = clamp(weights[`eyeBlink${side}`] ?? 0);
    for (const feature of ['eyeWide', 'eyeSquint'] as const) {
      const key = `${feature}${side}` as ArkitBlendshapeName;
      if (weights[key] !== undefined) weights[key] = clamp(weights[key]!) * (1 - closure);
    }
  }
  return weights;
}

type MorphGroup = { indices: number[]; names: string[]; arkitNames: ArkitBlendshapeName[]; outputIndex: number };
export type ExpressionCapabilities = {
  namedTargets: number;
  effectiveTargets: number;
  independentGroups: number;
  unsupportedNames: string[];
  aliasedGroups: string[][];
  meshes: Array<{ name: string; effectiveNames: string[]; zeroNames: string[]; invalidNames: string[]; groups: string[][] }>;
};

// Inspect every vertex once at load time. Sampling misses localized lip/brow deltas.
function inspectMesh(mesh: Mesh) {
  const dictionary = mesh.morphTargetDictionary ?? {};
  if (!Object.keys(dictionary).some(isArkitName)) return { groups: [], zeroNames: [], invalidNames: [] };
  const geometry = mesh.geometry;
  const count = geometry.attributes.position?.count ?? 0;
  const groups: MorphGroup[] = [];
  const buckets = new Map<number, Array<{ values: Float32Array; group: MorphGroup }>>();
  const zeroNames: string[] = [];
  const invalidNames: string[] = [];
  for (const [name, index] of Object.entries(dictionary)) {
    const position = geometry.morphAttributes.position?.[index];
    const normal = geometry.morphAttributes.normal?.[index];
    if (!position || position.count !== count || !count || (normal && normal.count !== count)) {
      if (isArkitName(name)) invalidNames.push(name);
      continue;
    }
    const values = new Float32Array(count * (normal ? 6 : 3));
    let maxPosition = 0;
    let valid = true;
    let cursor = 0;
    for (const [attribute, base, isPosition] of [
      [position, geometry.attributes.position, true],
      [normal, geometry.attributes.normal, false],
    ] as const) {
      if (!attribute) continue;
      if (!geometry.morphTargetsRelative && !base) { valid = false; break; }
      for (let i = 0; i < count; i += 1) {
        for (const getter of ['getX', 'getY', 'getZ'] as const) {
          const value = attribute[getter](i) - (geometry.morphTargetsRelative ? 0 : base[getter](i));
          if (!Number.isFinite(value)) valid = false;
          values[cursor++] = value === 0 ? 0 : value;
          if (isPosition) maxPosition = Math.max(maxPosition, Math.abs(value));
        }
      }
    }
    if (!valid) { if (isArkitName(name)) invalidNames.push(name); continue; }
    if (maxPosition <= 1e-6) { if (isArkitName(name)) zeroNames.push(name); continue; }
    let hash = 2166136261;
    for (const word of new Uint32Array(values.buffer)) hash = Math.imul(hash ^ word, 16777619) >>> 0;
    const bucket = buckets.get(hash) ?? [];
    // Exact comparison after hashing prevents collisions merging unrelated shapes.
    const existing = bucket.find((item) => item.values.length === values.length && item.values.every((v, i) => v === values[i]));
    const group = existing?.group ?? { indices: [], names: [], arkitNames: [], outputIndex: index };
    group.indices.push(index);
    group.names.push(name);
    if (isArkitName(name)) {
      if (!group.arkitNames.length) group.outputIndex = index;
      group.arkitNames.push(name);
    }
    if (!existing) { groups.push(group); bucket.push({ values, group }); buckets.set(hash, bucket); }
  }
  return { groups: groups.filter((g) => g.arkitNames.length), zeroNames, invalidNames };
}

export function createMorphTargetExpressionController(scene: Object3D, modelPath: string) {
  const targets: Array<{ mesh: Mesh; groups: MorphGroup[]; disabled: number[]; current: number[] }> = [];
  const effective = new Set<string>();
  const named = new Set<string>();
  const capabilities: ExpressionCapabilities = {
    namedTargets: 0, effectiveTargets: 0, independentGroups: 0, unsupportedNames: [], aliasedGroups: [], meshes: [],
  };
  let drivenMouthTargetCount = 0;
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences || !mesh.geometry) return;
    Object.keys(mesh.morphTargetDictionary).filter(isArkitName).forEach((name) => named.add(name));
    const inspection = inspectMesh(mesh);
    const effectiveNames = inspection.groups.flatMap((g) => g.arkitNames);
    effectiveNames.forEach((name) => effective.add(name));
    drivenMouthTargetCount += effectiveNames.filter(isMouthArkitName).length;
    capabilities.independentGroups += inspection.groups.length;
    capabilities.aliasedGroups.push(...inspection.groups.filter((g) => g.arkitNames.length > 1).map((g) => g.arkitNames));
    capabilities.meshes.push({ name: mesh.name, effectiveNames, zeroNames: inspection.zeroNames,
      invalidNames: inspection.invalidNames, groups: inspection.groups.map((g) => g.names) });
    targets.push({ mesh, groups: inspection.groups, current: inspection.groups.map(() => 0),
      disabled: [...inspection.zeroNames, ...inspection.invalidNames].map((name) => mesh.morphTargetDictionary![name]) });
  });
  capabilities.namedTargets = named.size;
  capabilities.effectiveTargets = effective.size;
  capabilities.unsupportedNames = ARKIT_NAMES.filter((name) => !effective.has(name));
  const has = (...keys: string[]) => keys.every((key) => effective.has(key));
  const controller = {
    modelPath, capabilities, arkitTargetCount: named.size, drivenMouthTargetCount,
    ownsEmotion: has('browDownLeft', 'browDownRight', 'browInnerUp', 'mouthFrownLeft', 'mouthFrownRight'),
    ownsBlink: has('eyeBlinkLeft', 'eyeBlinkRight'),
    ownsViseme: has('jawOpen', 'mouthClose', 'mouthFunnel', 'mouthPucker'),
    reset() {
      targets.forEach(({ mesh, groups, disabled, current }) => {
        current.fill(0);
        [...disabled, ...groups.flatMap((g) => g.indices)].forEach((i) => { mesh.morphTargetInfluences![i] = 0; });
      });
    },
    apply(weights: ArkitBlendshapeWeights, delta: number, speaking = false) {
      const dt = Number.isFinite(delta) ? Math.max(0, Math.min(delta, 0.1)) : 0;
      targets.forEach(({ mesh, groups, disabled, current }) => {
        const influences = mesh.morphTargetInfluences!;
        disabled.forEach((i) => { influences[i] = 0; });
        groups.forEach((group, i) => {
          const mouth = group.arkitNames.some(isMouthArkitName);
          // One physical shape, one weight. Aliases must not sum, including original VRM presets.
          const target = Math.max(0, ...group.arkitNames.map((name) => clamp(weights[name] ?? 0)));
          const blink = group.arkitNames.some((name) => name.startsWith('eyeBlink'));
          const tau = mouth ? (target > current[i] ? 0.045 : 0.09) : blink ? 0.025 : target > current[i] ? 0.09 : 0.24;
          current[i] += (target - current[i]) * (1 - Math.exp(-dt / tau));
          // Audio cancellation has no lingering viseme release; resting emotion is retained.
          if (mouth && !speaking && target === 0) current[i] = 0;
          if (target === 0 && current[i] < 0.0001) current[i] = 0;
          group.indices.forEach((index) => { influences[index] = 0; });
          influences[group.outputIndex] = current[i];
        });
      });
    },
  };
  return controller;
}
