#!/usr/bin/env bash
# Focused runner for the T17 bootstrap/trust extension demo.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/packages/coding-agent"

vitest_bin="$repo_root/node_modules/.bin/vitest"
if [[ ! -x "$vitest_bin" ]]; then
	echo "vitest is not installed (workspace node_modules missing); cannot execute the demo." >&2
	echo "Run: npm ci   (or: npm install)  at the workspace root, then re-run this script." >&2
	exit 127
fi

exec "$vitest_bin" run test/project-trust-extension-bootstrap.demo.test.ts
