import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const requested = process.argv[2] ?? 'all';
if (!['all', 'backend', 'ui'].includes(requested)) {
  console.error('Usage: node scripts/verify-offline.mjs [all|backend|ui]');
  process.exit(2);
}
const loader = process.env.DISPUTE_DESK_TSX_IMPORT || 'tsx';
const groups = [
  { name: 'backend', directory: 'verification', suffix: '.node.ts' },
  { name: 'ui', directory: 'web/test', suffix: '.new.node.ts' },
].filter(group => requested === 'all' || group.name === requested);
let failed = false;
for (const group of groups) {
  const files = readdirSync(new URL(`../${group.directory}/`, import.meta.url))
    .filter(name => name.endsWith(group.suffix)).sort().map(name => `${group.directory}/${name}`);
  if (files.length === 0) throw new Error(`No ${group.name} offline tests found`);
  console.log(`\nOffline ${group.name} checks. Loader: ${loader}. No installation or service calls.`);
  const result = spawnSync(process.execPath, ['--import', loader, '--test', '--test-reporter=tap', ...files], { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
