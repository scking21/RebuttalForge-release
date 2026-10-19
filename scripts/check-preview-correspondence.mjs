// Exact payload comparison to the separately verified recorded preview; no network calls.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(resolve(root, 'verification/recorded-preview-contract.json'), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assetsDir = resolve(root, 'web/dist/assets');
const actual = readdirSync(assetsDir).sort().map((name) => {
  const bytes = readFileSync(resolve(assetsDir, name));
  return { name, bytes: bytes.length, sha256: hash(bytes) };
});
const failures = [];
if (actual.length !== contract.assets.length) failures.push('Unexpected built asset count');
for (const expected of contract.assets) {
  const matched = actual.filter((entry) => entry.bytes === expected.bytes && entry.sha256 === expected.sha256);
  if (matched.length !== 1) failures.push(`Payload differs or is missing: ${expected.original_asset}`);
}
const html = readFileSync(resolve(root, 'web/dist/index.html'), 'utf8');
const scripts = [...html.matchAll(/src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/g)];
if (scripts.length !== 1 || !actual.some((entry) => entry.name === scripts[0][1])) failures.push('HTML does not point to the one built JavaScript asset');
const normalized = html.replace(/index-[A-Za-z0-9_-]+\.js/g, 'index-BUNDLE.js');
if (hash(normalized) !== contract.normalized_html_sha256) failures.push('HTML differs beyond the generated JS filename');
console.log(JSON.stringify({
  status: failures.length ? 'FAIL' : 'PASS', asset_payloads_checked: actual.length,
  html_filename_only_difference: failures.length === 0,
  reference_manifest_sha256: contract.reference_manifest_sha256,
  reference_video_sha256: contract.reference_video_sha256,
  actual, failures, scope: contract.scope,
}, null, 2));
process.exitCode = failures.length ? 1 : 0;
