#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARKIT_52 = [
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeWideLeft',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawOpen',
  'jawRight',
  'mouthClose',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthFunnel',
  'mouthLeft',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthPucker',
  'mouthRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'noseSneerLeft',
  'noseSneerRight',
  'tongueOut',
];

const REQUIRED_PRESETS = [
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
  'neutral',
];

export function parseGlb(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.subarray(0, 4).toString('utf8') !== 'glTF') {
    throw new Error(`${filePath} is not a binary glTF/VRM file.`);
  }
  const chunks = [];
  let offset = 12;
  while (offset < buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString('utf8');
    const dataStart = offset + 8;
    chunks.push({
      type: chunkType,
      data: buffer.subarray(dataStart, dataStart + chunkLength),
    });
    offset = dataStart + chunkLength;
  }
  const jsonChunk = chunks.find((chunk) => chunk.type === 'JSON');
  if (!jsonChunk) throw new Error(`${filePath} has no JSON chunk.`);
  const json = JSON.parse(jsonChunk.data.toString('utf8').replace(/\0+$/, '').trimEnd());
  return {
    buffer,
    json,
    chunks,
    binChunk: chunks.find((chunk) => chunk.type === 'BIN\0'),
  };
}

export function inspectVrmBlendshapes(filePath) {
  const { buffer, json } = parseGlb(filePath);
  const meshes = json.meshes ?? [];
  const faceMeshes = meshes
    .map((mesh, index) => {
      const targetNames = mesh.extras?.targetNames ?? mesh.primitives?.[0]?.extras?.targetNames ?? [];
      return {
        index,
        name: mesh.name ?? `mesh_${index}`,
        targetNames,
        primitiveTargetCounts: (mesh.primitives ?? []).map((primitive) => primitive.targets?.length ?? 0),
      };
    })
    .filter((mesh) => /face/i.test(mesh.name) || mesh.targetNames.length > 0);

  const allTargetNames = [...new Set(faceMeshes.flatMap((mesh) => mesh.targetNames))];
  const presetExpressions = Object.keys(json.extensions?.VRMC_vrm?.expressions?.preset ?? {});
  const customExpressions = Object.keys(json.extensions?.VRMC_vrm?.expressions?.custom ?? {});
  const arkitPresent = ARKIT_52.filter((name) => allTargetNames.includes(name));
  const arkitMissing = ARKIT_52.filter((name) => !allTargetNames.includes(name));
  const missingPresets = REQUIRED_PRESETS.filter((name) => !presetExpressions.includes(name));
  const criticalTargets = [
    'browDownLeft',
    'browDownRight',
    'browInnerUp',
    'eyeBlinkLeft',
    'eyeBlinkRight',
    'eyeSquintLeft',
    'eyeSquintRight',
    'eyeWideLeft',
    'eyeWideRight',
    'jawOpen',
    'mouthClose',
    'mouthFunnel',
    'mouthPucker',
    'mouthSmileLeft',
    'mouthSmileRight',
    'mouthFrownLeft',
    'mouthFrownRight',
    'mouthStretchLeft',
    'mouthStretchRight',
  ];
  const missingCriticalTargets = criticalTargets.filter((name) => !allTargetNames.includes(name));

  return {
    file: filePath,
    bytes: buffer.length,
    vrmVersion: json.extensions?.VRMC_vrm ? '1.0' : json.extensions?.VRM ? '0.x' : 'unknown',
    presetExpressions,
    customExpressions,
    missingPresets,
    faceMeshes: faceMeshes.map((mesh) => ({
      index: mesh.index,
      name: mesh.name,
      targetNameCount: mesh.targetNames.length,
      primitiveTargetCounts: mesh.primitiveTargetCounts,
    })),
    arkit: {
      expectedCount: ARKIT_52.length,
      presentCount: arkitPresent.length,
      missingCount: arkitMissing.length,
      present: arkitPresent,
      missing: arkitMissing,
      missingCriticalTargets,
      usableForRuntime: missingPresets.length === 0 && missingCriticalTargets.length === 0,
    },
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/inspect-vrm-blendshapes.mjs <model.vrm>');
    process.exit(1);
  }
  const report = inspectVrmBlendshapes(path.resolve(filePath));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.arkit.usableForRuntime || report.arkit.presentCount === 0 ? 0 : 2);
}
