import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const adkPython = '.venv-adk/bin/python';
const children = [];

if (!existsSync(adkPython)) {
  console.error('Missing .venv-adk. Run: npm run adk:install');
  process.exit(1);
}

const commands = [
  {
    name: 'adk',
    command: adkPython,
    args: ['-m', 'uvicorn', 'adk_service.main:app', '--host', '127.0.0.1', '--port', '8765'],
  },
  {
    name: 'app',
    command: 'node',
    args: ['server.mjs'],
  },
];

for (const item of commands) {
  const child = spawn(item.command, item.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  children.push(child);

  child.stdout.on('data', (chunk) => {
    process.stdout.write(prefixLines(item.name, chunk));
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(prefixLines(item.name, chunk));
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${item.name}] exited with ${signal ?? code}`);
    shutdown(code ?? 1);
  });
}

let shuttingDown = false;

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function shutdown(code) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}

function prefixLines(name, chunk) {
  return String(chunk)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => `[${name}] ${line}\n`)
    .join('');
}
