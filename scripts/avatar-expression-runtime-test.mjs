import assert from 'node:assert/strict';
import { BufferGeometry, Float32BufferAttribute, Mesh, Group } from 'three';
import { auditModels, loadExpressionModule, readGeometryScene } from './avatar-expression-audit.mjs';

const { createMorphTargetExpressionController: create, composeFacialWeights, ARKIT_NAMES } = await loadExpressionModule();
function fixture(definitions, relative = true) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(6000).fill(1), 3));
  geometry.morphTargetsRelative = relative;
  geometry.morphAttributes.position = Object.values(definitions).map((value) => {
    const array = new Float32Array(6000).fill(relative ? 0 : 1);
    // A local delta at vertex 1 would be missed by the old sparse sampling.
    array[3] += value;
    return new Float32BufferAttribute(array, 3);
  });
  const mesh = new Mesh(geometry);
  mesh.name = 'fixture';
  mesh.morphTargetDictionary = Object.fromEntries(Object.keys(definitions).map((key, i) => [key, i]));
  return mesh;
}
const mesh = fixture({ original: 0.1, browDownLeft: 0.1, browDownRight: 0.1, eyeLookDownLeft: 0, jawOpen: 0.2 });
const controller = create(mesh, 'fixture');
assert.equal(controller.capabilities.effectiveTargets, 3);
assert.equal(controller.capabilities.independentGroups, 2);
assert.ok(controller.capabilities.unsupportedNames.includes('eyeLookDownLeft'));
for (let frame = 0; frame < 180; frame++) {
  mesh.morphTargetInfluences[0] = 0.9; // Simulate VRM preset reapplication before our last writer.
  controller.apply({ browDownLeft: 0.5, browDownRight: 0.5, eyeLookDownLeft: 1, jawOpen: 0.6 }, 1 / 60, true);
}
assert.equal(mesh.morphTargetInfluences[0], 0);
assert.equal(mesh.morphTargetInfluences[2], 0);
assert.equal(mesh.morphTargetInfluences[3], 0);
assert.ok(Math.abs(mesh.morphTargetInfluences[1] - 0.5) < 0.001, 'Aliases use max, not sum');
controller.apply({}, 1 / 60, false);
assert.equal(mesh.morphTargetInfluences[4], 0, 'Cancelled mouth clears immediately');
assert.ok(mesh.morphTargetInfluences[1] > 0.4, 'Brows release independently');
controller.reset();
assert.ok(mesh.morphTargetInfluences.every((v) => v === 0));

const absolute = create(fixture({ jawOpen: 0.2, eyeLookDownLeft: 0 }, false), 'absolute');
assert.equal(absolute.capabilities.effectiveTargets, 1, 'Absolute morphs measured against base vertices');
const invalid = create(fixture({ jawOpen: NaN, mouthClose: 0.1 }), 'invalid');
assert.deepEqual(invalid.capabilities.meshes[0].invalidNames, ['jawOpen']);
assert.equal(invalid.ownsViseme, false);
const fallback = create(fixture({ Fcl_MTH_A: 0.3 }), 'vrm-only');
assert.equal(fallback.ownsEmotion, false);
assert.equal(fallback.ownsBlink, false);
assert.equal(fallback.ownsViseme, false);

const emotion = { browDownLeft: 0.5, eyeWideLeft: 0.4, mouthPressLeft: 0.7, mouthClose: 0.6 };
const speaking = composeFacialWeights(emotion, { jawOpen: 0.5 }, { eyeBlinkLeft: 1 }, true);
assert.equal(speaking.mouthPressLeft, undefined);
assert.equal(speaking.mouthClose, undefined);
assert.equal(speaking.browDownLeft, 0.5);
assert.equal(speaking.eyeWideLeft, 0);
assert.equal(speaking.jawOpen, 0.5);
assert.equal(composeFacialWeights(emotion, {}, {}, false).mouthPressLeft, 0.7);
assert.equal(composeFacialWeights(emotion, {}, {}, true).mouthClose, undefined, 'Cue gap does not re-enable emotion mouth');

function atRate(rate) {
  const mesh = fixture({ browDownLeft: 0.1 });
  const c = create(mesh, 'rate');
  for (let i = 0; i < rate; i++) c.apply({ browDownLeft: 0.5 }, 1 / rate);
  return mesh.morphTargetInfluences[0];
}
assert.ok(Math.abs(atRate(30) - atRate(120)) < 1e-6);
const multi = new Group();
multi.add(fixture({ jawOpen: 0 }), fixture({ jawOpen: 0.2 }));
const m = create(multi, 'multi');
m.apply({ jawOpen: 0.5 }, 0.1, true);
assert.equal(multi.children[0].morphTargetInfluences[0], 0);
assert.ok(multi.children[1].morphTargetInfluences[0] > 0);

const reports = await auditModels();
const john = reports[0];
assert.equal(john.capabilities.namedTargets, 52);
assert.equal(john.capabilities.effectiveTargets, 38);
assert.equal(john.capabilities.independentGroups, 18);
assert.equal(reports[1].ownership.viseme, true);
assert.equal(reports[2].ownership.emotion, false);
// Replay identical combinations across every asset; verify finite, bounded output and no drift.
for (const report of reports) {
  const scene = readGeometryScene(report.file);
  const c = create(scene, report.file);
  for (let frame = 0; frame < 720; frame++) {
    const speech = frame >= 180 && frame < 540;
    const phase = frame % 180;
    const weights = composeFacialWeights({ browDownLeft: 0.45, browDownRight: 0.45, mouthFrownLeft: 0.2 },
      speech ? { jawOpen: phase < 90 ? 0.5 : 0, mouthFunnel: phase < 90 ? 0.4 : 0 } : {},
      { eyeBlinkLeft: phase > 160 ? 0.8 : 0, eyeBlinkRight: phase > 160 ? 0.8 : 0 }, speech);
    c.apply(weights, 1 / 60, speech);
    scene.traverse((object) => { if (object.morphTargetInfluences) assert.ok(object.morphTargetInfluences.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)); });
  }
  for (let i = 0; i < 240; i++) c.apply({}, 1 / 60, false);
  scene.traverse((object) => { if (object.morphTargetInfluences) assert.ok(object.morphTargetInfluences.every((v) => v < 0.001)); });
}
assert.equal(new Set(ARKIT_NAMES).size, 52);
console.log(JSON.stringify({ passed: true, scenarios: ['alias ownership', 'zero/invalid/localized/absolute deltas',
  'multi-mesh isolation', 'speech/blink priority', 'cancel/reset', 'frame-rate stability', 'three-model 720-frame replay'],
  models: reports.map(({ file, capabilities }) => ({ file, named: capabilities.namedTargets, effective: capabilities.effectiveTargets, groups: capabilities.independentGroups })) }, null, 2));
