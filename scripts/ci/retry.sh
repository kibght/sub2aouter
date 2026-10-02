#!/usr/bin/env bash

retry_with_backoff() {
  local MAX_ATTEMPTS="${1:?maximum attempts are required}"
  local BASE_DELAY_SECONDS="${2:?base delay is required}"
  shift 2

  if [[ "$MAX_ATTEMPTS" -lt 1 || "$BASE_DELAY_SECONDS" -lt 0 || "$#" -eq 0 ]]; then
    echo "Invalid retry_with_backoff arguments." >&2
    return 64
  fi

  local attempt=1
  local status=0
  local delay=0
  local jitter=0
  while true; do
    echo "Running network command (attempt ${attempt}/${MAX_ATTEMPTS}): $*" >&2
    if "$@"; then
      return 0
    else
      status=$?
    fi

    if [[ "$attempt" -ge "$MAX_ATTEMPTS" ]]; then
      echo "Network command failed after ${MAX_ATTEMPTS} attempts with exit code ${status}: $*" >&2
      return "$status"
    fi

    delay=$((BASE_DELAY_SECONDS * (1 << (attempt - 1))))
    jitter=$((RANDOM % 4))
    delay=$((delay + jitter))
    if [[ "$delay" -gt 120 ]]; then
      delay=120
    fi
    echo "Network command failed with exit code ${status}; retrying in ${delay}s." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}