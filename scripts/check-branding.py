#!/usr/bin/env python3
"""Reject old public names while allowing exact path/token/count compatibility exceptions."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[1]
policy = json.loads((root / 'verification/branding-inventory.json').read_text())
old = re.compile(r'dispute[\s_-]*desk', re.I)
problems = []
checked = 0
for base, dirs, files in os.walk(root):
    dirs[:] = [name for name in dirs if name not in {'node_modules', '.git'}]
    for name in sorted(files):
        path = Path(base) / name
        rel = path.relative_to(root).as_posix()
        if rel == 'verification/branding-inventory.json':
            continue
        if old.search(rel):
            problems.append({'path': rel, 'error': 'old name in filename'})
        if path.is_symlink():
            problems.append({'path': rel, 'error': 'unreviewed file symlink'})
            continue
        try:
            text = path.read_text()
            if '\0' in text:
                continue
        except UnicodeError:
            continue
        checked += 1
        allowed = []
        for entry in policy['compatibility_exceptions']:
            if entry['path'] == rel:
                spans = [(m.start(), m.end()) for m in re.finditer(re.escape(entry['token']), text)]
                if len(spans) <= entry['max_count']:
                    allowed.extend(spans)
        for match in old.finditer(text):
            if not any(a <= match.start() and match.end() <= b for a, b in allowed):
                problems.append({'path': rel, 'line': text.count('\n', 0, match.start()) + 1, 'match': match.group()})
for rel, name in [('package.json', 'rebuttalforge'), ('package-lock.json', 'rebuttalforge'), ('web/package.json', 'rebuttalforge-web'), ('web/package-lock.json', 'rebuttalforge-web')]:
    data = json.loads((root / rel).read_text())
    if data.get('name') != name or data.get('packages', {}).get('', {}).get('name', name) != name:
        problems.append({'path': rel, 'error': 'incorrect package metadata'})
if '<title>RebuttalForge</title>' not in (root / 'web/index.html').read_text():
    problems.append({'path': 'web/index.html', 'error': 'incorrect title'})
print(json.dumps({'status': 'FAIL' if problems else 'PASS', 'text_files_checked': checked, 'violations': problems,
                  'limits': 'Local source/build text only; binary video/audio/pixels and remote pages need separate review.'}, indent=2))
sys.exit(1 if problems else 0)
