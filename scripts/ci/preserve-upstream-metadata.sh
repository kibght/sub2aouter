#!/usr/bin/env bash
set -euo pipefail

# Repository/Canvas releases inherit the complete identity of their Sub2API base.
ROOT="${1:?generated directory is required}"
SOURCE_REF="${2:-origin/themed-release}"
for field in tag id name url notes.md; do
  file=".apophis-upstream-release-${field}"
  if git cat-file -e "${SOURCE_REF}:${file}" 2>/dev/null; then
    git show "${SOURCE_REF}:${file}" > "$ROOT/$file"
  fi
done

# A discovered identity is authoritative only for the source selected this round.
if [[ -n "${UPSTREAM_RELEASE_TAG:-}" ]]; then
  printf '%s\n' "$UPSTREAM_RELEASE_TAG" > "$ROOT/.apophis-upstream-release-tag"
fi
if [[ -n "${UPSTREAM_RELEASE_ID:-}" ]]; then
  printf '%s\n' "$UPSTREAM_RELEASE_ID" > "$ROOT/.apophis-upstream-release-id"
fi
test -s "$ROOT/.apophis-upstream-release-tag"
test -s "$ROOT/.apophis-upstream-release-id"
