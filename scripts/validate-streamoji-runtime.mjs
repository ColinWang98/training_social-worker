#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ARKIT_52, parseGlb } from './inspect-vrm-blendshapes.mjs';

const AVATAR_CONFIG = path.resolve('src/lib/avatarConfig.ts');
const STREAMOJI_MODEL = path.resolve('public/models/streamoji-avatar-0sFGvLNDtV76PHuF5Rb9.glb');
const MOUTH_TARGETS = ARKIT_52.filter((name) => /^(jaw|mouth|tongue)/.test(name));

function fail(message) {
  console.error(`[avatar:streamoji:test] ${message}`);
  process.exitCode = 1;
}

function assertDefaultAvatar() {
  const source = fs.readFileSync(AVATAR_CONFIG, 'utf8');
  if (!/DEFAULT_AVATAR_ID[^=]*=\s*['"]john-do-arkit['"]/.test(source)) {
    fail('DEFAULT_AVATAR_ID must be john-do-arkit.');
  }
}

function collectArkitTargets(json) {
  const names = new Set();
  (json.meshes ?? []).forEach((mesh) => {
    const targetNames = mesh.extras?.targetNames ?? mesh.primitives?.[0]?.extras?.targetNames ?? [];
    targetNames.forEach((name) => {
      if (ARKIT_52.includes(name)) names.add(name);
    });
  });
  return names;
}

function inspectMouthMeshes(json, binChunk) {
  const drivenMouthMeshes = [];
  (json.meshes ?? []).forEach((mesh, meshIndex) => {
    const targetNames = mesh.extras?.targetNames ?? mesh.primitives?.[0]?.extras?.targetNames ?? [];
    let effectiveMouthTargetCount = 0;
    (mesh.primitives ?? []).forEach((primitive) => {
      MOUTH_TARGETS.forEach((targetName) => {
        const targetIndex = targetNames.indexOf(targetName);
        if (targetIndex < 0) return;
        const accessorIndex = primitive.targets?.[targetIndex]?.POSITION;
        if (typeof accessorIndex === 'number' && maxAccessorMagnitude(json, binChunk.data, accessorIndex) > 1e-6) {
          effectiveMouthTargetCount += 1;
        }
      });
    });
    if (effectiveMouthTargetCount > 0) {
      drivenMouthMeshes.push({
        meshIndex,
        name: mesh.name ?? `mesh_${meshIndex}`,
        effectiveMouthTargetCount,
      });
    }
  });
  return drivenMouthMeshes;
}

function inspectRigCandidates(json) {
  const nodes = json.nodes ?? [];
  const parents = new Map();
  nodes.forEach((node, index) => {
    (node.children ?? []).forEach((child) => parents.set(child, index));
  });

  return nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => normalizedName(node.name) === 'hips')
    .map(({ index }) => {
      const names = collectDescendantNames(nodes, index);
      const has = (pattern) => names.some((name) => pattern.test(name));
      const score =
        (has(/spine/) ? 3 : 0) +
        (has(/neck/) ? 2 : 0) +
        (has(/head/) ? 2 : 0) +
        (has(/shoulder/) ? 1 : 0) +
        (has(/upperarm/) ? 2 : 0) +
        (has(/lowerarm/) ? 2 : 0) +
        (has(/hand/) ? 2 : 0) +
        (has(/upperleg|lowerleg|foot|toe/) ? 2 : 0);
      return {
        nodeIndex: index,
        nodeName: nodes[index].name ?? `node_${index}`,
        parentName: typeof parents.get(index) === 'number' ? nodes[parents.get(index)].name : null,
        score,
        hasHead: has(/head/),
        hasHands: has(/hand/),
        hasLegs: has(/upperleg|lowerleg|foot|toe/),
        descendantCount: names.length,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function collectDescendantNames(nodes, rootIndex) {
  const names = [];
  const stack = [rootIndex];
  const seen = new Set();
  while (stack.length) {
    const index = stack.pop();
    if (seen.has(index)) continue;
    seen.add(index);
    const node = nodes[index];
    names.push(normalizedName(node?.name));
    (node?.children ?? []).forEach((child) => stack.push(child));
  }
  return names;
}

function normalizedName(name = '') {
  return String(name)
    .replace(/^mixamorig[:_]?/i, '')
    .replace(/^.+:/, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
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
    max = Math.max(
      max,
      Math.abs(binBuffer.readFloatLE(offset)),
      Math.abs(binBuffer.readFloatLE(offset + 4)),
      Math.abs(binBuffer.readFloatLE(offset + 8)),
    );
  }
  return max;
}

assertDefaultAvatar();
if (!fs.existsSync(STREAMOJI_MODEL)) {
  fail(`Missing Streamoji model: ${STREAMOJI_MODEL}`);
} else {
  const { json, binChunk } = parseGlb(STREAMOJI_MODEL);
  if (!binChunk) {
    fail('Streamoji GLB has no binary chunk.');
  } else {
    const arkitTargets = collectArkitTargets(json);
    const drivenMouthMeshes = inspectMouthMeshes(json, binChunk);
    const rigCandidates = inspectRigCandidates(json);
    const primaryRig = rigCandidates[0];
    const secondaryRigCount = rigCandidates.filter((rig) => rig.score >= 5).length;

    if (arkitTargets.size < 52) fail(`Streamoji has ${arkitTargets.size}/52 ARKit targets.`);
    if (drivenMouthMeshes.length < 1) fail('Streamoji has no effective mouth mesh for lip sync.');
    if (!primaryRig || primaryRig.score < 10) fail('Streamoji has no high-confidence humanoid body rig.');
    if (secondaryRigCount < 2) fail('Streamoji should expose at least two drivable humanoid rig candidates.');

    console.log(JSON.stringify({
      model: path.relative(process.cwd(), STREAMOJI_MODEL),
      defaultAvatar: 'john-do-arkit',
      arkitTargetCount: arkitTargets.size,
      drivenMouthMeshes,
      rigCandidates: rigCandidates.slice(0, 5),
      usable: process.exitCode !== 1,
    }, null, 2));
  }
}

process.exit(process.exitCode === 1 ? 1 : 0);
