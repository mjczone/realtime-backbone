// Copies config/centrifugo.json into the Helm chart's values.yaml. With --check, fails if they differ.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const valuesPath = resolve(root, 'deploy/helm/realtime-backbone/values.yaml');
const config = JSON.stringify(JSON.parse(readFileSync(resolve(root, 'config/centrifugo.json'), 'utf8')));
const values = readFileSync(valuesPath, 'utf8');
const next = values.replace(/^(  # BEGIN generated config.*\n)  config: .*\n/m, `$1  config: ${config}\n`);

if (process.argv.includes('--check')) {
  if (next !== values) {
    console.error('deploy/helm/realtime-backbone/values.yaml is out of date: run node scripts/sync-helm-config.mjs');
    process.exit(1);
  }
  console.log('helm config is in sync');
} else {
  writeFileSync(valuesPath, next);
  console.log('helm config synced');
}
