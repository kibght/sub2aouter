#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-all}"
REPORT_DIR="${SECURITY_REPORT_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sub2api-security}"
mkdir -p "$REPORT_DIR"

case "$MODE" in
  backend|frontend|all) ;;
  *) echo "Unknown security scan mode: $MODE" >&2; exit 64 ;;
esac

if [[ "$MODE" == backend || "$MODE" == all ]]; then
  GO_VERSION="$(awk '$1 == "go" { print $2; exit }' backend/go.mod)"
  test -n "$GO_VERSION"
  test "$(go env GOVERSION)" = "go${GO_VERSION}"
  (
    cd backend
    go install golang.org/x/vuln/cmd/govulncheck@v1.9.0
    "$(go env GOPATH)/bin/govulncheck" -show verbose ./...
  ) 2>&1 | tee "$REPORT_DIR/govulncheck.txt"
fi

if [[ "$MODE" == frontend || "$MODE" == all ]]; then
  AUDIT_STATUS=0
  (cd frontend && pnpm audit --prod --audit-level=high --json) > "$REPORT_DIR/pnpm-audit.json" || AUDIT_STATUS=$?
  if [[ "$AUDIT_STATUS" -gt 1 ]]; then
    cat "$REPORT_DIR/pnpm-audit.json" >&2
    echo "pnpm audit failed with exit code $AUDIT_STATUS" >&2
    exit "$AUDIT_STATUS"
  fi
  python3 tools/check_pnpm_audit_exceptions.py \
    --audit "$REPORT_DIR/pnpm-audit.json" \
    --exceptions .github/audit-exceptions.yml
fi
