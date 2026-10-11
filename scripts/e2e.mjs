// Runs the browser tests against the running dev stack and samples (pnpm dev:up, then pnpm samples:up).
// With arguments, runs just those spec files: pnpm e2e tests/demo.spec.ts
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const port = (name, fallback) => process.env[name] || fallback;
const all = [
  ['tests/demo.spec.ts', { RTB_DEMO_URL: `http://localhost:${port('RTB_DEMO_PORT', 8080)}` }],
  ['tests/chat.spec.ts', { RTB_SAMPLE_URL: `http://localhost:${port('RTB_SAMPLE_PORT', 3001)}` }],
  ['tests/chat.spec.ts', { RTB_SAMPLE_URL: `http://localhost:${port('RTB_MAF_SAMPLE_PORT', 3002)}` }],
  ['tests/chat.spec.ts', { RTB_SAMPLE_URL: `http://localhost:${port('RTB_PY_SAMPLE_PORT', 3003)}` }],
  ['tests/chat.spec.ts', { RTB_SAMPLE_URL: `http://localhost:${port('RTB_LANGGRAPH_SAMPLE_PORT', 3004)}` }],
  ['tests/mastra-dotnet.spec.ts', { RTB_MDN_URL: `http://localhost:${port('RTB_MDN_API_PORT', 3010)}` }],
];
const picked = process.argv.length > 2 ? all.filter(([spec]) => process.argv.slice(2).includes(spec)) : all;
const runner = resolve(import.meta.dirname, '..', 'e2e', 'run.mjs');
const failed = [];
for (const [spec, env] of picked) {
  const label = `${spec} ${Object.values(env).join(' ')}`;
  console.log(`\n== ${label}`);
  try {
    execFileSync(process.execPath, [runner, spec], { stdio: 'inherit', env: { ...process.env, ...env } });
  } catch {
    failed.push(label);
  }
}
console.log(failed.length ? `\nFailed:\n  ${failed.join('\n  ')}` : '\nAll passed');
process.exit(failed.length ? 1 : 0);
