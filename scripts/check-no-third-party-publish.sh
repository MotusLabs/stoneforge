#!/usr/bin/env bash
# Fail if any GitHub workflow matches a third-party publish / deploy pattern.
#
# MotusLab hard rule (spec el-12jf6c, "No uploads to third-party services"):
# nothing may be uploaded to npm, Cloudflare, or any other third-party service.
# The only publish target is GitHub Releases on MotusLabs/stoneforge.
#
# Usage: scripts/check-no-third-party-publish.sh
# Exit 0 when clean, 1 when a forbidden pattern is found.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOWS="${ROOT}/.github/workflows"

# Patterns that indicate a third-party publish or credential use.
PATTERN='npm publish|pnpm publish|changeset publish|wrangler|CLOUDFLARE_|id-token: write'

if [[ ! -d "${WORKFLOWS}" ]]; then
  echo "OK: no .github/workflows directory; nothing to audit."
  exit 0
fi

matches="$(grep -RInE -- "${PATTERN}" "${WORKFLOWS}" || true)"

if [[ -n "${matches}" ]]; then
  echo "FAIL: third-party publish/deploy patterns found in .github/workflows/" >&2
  echo >&2
  echo "${matches}" >&2
  echo >&2
  echo "Remove the workflow steps (or the workflows) that publish to npm, Cloudflare," >&2
  echo "or other third-party services. See the MotusLab Ubuntu Release Spec." >&2
  exit 1
fi

echo "OK: no third-party publish patterns in .github/workflows/"
