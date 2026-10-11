#!/usr/bin/env bash

release_identity_matches() {
  local recorded_sha="$1" recorded_tag="$2" recorded_id="$3"
  local desired_sha="$4" desired_tag="$5" desired_id="$6"
  [[ -n "$recorded_sha" && "$recorded_sha" == "$desired_sha" ]] &&
    { [[ -n "$recorded_id" && "$recorded_id" == "$desired_id" ]] ||
      [[ -n "$recorded_tag" && "$recorded_tag" == "$desired_tag" ]]; }
}
