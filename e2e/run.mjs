// Runs the Playwright tests in the official Playwright image, on the host network, against the running dev stack.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const pass = ['RTB_DEMO_URL', 'RTB_SAMPLE_URL', 'RTB_MDN_URL'].flatMap((k) => (process.env[k] ? ['-e', `${k}=${process.env[k]}`] : []));
execFileSync(
  'docker',
  ['run', '--rm', '--network', 'host', '--ipc', 'host', '-v', `${repo}:/repo`, '-w', '/repo/e2e', ...pass,
    'mcr.microsoft.com/playwright:v1.64.0-noble', 'npx', 'playwright', 'test', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
