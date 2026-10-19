// Compare distributed text to actual locked installed packages, not a guessed license template.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const manifest = JSON.parse(readFileSync(join(root, 'verification/third-party-notices.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'web/package-lock.json'), 'utf8'));
  const declared = JSON.parse(readFileSync(join(root, 'web/package.json'), 'utf8'));
  const expected = new Set();
  const pending = Object.keys(declared.dependencies);
  while (pending.length) {
    const name = pending.shift();
    if (expected.has(name)) continue;
    expected.add(name);
    const pkg = JSON.parse(readFileSync(join(root, 'web/node_modules', name, 'package.json'), 'utf8'));
    pending.push(...Object.keys(pkg.dependencies ?? {}));
  }
  const names = manifest.packages.map(entry => entry.name);
  if (new Set(names).size !== names.length || JSON.stringify([...expected].sort()) !== JSON.stringify([...names].sort())) throw new Error('UI runtime dependency notice coverage differs');
  const index = readFileSync(join(root, 'web/public/THIRD-PARTY-NOTICES.txt'));
  if (!readFileSync(join(root, 'web/dist/THIRD-PARTY-NOTICES.txt')).equals(index)) throw new Error('Built notices index differs');
  for (const entry of manifest.packages) {
    const pkg = JSON.parse(readFileSync(join(root, 'web/node_modules', entry.name, 'package.json'), 'utf8'));
    const upstream = readFileSync(join(root, 'web/node_modules', entry.name, entry.upstreamFile));
    if (pkg.version !== entry.version || lock.packages[`node_modules/${entry.name}`]?.version !== entry.version || hash(upstream) !== entry.sha256) throw new Error(`Installed/locked notice identity differs: ${entry.name}`);
    for (const directory of ['web/public', 'web/dist']) {
      if (!readFileSync(join(root, directory, entry.distributedFile)).equals(upstream)) throw new Error(`Distributed notice differs: ${entry.name}`);
    }
    if (!index.toString('utf8').includes(upstream.toString('utf8'))) throw new Error(`Readable upstream text is absent: ${entry.name}`);
    if (!index.toString('utf8').includes(entry.distributedFile)) throw new Error(`Unreadable notice link: ${entry.name}`);
  }
  console.log(JSON.stringify({ status: 'PASS', upstreamNoticesChecked: manifest.packages.length, scope: 'Exact upstream notices retained for the declared UI runtime dependency closure, including conservatively retained type-only/tree-shaken packages. Not a video-rights or comprehensive legal determination.' }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) }, null, 2)); process.exitCode = 1;
}
