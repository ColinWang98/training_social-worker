import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BufferGeometry, Float32BufferAttribute, Group, Mesh } from 'three';
import ts from 'typescript';
import { parseGlb } from './inspect-vrm-blendshapes.mjs';

export async function loadExpressionModule() {
  const source = fs.readFileSync('src/lib/morphExpressionController.ts', 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

// The audit builds only geometry, never textures, a renderer, or a modified model.
export function readGeometryScene(file) {
  const { json, binChunk } = parseGlb(file);
  if (!binChunk) throw new Error('Missing GLB binary data');
  const bin = binChunk.data;
  const cache = new Map();
  function viewOffset(viewIndex, offset, length) {
    const view = json.bufferViews?.[viewIndex];
    if (!view || (view.buffer ?? 0) !== 0 || offset < 0 || offset + length > view.byteLength) throw new Error('Invalid buffer view');
    const start = (view.byteOffset ?? 0) + offset;
    if (start + length > bin.length) throw new Error('Accessor exceeds binary data');
    return start;
  }
  function attribute(index) {
    if (cache.has(index)) return cache.get(index);
    const a = json.accessors?.[index];
    if (!a || a.componentType !== 5126 || a.type !== 'VEC3' || a.normalized) throw new Error(`Unsupported geometry accessor ${index}`);
    const values = new Float32Array(a.count * 3);
    if (a.bufferView !== undefined) {
      const stride = json.bufferViews[a.bufferView].byteStride ?? 12;
      for (let i = 0; i < a.count; i++) {
        const start = viewOffset(a.bufferView, (a.byteOffset ?? 0) + i * stride, 12);
        for (let c = 0; c < 3; c++) values[i * 3 + c] = bin.readFloatLE(start + c * 4);
      }
    }
    if (a.sparse) {
      const s = a.sparse;
      const size = { 5121: 1, 5123: 2, 5125: 4 }[s.indices.componentType];
      if (!size) throw new Error('Unsupported sparse index type');
      for (let i = 0; i < s.count; i++) {
        const offset = viewOffset(s.indices.bufferView, (s.indices.byteOffset ?? 0) + i * size, size);
        const vertex = bin.readUIntLE(offset, size);
        if (vertex >= a.count) throw new Error('Sparse index out of range');
        const start = viewOffset(s.values.bufferView, (s.values.byteOffset ?? 0) + i * 12, 12);
        for (let c = 0; c < 3; c++) values[vertex * 3 + c] = bin.readFloatLE(start + c * 4);
      }
    }
    const result = new Float32BufferAttribute(values, 3);
    cache.set(index, result);
    return result;
  }
  const scene = new Group();
  for (const mesh of json.meshes ?? []) {
    for (const [i, primitive] of (mesh.primitives ?? []).entries()) {
      if (!primitive.targets?.length) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', attribute(primitive.attributes.POSITION));
      if (primitive.attributes.NORMAL !== undefined) geometry.setAttribute('normal', attribute(primitive.attributes.NORMAL));
      geometry.morphTargetsRelative = true;
      for (const [kind, semantic] of [['position', 'POSITION'], ['normal', 'NORMAL']]) {
        if (primitive.targets.some((t) => t[semantic] !== undefined)) {
          geometry.morphAttributes[kind] = primitive.targets.map((target) => target[semantic] !== undefined
            ? attribute(target[semantic]) : new Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3));
        }
      }
      const item = new Mesh(geometry);
      item.name = `${mesh.name ?? 'mesh'}:${i}`;
      const names = mesh.extras?.targetNames ?? primitive.extras?.targetNames ?? [];
      if (names.length !== primitive.targets.length) throw new Error(`Target/name mismatch: ${item.name}`);
      item.morphTargetDictionary = Object.fromEntries(names.map((name, index) => [name, index]));
      scene.add(item);
    }
  }
  return scene;
}

export async function auditModels() {
  const { createMorphTargetExpressionController } = await loadExpressionModule();
  return ['client-john-do-arkit.vrm', 'streamoji-avatar-0sFGvLNDtV76PHuF5Rb9.glb', 'client-haru.glb'].map((name) => {
    const file = `public/models/${name}`;
    const scene = readGeometryScene(file);
    const controller = createMorphTargetExpressionController(scene, file);
    const report = { file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      capabilities: controller.capabilities, ownership: { emotion: controller.ownsEmotion, blink: controller.ownsBlink, viseme: controller.ownsViseme },
      visualReview: 'pending', semanticAccuracy: 'not inferred from target names or geometry',
      assetPolicy: 'Source file unchanged; original model license still applies.' };
    scene.traverse((object) => { object.geometry?.dispose(); object.material?.dispose(); });
    return report;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = { version: 1, models: await auditModels() };
  const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
  if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify(report, null, 2));
}
