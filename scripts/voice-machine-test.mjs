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
    events: [
      { type: 'START' },
      { type: 'WS_OPEN' },
      { type: 'LISTENING_READY', streamId: 'stream-1' },
      { type: 'SPEECH_START', utteranceId: 'utt-1' },
      { type: 'PARTIAL', transcript: '你好', utteranceId: 'utt-1' },
      { type: 'COMMIT_REQUEST', reason: 'final' },
      { type: 'UTTERANCE_COMMITTED', transcript: '你好', utteranceId: 'utt-1', reason: 'final' },
      { type: 'TURN_STARTED', responseId: 'resp-1', utteranceId: 'utt-1' },
      { type: 'CLIENT_RESPONSE' },
      { type: 'TTS_PLAY', responseId: 'resp-1' },
      { type: 'TTS_END' },
    ],
    expected: 'listening',
    expectedContext: { streamId: 'stream-1', utteranceId: 'utt-1', responseId: 'resp-1', finalTranscript: '你好' },
  },
  {
    label: 'barge-in while avatar speaks',
    events: [
      { type: 'START' }, { type: 'WS_OPEN' }, { type: 'LISTENING_READY', streamId: 'stream-2' },
      { type: 'TTS_PLAY', responseId: 'resp-old' }, { type: 'SPEECH_START', utteranceId: 'utt-2' },
      { type: 'BARGE_IN', responseId: 'resp-old' }, { type: 'BARGE_ACK' },
      { type: 'COMMIT_REQUEST', reason: 'barge_in' },
      { type: 'UTTERANCE_COMMITTED', transcript: '等陣', utteranceId: 'utt-2', reason: 'barge_in' },
      { type: 'TURN_STARTED', responseId: 'resp-2', utteranceId: 'utt-2' },
      { type: 'CLIENT_RESPONSE' }, { type: 'TTS_PLAY', responseId: 'resp-2' }, { type: 'TTS_END' },
    ],
    expected: 'listening',
    expectedContext: { responseId: 'resp-2', cancelledResponseIds: ['resp-old'] },
  },
  {
    label: 'error recovery',
    events: [{ type: 'START' }, { type: 'ERROR' }, { type: 'START' }, { type: 'WS_OPEN' }, { type: 'LISTENING_READY' }],
    expected: 'listening',
  },
  {
    label: 'stop from any active state',
    events: [{ type: 'START' }, { type: 'WS_OPEN' }, { type: 'LISTENING_READY' }, { type: 'SPEECH_START' }, { type: 'STOP' }],
    expected: 'idle',
  },
];

for (const scenario of scenarios) {
  const actor = createActor(voiceSessionMachine);
  actor.start();
  for (const event of scenario.events) actor.send(event);
  const snapshot = actor.getSnapshot();
  const actual = snapshot.value;
  actor.stop();
  if (actual !== scenario.expected) {
    throw new Error(`${scenario.label}: expected ${scenario.expected}, got ${String(actual)}`);
  }
  for (const [key, expected] of Object.entries(scenario.expectedContext ?? {})) {
    const actualValue = snapshot.context[key];
    if (JSON.stringify(actualValue) !== JSON.stringify(expected)) {
      throw new Error(`${scenario.label}: expected context.${key}=${JSON.stringify(expected)}, got ${JSON.stringify(actualValue)}`);
    }
  }
}

fs.unlinkSync(tempPath);
console.log(`Validated ${scenarios.length} voice state machine scenarios.`);
