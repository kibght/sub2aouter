#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/retry.sh"
source "$SCRIPT_DIR/image-digest.sh"

IMAGE="${1:?image repository is required}"
RELEASE_VERSION="${2:?release version is required}"
EXPECTED_DIGEST="${3:-}"
if [[ ! "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid version image alias." >&2
  exit 1
fi
if [[ -z "$EXPECTED_DIGEST" ]]; then
  # Older generated releases did not record a digest. Preserve their existing
  # version image, but never infer a replacement from a mutable source tag.
  retry_with_backoff 4 10 image_digest "${IMAGE}:${RELEASE_VERSION}" > /dev/null
  exit 0
fi
if [[ ! "$EXPECTED_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "Invalid recorded release image digest." >&2
  exit 1
fi

CURRENT_DIGEST="$(retry_with_backoff 4 10 image_digest "${IMAGE}:${RELEASE_VERSION}" allow-missing)"
if [[ "$CURRENT_DIGEST" == "$EXPECTED_DIGEST" ]]; then
  echo "Version image already matches its recorded release candidate."
  exit 0
fi

# Pull by digest so an interrupted run can recover even if the source tag has
# since moved. No version alias changes until this image is available locally.
retry_with_backoff 4 10 docker pull "${IMAGE}@${EXPECTED_DIGEST}"
docker tag "${IMAGE}@${EXPECTED_DIGEST}" "${IMAGE}:${RELEASE_VERSION}"
retry_with_backoff 4 10 docker push "${IMAGE}:${RELEASE_VERSION}"
test "$(retry_with_backoff 4 10 image_digest "${IMAGE}:${RELEASE_VERSION}")" = "$EXPECTED_DIGEST"
