#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true
targets=("node_modules" "dist" "coverage" ".vite" ".cache" "node_modules/.cache")
echo "Project: $ROOT"; echo "Mode: $([[ "$APPLY" == true ]] && echo DELETE || echo PREVIEW)"; echo
for rel in "${targets[@]}"; do
  path="$ROOT/$rel"; [[ -e "$path" ]] || continue
  size="$(du -sh "$path" 2>/dev/null | awk '{print $1}')"; printf '%8s  %s\n' "${size:-?}" "$rel"
  [[ "$APPLY" == true ]] && rm -rf -- "$path"
done
echo
[[ "$APPLY" == true ]] && echo "Cleanup complete." || echo "Nothing deleted. Run: bash scripts/clean-local.sh --apply"
echo "Environment files, source files, lockfiles, local state, and databases are not touched."
