#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

WORKFLOW_DIR=.github/workflows
for workflow in "$WORKFLOW_DIR"/*.yml "$WORKFLOW_DIR"/*.yaml; do
  [[ -e "$workflow" ]] || continue
  name="${workflow##*/}"
  case "$name" in
    upstream-theme-sync.yml|infinite-canvas-upstream-sync.yml|backend-ci.yml|theme-binary-release.yml|automation-alert.yml|sync-watchdog.yml)
      ;;
    *)
      if git cat-file -e "origin/themed-release:$workflow" 2>/dev/null; then
        git checkout origin/themed-release -- "$workflow"
      else
        rm -f "$workflow"
      fi
      ;;
  esac
done
