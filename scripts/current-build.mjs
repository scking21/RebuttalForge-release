// Local byte-identity evidence only. Recording is explicit; checks never rewrite expectations.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const mode = process.argv[2];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const format = 'RebuttalForge pinned local build v1';
const manifestPath = join(root, 'verification/current-build-manifest.json');
function filesAt(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Symlink is not a pinned build input: ${relative(root, path)}`);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) throw new Error(`Unsupported file type: ${relative(root, path)}`);
  return readdirSync(path).sort().flatMap(name => filesAt(join(path, name)));
}
function entries(files, base = root) {
  return files.map(path => { const bytes = readFileSync(path); return { path: relative(base, path).split('\\').join('/'), bytes: bytes.length, sha256: hash(bytes) }; }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function inspect() {
  const inputs = ['src', 'web/src', 'web/public', 'package.json', 'package-lock.json', 'tsconfig.json',
    'web/package.json', 'web/package-lock.json', 'web/tsconfig.json', 'web/vite.config.ts', 'web/index.html',
    'scripts/current-build.mjs', 'scripts/check-third-party-notices.mjs', 'verification/third-party-notices.json'];
  const dist = join(root, 'web/dist');
  const build = entries(filesAt(dist), dist);
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  if (!build.some(entry => entry.path === 'THIRD-PARTY-NOTICES.txt')) throw new Error('Built third-party notices are missing');
  for (const [, reference] of html.matchAll(/(?:src|href)=["'](\/[^"']+)["']/g)) {
    if (!build.some(entry => `/${entry.path}` === reference)) throw new Error(`HTML references an absent build file: ${reference}`);
  }
  return { format, inputs: entries(inputs.flatMap(path => filesAt(join(root, path)))), build };
}
try {
  if (!['record', 'check'].includes(mode)) throw new Error('Usage: node scripts/current-build.mjs record|check [root]');
  const current = inspect();
  if (mode === 'record') {
    writeFileSync(manifestPath, JSON.stringify(current, null, 2) + '\n');
    console.log(JSON.stringify({ status: 'RECORDED', manifestSha256: hash(readFileSync(manifestPath)), scope: 'Author-recorded local byte identity; not independent review, video correspondence or provider proof.' }, null, 2));
  } else {
    const pinned = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (JSON.stringify(pinned) !== JSON.stringify(current)) throw new Error('Pinned source inputs or build files differ; do not silently regenerate evidence. Review the change.');
    console.log(JSON.stringify({ status: 'PASS', inputsChecked: current.inputs.length, buildFilesChecked: current.build.length,
      manifestSha256: hash(readFileSync(manifestPath)), historicalVideoCorrespondence: 'UNVERIFIED', liveProviderVerification: 'UNVERIFIED',
      scope: 'Current local source/build byte identity only. Release video and genuine-AI judge access remain separate gates.' }, null, 2));
  }
} catch (error) {
  console.log(JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
