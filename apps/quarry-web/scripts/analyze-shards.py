#!/usr/bin/env python3
"""Merge el-2y9h5w shard reports and group failures for triage."""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

results = Path(__file__).resolve().parents[3] / '.stoneforge/triage-el-2y9h5w'
shards = sorted(results.glob('shard-*.json'), key=lambda p: int(re.search(r'\d+', p.name).group()))

totals = defaultdict(int)
failures = []
flaky = []

for path in shards:
    report = json.loads(path.read_text())
    for key, value in report['stats'].items():
        if isinstance(value, (int, float)):
            totals[key] += value

    def walk(node):
        for suite in node.get('suites', []):
            walk(suite)
        for spec in node.get('specs', []):
            loc = spec.get('location') or {}
            file = loc.get('file', '?')
            line = loc.get('line', '?')
            for t in spec.get('tests', []):
                status = t.get('status')
                if status in ('unexpected', 'flaky'):
                    error = ''
                    for res in t.get('results', []):
                        msg = (res.get('error', {}) or {}).get('message', '')
                        if msg:
                            error = msg
                            break
                    entry = {
                        'shard': path.name,
                        'file': file.split('quarry-web/')[-1],
                        'line': line,
                        'title': spec.get('title', '?'),
                        'error': re.sub(r'\x1b\[[0-9;]*m', '', error).split('\n')[0][:220],
                    }
                    (failures if status == 'unexpected' else flaky).append(entry)

    for suite in report.get('suites', []):
        walk(suite)

print(f'shards parsed: {len(shards)}')
print(f"totals: expected={totals.get('expected')} unexpected={totals.get('unexpected')} "
      f"skipped={totals.get('skipped')} flaky={totals.get('flaky')} "
      f"duration={totals.get('duration', 0) / 1000:.0f}s")
print(f'\n=== FAILURES ({len(failures)}) ===')

by_file = defaultdict(list)
for f in failures:
    by_file[f['file']].append(f)
for file in sorted(by_file):
    print(f'\n-- {file} ({len(by_file[file])})')
    for f in by_file[file]:
        print(f"  [{f['shard']}] :{f['line']} {f['title'][:90]}")
        print(f"      ERR: {f['error']}")

if flaky:
    print(f'\n=== FLAKY ({len(flaky)}) ===')
    for f in flaky:
        print(f"  [{f['shard']}] {f['file']}:{f['line']} {f['title'][:80]}")

out = results / 'failures.json'
out.write_text(json.dumps({'totals': dict(totals), 'failures': failures, 'flaky': flaky}, indent=2))
print(f'\nwrote {out}')
