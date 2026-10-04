#!/usr/bin/env python3
"""Resume el-2y9h5w's sequential baseline shards in the current worktree."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--last-shard', type=int, choices=range(1, 21), default=20)
parser.add_argument('--first-shard', type=int, choices=range(1, 21), default=1)
args = parser.parse_args()

root = Path(__file__).resolve().parents[3]
app = root / 'apps/quarry-web'
results = root / '.stoneforge/triage-el-2y9h5w'
results.mkdir(parents=True, exist_ok=True)
bin_dir = results / 'bin'
bin_dir.mkdir(exist_ok=True)
node = bin_dir / 'node'
if not node.exists():
    node.symlink_to(shutil.which('node'))
env = dict(os.environ, PATH=f'{bin_dir}:{Path.home()}/.local/bin:/usr/bin:/bin')

# `bun run` executes the playwright bin in a way that breaks its ESM config
# preflight (playwright.config.ts.esm.preflight) after the config gained a
# node:crypto import, so drive the Playwright CLI with node directly.
cli = app / 'node_modules/playwright/cli.js'


def run(cmd, cwd=app, **kwargs):
    return subprocess.run(cmd, cwd=cwd, env=env, check=False, **kwargs)


def read_report(path):
    try:
        report = json.loads(path.read_text())
        if 'stats' in report and 'suites' in report and not report.get('errors'):
            return report
    except (OSError, ValueError):
        pass
    return None


if not (root / 'packages/storage/dist').is_dir():
    print('Building @stoneforge/core/storage/quarry (dist missing)...', flush=True)
    run(['bun', 'run', 'build'], cwd=str(root))

run([str(node), str(cli), 'install', 'chromium', '--only-shell'])

for shard in range(args.first_shard, args.last_shard + 1):
    target = results / f'shard-{shard}.json'
    if read_report(target):
        print(f'Skipping complete shard {shard}', flush=True)
        continue
    # Dedicated scratch DB only; never delete the actual workspace data.
    shutil.rmtree(root / '.stoneforge-test', ignore_errors=True)
    raw = results / f'shard-{shard}.stdout'
    print(f'Running shard {shard}/20', flush=True)
    with raw.open('w') as stdout, (results / f'shard-{shard}.stderr').open('w') as stderr:
        run([str(node), str(cli), 'test', f'--shard={shard}/20',
             '--workers=1', '--reporter=json'], stdout=stdout, stderr=stderr)
    # Setup progress can precede the JSON reporter payload.
    output = raw.read_text()
    for index, char in enumerate(output):
        if char != '{':
            continue
        try:
            report = json.loads(output[index:])
        except ValueError:
            continue
        if 'stats' in report and 'suites' in report:
            target.write_text(json.dumps(report, indent=2) + '\n')
            break
    report = read_report(target)
    if not report:
        raise SystemExit(f'Shard {shard} incomplete; inspect {raw} and stderr before resuming')
    print(f'Shard {shard}: {report["stats"]}', flush=True)
