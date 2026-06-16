import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const sourcePath = path.resolve('src/lib/seatedMotionLanguage.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
    strict: true,
  },
}).outputText;

const tempPath = path.join(os.tmpdir(), `seatedMotionLanguage.${Date.now()}.mjs`);
fs.writeFileSync(tempPath, transpiled, 'utf8');

const {
  compileSeatedMotionScript,
  sampleSeatedMotionProgram,
  seatedMotionScriptTemplate,
} = await import(pathToFileURL(tempPath).href);

const families = [
  'defensive',
  'withdrawn',
  'anxious',
  'ashamed',
  'reflective',
  'risk',
  'soft_engagement',
];

for (const family of families) {
  const template = seatedMotionScriptTemplate(family, { seed: `test-${family}`, intensity: 0.8 });
  const result = compileSeatedMotionScript(template.script, { id: template.id });
  assert(result.ok, `${family} template should compile: ${issueSummary(result.issues)}`);
  assert(result.program.keyframes.length >= 2, `${family} template should produce keyframes.`);
  const sample = sampleSeatedMotionProgram(result.program, result.program.durationMs / 2000, 0.8);
  assert(sample && typeof sample === 'object', `${family} template should be sampleable.`);
}

const invalidCases = [
  {
    label: 'lower body target',
    script: `
@pose bad {
  hips bend forward 0.4;
}
@animation bad_anim {
  0: baseline;
  1: bad;
}
main bad_anim;
`,
  },
  {
    label: 'unknown target',
    script: `
@pose bad {
  elbow spin left 0.4;
}
@animation bad_anim {
  0: baseline;
  1: bad;
}
main bad_anim;
`,
  },
  {
    label: 'out of range value',
    script: `
@pose bad {
  head turn left 1.6;
}
@animation bad_anim {
  0: baseline;
  1: bad;
}
main bad_anim;
`,
  },
  {
    label: 'missing main',
    script: `
@pose good {
  head turn left 0.2;
}
@animation good_anim {
  0: baseline;
  1: good;
}
`,
  },
];

for (const invalidCase of invalidCases) {
  const result = compileSeatedMotionScript(invalidCase.script, { id: invalidCase.label });
  assert(!result.ok, `${invalidCase.label} should fail validation.`);
}

fs.unlinkSync(tempPath);
console.log(`Validated ${families.length} seated motion templates and ${invalidCases.length} invalid cases.`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function issueSummary(issues) {
  return issues.map((issue) => issue.message).join('; ') || 'no issues';
}
