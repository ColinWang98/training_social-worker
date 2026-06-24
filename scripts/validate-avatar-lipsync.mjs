#!/usr/bin/env node
import path from 'node:path';
import { ARKIT_52, parseGlb } from './inspect-vrm-blendshapes.mjs';

const MODELS = [
  {
    id: 'john-do-arkit',
    file: 'public/models/client-john-do-arkit.vrm',
    requiredDrivenMouthMeshes: 1,
  },
  {
    id: 'streamoji-0sfg',
    file: 'public/models/streamoji-avatar-0sFGvLNDtV76PHuF5Rb9.glb',
    requiredDrivenMouthMeshes: 1,
  },
];

const MOUTH_TARGETS = ARKIT_52.filter((name) => /^(jaw|mouth|tongue)/.test(name));

function inspectLipSyncTargets(filePath) {
  const { json, binChunk } = parseGlb(filePath);
  if (!binChunk) throw new Error(`${filePath} has no binary chunk.`);
  const meshes = json.meshes ?? [];
  const meshReports = [];
  const arkitNames = new Set();

  meshes.forEach((mesh, meshIndex) => {
    const primitiveReports = [];
    const targetNames = mesh.extras?.targetNames ?? mesh.primitives?.[0]?.extras?.targetNames ?? [];
    targetNames.forEach((name) => {
      if (ARKIT_52.includes(name)) arkitNames.add(name);
    });

    (mesh.primitives ?? []).forEach((primitive, primitiveIndex) => {
      const targets = primitive.targets ?? [];
      const effectiveMouthTargets = [];
      const zeroMouthTargets = [];
      MOUTH_TARGETS.forEach((targetName) => {
        const targetIndex = targetNames.indexOf(targetName);
        if (targetIndex < 0) return;
        const target = targets[targetIndex];
        const accessorIndex = target?.POSITION;
        const magnitude = typeof accessorIndex === 'number'
          ? maxAccessorMagnitude(json, binChunk.data, accessorIndex)
          : 0;
        if (magnitude > 1e-6) {
          effectiveMouthTargets.push({ name: targetName, maxDelta: round(magnitude) });
        } else {
          zeroMouthTargets.push(targetName);
        }
      });
      if (effectiveMouthTargets.length || zeroMouthTargets.length) {
        primitiveReports.push({
          primitiveIndex,
          effectiveMouthTargetCount: effectiveMouthTargets.length,
          zeroMouthTargetCount: zeroMouthTargets.length,
          effectiveMouthTargets,
          zeroMouthTargets,
        });
      }
    });

    if (targetNames.length || primitiveReports.length) {
      meshReports.push({
        meshIndex,
        name: mesh.name ?? `mesh_${meshIndex}`,
        targetNameCount: targetNames.length,
        primitiveReports,
      });
    }
  });

  const drivenMouthMeshes = meshReports.filter((mesh) =>
    mesh.primitiveReports.some((primitive) => primitive.effectiveMouthTargetCount > 0),
  );
  return {
    file: filePath,
    arkitTargetCount: arkitNames.size,
    drivenMouthMeshCount: drivenMouthMeshes.length,
    drivenMouthMeshes: drivenMouthMeshes.map((mesh) => mesh.name),
    meshReports,
  };
}

function maxAccessorMagnitude(json, binBuffer, accessorIndex) {
  const accessor = json.accessors?.[accessorIndex];
  const bufferView = json.bufferViews?.[accessor?.bufferView];
  if (!accessor || !bufferView || accessor.componentType !== 5126 || accessor.type !== 'VEC3') return 0;
  const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = bufferView.byteStride ?? 12;
  let max = 0;
  for (let i = 0; i < accessor.count; i += 1) {
    const offset = byteOffset + i * stride;
    const x = binBuffer.readFloatLE(offset);
    const y = binBuffer.readFloatLE(offset + 4);
    const z = binBuffer.readFloatLE(offset + 8);
    max = Math.max(max, Math.abs(x), Math.abs(y), Math.abs(z));
  }
  return max;
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

const reports = MODELS.map((model) => ({
  id: model.id,
  ...inspectLipSyncTargets(path.resolve(model.file)),
  requiredDrivenMouthMeshes: model.requiredDrivenMouthMeshes,
}));

let failed = false;
reports.forEach((report) => {
  if (report.arkitTargetCount < 52) {
    failed = true;
    console.error(`[avatar:lip:test] ${report.id} has ${report.arkitTargetCount}/52 ARKit targets.`);
  }
  if (report.drivenMouthMeshCount < report.requiredDrivenMouthMeshes) {
    failed = true;
    console.error(`[avatar:lip:test] ${report.id} has no usable mouth target mesh.`);
  }
});

console.log(JSON.stringify({ reports }, null, 2));
process.exit(failed ? 1 : 0);
