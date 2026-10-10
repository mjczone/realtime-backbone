import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const data = resolve(import.meta.dirname, '..', '.data');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

run('docker', ['compose', 'down', '--remove-orphans', '--volumes']);
if (existsSync(data)) {
  // Valkey writes as its own user, so delete from inside a container to avoid permission errors.
  run('docker', ['run', '--rm', '--entrypoint', 'sh', '-v', `${data}:/data`, 'valkey/valkey:8.1.10-alpine', '-c', 'rm -rf /data/* /data/.[!.]*']);
  rmSync(data, { recursive: true, force: true });
}
console.log('dev stack purged');
