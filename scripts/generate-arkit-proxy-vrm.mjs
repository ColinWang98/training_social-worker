#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARKIT_52, inspectVrmBlendshapes, parseGlb } from './inspect-vrm-blendshapes.mjs';

const DEFAULT_INPUT = 'public/models/client-john-do.vrm';
const DEFAULT_OUTPUT = 'public/models/client-john-do-arkit.vrm';
const DEFAULT_REPORT = 'public/models/client-john-do-arkit.report.json';

const PROXY_SOURCE_BY_ARKIT = {
  browDownLeft: 'Fcl_BRW_Angry',
  browDownRight: 'Fcl_BRW_Angry',
  browInnerUp: 'Fcl_BRW_Surprised',
  browOuterUpLeft: 'Fcl_BRW_Joy',
  browOuterUpRight: 'Fcl_BRW_Joy',
  cheekPuff: 'Fcl_MTH_Large',
  cheekSquintLeft: 'Fcl_EYE_Joy',
  cheekSquintRight: 'Fcl_EYE_Joy',
  eyeBlinkLeft: 'Fcl_EYE_Close_L',
  eyeBlinkRight: 'Fcl_EYE_Close_R',
  eyeSquintLeft: 'Fcl_EYE_Joy_L',
  eyeSquintRight: 'Fcl_EYE_Joy_R',
  eyeWideLeft: 'Fcl_EYE_Surprised',
  eyeWideRight: 'Fcl_EYE_Surprised',
  jawOpen: 'Fcl_MTH_O',
  mouthClose: 'Fcl_MTH_Close',
  mouthDimpleLeft: 'Fcl_MTH_Fun',
  mouthDimpleRight: 'Fcl_MTH_Fun',
  mouthFrownLeft: 'Fcl_MTH_Sorrow',
  mouthFrownRight: 'Fcl_MTH_Sorrow',
  mouthFunnel: 'Fcl_MTH_O',
  mouthLeft: 'Fcl_MTH_Fun',
  mouthLowerDownLeft: 'Fcl_MTH_O',
  mouthLowerDownRight: 'Fcl_MTH_O',
  mouthPressLeft: 'Fcl_MTH_Small',
  mouthPressRight: 'Fcl_MTH_Small',
  mouthPucker: 'Fcl_MTH_U',
  mouthRight: 'Fcl_MTH_Fun',
  mouthRollLower: 'Fcl_MTH_Close',
  mouthRollUpper: 'Fcl_MTH_Close',
  mouthShrugLower: 'Fcl_MTH_Small',
  mouthShrugUpper: 'Fcl_MTH_Small',
  mouthSmileLeft: 'Fcl_MTH_Joy',
  mouthSmileRight: 'Fcl_MTH_Joy',
  mouthStretchLeft: 'Fcl_MTH_E',
  mouthStretchRight: 'Fcl_MTH_E',
  mouthUpperUpLeft: 'Fcl_MTH_O',
  mouthUpperUpRight: 'Fcl_MTH_O',
};

const ZERO_ARKIT_TARGETS = new Set([
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'irisShrinkLeft',
  'irisShrinkRight',
  'jawForward',
  'jawLeft',
  'jawRight',
  'noseSneerLeft',
  'noseSneerRight',
  'tongueOut',
]);

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    report: DEFAULT_REPORT,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--input' && value) {
      args.input = value;
      index += 1;
    } else if (key === '--output' && value) {
      args.output = value;
      index += 1;
    } else if (key === '--report' && value) {
      args.report = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  return args;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function pad4(buffer, padByte = 0) {
  const remainder = buffer.length % 4;
  if (remainder === 0) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(4 - remainder, padByte)]);
}

function buildGlb(json, binChunk) {
  const jsonBuffer = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const chunks = [
    chunk('JSON', jsonBuffer),
  ];
  if (binChunk) {
    chunks.push(chunk('BIN\0', pad4(Buffer.from(binChunk.data), 0)));
  }
  const totalLength = 12 + chunks.reduce((sum, next) => sum + next.length, 0);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'utf8');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  return Buffer.concat([header, ...chunks]);
}

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.write(type, 4, 'utf8');
  return Buffer.concat([header, data]);
}

function findFaceMesh(json) {
  const meshes = json.meshes ?? [];
  const face = meshes
    .map((mesh, index) => ({ mesh, index }))
    .find(({ mesh }) => /face/i.test(mesh.name ?? '') && (mesh.primitives?.[0]?.targets?.length ?? 0) > 0);
  if (!face) throw new Error('No face mesh with morph targets found.');
  return face;
}

function getTargetNames(mesh, primitive) {
  if (!mesh.extras) mesh.extras = {};
  if (!primitive.extras) primitive.extras = {};
  const names = mesh.extras.targetNames ?? primitive.extras.targetNames;
  if (!Array.isArray(names)) throw new Error('Face mesh has no targetNames extras.');
  mesh.extras.targetNames = names;
  primitive.extras.targetNames = [...names];
  return mesh.extras.targetNames;
}

