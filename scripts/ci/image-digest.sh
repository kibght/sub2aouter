#!/usr/bin/env bash

image_digest() {
  local image_ref="${1:?image reference is required}"
  local missing_policy="${2:-required}"
  local error_file
  local digest
  local status
  error_file="$(mktemp)" || return
  if digest="$(docker buildx imagetools inspect "$image_ref" --format '{{.Manifest.Digest}}' 2> "$error_file")"; then
    rm -f "$error_file"
    if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      echo "Registry returned an invalid digest for $image_ref." >&2
      return 1
    fi
    printf '%s\n' "$digest"
  else
    status=$?
    if [[ "$missing_policy" == 'allow-missing' ]] && grep -Eiq 'manifest unknown|manifest_unknown|not found' "$error_file"; then
      rm -f "$error_file"
      return 0
    fi
    cat "$error_file" >&2
    rm -f "$error_file"
    return "$status"
  fi
}
