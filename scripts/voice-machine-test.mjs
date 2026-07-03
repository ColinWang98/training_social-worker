import { createActor } from 'xstate';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const sourcePath = path.resolve('src/lib/voiceSessionMachine.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2020,
    target: ts.ScriptTarget.ES2020,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  },
}).outputText;
const tempPath = path.resolve(`.voiceSessionMachine.${Date.now()}.mjs`);
fs.writeFileSync(tempPath, transpiled, 'utf8');

const { voiceSessionMachine } = await import(pathToFileURL(tempPath).href);

const scenarios = [
  {
    label: 'continuous speech turn',
    events: ['START', 'WS_OPEN', 'LISTENING_READY', 'SPEECH_START', 'PARTIAL', 'COMMIT_REQUEST', 'UTTERANCE_COMMITTED', 'TURN_STARTED', 'CLIENT_RESPONSE', 'TTS_PLAY', 'TTS_END'],
    expected: 'listening',
  },
  {
    label: 'barge-in while avatar speaks',
    events: ['START', 'WS_OPEN', 'LISTENING_READY', 'TTS_PLAY', 'SPEECH_START', 'BARGE_IN', 'BARGE_ACK', 'COMMIT_REQUEST', 'UTTERANCE_COMMITTED', 'TURN_STARTED', 'CLIENT_RESPONSE', 'TTS_PLAY', 'TTS_END'],
    expected: 'listening',
  },
  {
    label: 'error recovery',
    events: ['START', 'ERROR', 'START', 'WS_OPEN', 'LISTENING_READY'],
    expected: 'listening',
  },
  {
    label: 'stop from any active state',
    events: ['START', 'WS_OPEN', 'LISTENING_READY', 'SPEECH_START', 'STOP'],
    expected: 'idle',
  },
];

for (const scenario of scenarios) {
  const actor = createActor(voiceSessionMachine);
  actor.start();
  for (const event of scenario.events) {
    actor.send({ type: event });
  }
  const actual = actor.getSnapshot().value;
  actor.stop();
  if (actual !== scenario.expected) {
    throw new Error(`${scenario.label}: expected ${scenario.expected}, got ${String(actual)}`);
  }
}

fs.unlinkSync(tempPath);
console.log(`Validated ${scenarios.length} voice state machine scenarios.`);