function appendZeroTarget(json, primitive, count) {
  const zeroBytes = Buffer.alloc(count * 3 * 4);
  const buffer = json.buffers?.[0];
  if (!buffer || typeof buffer.byteLength !== 'number') {
    throw new Error('Expected a single embedded GLB buffer.');
  }
  const byteOffset = buffer.byteLength;
  buffer.byteLength += zeroBytes.length;
  const positionBufferView = json.bufferViews.length;
  json.bufferViews.push({
    buffer: 0,
    byteOffset,
    byteLength: zeroBytes.length,
  });
  const normalBufferView = json.bufferViews.length;
  json.bufferViews.push({
    buffer: 0,
    byteOffset,
    byteLength: zeroBytes.length,
  });
  const positionAccessor = json.accessors.length;
  json.accessors.push({
    bufferView: positionBufferView,
    byteOffset: 0,
    componentType: 5126,
    count,
    type: 'VEC3',
    min: [0, 0, 0],
    max: [0, 0, 0],
  });
  const normalAccessor = json.accessors.length;
  json.accessors.push({
    bufferView: normalBufferView,
    byteOffset: 0,
    componentType: 5126,
    count,
    type: 'VEC3',
    min: [0, 0, 0],
    max: [0, 0, 0],
  });
  primitive.__zeroBytes = zeroBytes;
  return {
    POSITION: positionAccessor,
    NORMAL: normalAccessor,
  };
}

function normalizeTargetName(name) {
  return String(name).replace(/^Face\.M_F00_000_00_/, '');
}

function addArkitProxy(input, output, reportPath) {
  const inputPath = path.resolve(input);
  const outputPath = path.resolve(output);
  const { json, binChunk } = parseGlb(inputPath);
  const sourceInspection = inspectVrmBlendshapes(inputPath);
  const { mesh, index: faceMeshIndex } = findFaceMesh(json);
  const primitive = mesh.primitives[0];
  const targetNames = getTargetNames(mesh, primitive);
  const normalizedNameToIndex = new Map();
  targetNames.forEach((targetName, targetIndex) => {
    normalizedNameToIndex.set(normalizeTargetName(targetName), targetIndex);
  });

  const positionCount = json.accessors[primitive.attributes.POSITION].count;
  const zeroTarget = appendZeroTarget(json, primitive, positionCount);
  const mappings = [];

  for (const arkitName of ARKIT_52) {
    if (targetNames.includes(arkitName)) {
      mappings.push({ arkitName, mode: 'existing', source: arkitName });
      continue;
    }

    const sourceName = PROXY_SOURCE_BY_ARKIT[arkitName];
    const sourceIndex = sourceName ? normalizedNameToIndex.get(sourceName) : undefined;
    const target = typeof sourceIndex === 'number'
      ? clone(primitive.targets[sourceIndex])
      : clone(zeroTarget);
    primitive.targets.push(target);
    targetNames.push(arkitName);
    primitive.extras.targetNames.push(arkitName);
    mappings.push({
      arkitName,
      mode: typeof sourceIndex === 'number' ? 'proxy' : 'zero',
      source: typeof sourceIndex === 'number' ? targetNames[sourceIndex] : 'zero',
      reason: ZERO_ARKIT_TARGETS.has(arkitName) ? 'no reliable VRoid morph source' : undefined,
    });
  }

  if (!json.buffers?.[0]) throw new Error('Missing GLB buffer declaration.');
  const nextBin = Buffer.concat([Buffer.from(binChunk?.data ?? []), primitive.__zeroBytes]);
  delete primitive.__zeroBytes;
  json.buffers[0].byteLength = nextBin.length;
  const nextGlb = buildGlb(json, { type: 'BIN\0', data: nextBin });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, nextGlb);

  const outputInspection = inspectVrmBlendshapes(outputPath);
  const report = {
    generatedAt: new Date().toISOString(),
    method: 'local-arkit-proxy-from-vroid-morph-targets',
    vroidShaperAttempt: {
      used: false,
      note: 'VRoidShaper was evaluated first. Current model failed because its face vertex count differs from the bundled reference model.',
      source: 'https://github.com/Ultimationzzz/VRoidShaper',
    },
    input: {
      file: path.relative(process.cwd(), inputPath),
      sha256: sha256(inputPath),
      inspection: sourceInspection,
    },
    output: {
      file: path.relative(process.cwd(), outputPath),
      sha256: sha256(outputPath),
      inspection: outputInspection,
    },
    faceMeshIndex,
    mappings,
    licenseAndCredit: {
      modelCredit: 'Credit required by embedded VRM metadata for John Do / JTL.',
      generatedProxyNote: 'ARKit target names are local proxy morph targets derived from existing VRoid morph targets; no external face data is embedded.',
      redistribution: 'Do not redistribute outside the local prototype unless the original VRM license is clarified.',
    },
  };
  fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  try {
    const args = parseArgs(process.argv);
    const report = addArkitProxy(args.input, args.output, args.report);
    console.log(JSON.stringify({
      output: report.output.file,
      arkitPresent: report.output.inspection.arkit.presentCount,
      arkitMissing: report.output.inspection.arkit.missingCount,
      usableForRuntime: report.output.inspection.arkit.usableForRuntime,
      report: args.report,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}
