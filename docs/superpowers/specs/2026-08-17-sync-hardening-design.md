# Upstream Synchronization Hardening Design

## Objective

Make the repository's upstream synchronization, themed release publication, binary release repair, and health monitoring resilient to the failures already observed in production while preserving the currently verified release semantics on `origin/main`.

## Scope

This design covers:

- the hourly Infinite Canvas coordinator;
- Sub2API release discovery and themed release generation;
- immutable image and binary publication;
- exact-SHA CI and merge gates;
- transient network retry behavior;
- failure notification and stale-run recovery;
- workflow supply-chain pinning;
- release contract tests and an operator runbook.

It does not replace GitHub Actions with a separately hosted service. An external scheduler may call the watchdog later, but the repository must be self-monitoring without requiring one.

## Preserved Invariants

The following behavior already exists on `origin/main` and must not regress:

1. Scheduled synchronization consumes the latest published upstream release rather than arbitrary upstream `main` commits.
2. External release tags are fetched into private `refs/apophis/*` refs.
3. Upstream source movement must be monotonic, except for the narrow recovery from a descendant unreleased snapshot to a published release.
4. Repository-only and Infinite Canvas drift produce repository releases without refetching upstream source.
5. Infinite Canvas updates are merged only when reusable full CI succeeds for the exact tested head SHA.
6. The generated release branch preserves non-owned workflow files and verifies owned workflow snapshots before publication.
7. Docker builds derive the Go builder version from the generated upstream `go.mod`.
8. Missing or incomplete binary releases repair the existing version instead of minting a new version.
9. `latest` is promoted only after binary publication and post-publication verification succeed.

## Architecture

### 1. Release discovery library

Create a dependency-free Node.js library and CLI for GitHub latest-release discovery. It will:

- authenticate with `GH_TOKEN` or `GITHUB_TOKEN`;
- retry transport errors, HTTP 429, and HTTP 5xx responses with bounded exponential backoff and jitter;
- treat HTTP 404 as an explicit no-release result;
- fail closed for malformed JSON, missing tag names, HTTP 401/403 without a retry indication, and invalid repository input;
- emit stable JSON and GitHub Actions outputs.

The workflows will continue to validate tags with `git check-ref-format` before fetching them.

### 2. Git transport retry helper

Create a small Bash helper used by workflow fetch and dispatch steps. It will retry transient command failures with exponential backoff, preserve the final exit code, and print each attempt. It will not be used around deterministic tests, builds, monotonicity checks, or SHA validation.

### 3. Atomic publication

Keep the current reusable binary workflow architecture. The themed sync job publishes only immutable version tags before calling the binary workflow. The `promote-latest` job remains dependent on successful binary publication. Contract tests will explicitly reject asynchronous binary dispatch and early `latest` publication.

### 4. Failure notification

Create a reusable `automation-alert.yml` workflow. Callers pass a stable issue title, severity, workflow name, run URL, and diagnostic summary. It will:

- create or update one open GitHub issue instead of creating duplicates;
- add a timestamped comment for repeated failures;
- send Telegram when credentials are configured;
- remain useful when Telegram is unavailable.

Primary synchronization workflows will call it whenever a required job fails.

### 5. Watchdog

Create `sync-watchdog.yml`, scheduled away from the top of the hour and manually dispatchable. A tested Node.js health evaluator will inspect both synchronization workflows and classify them as:

- `healthy`: latest success is within the configured age and there is no failed latest run;
- `running`: a coordinator run is active and has not exceeded the stuck threshold;
- `recoverable`: no active run exists and a latest failure or stale success requires a coordinator dispatch;
- `critical`: API inspection failed or an active run exceeded the stuck threshold.

For `recoverable`, the watchdog dispatches only `infinite-canvas-upstream-sync.yml`, never the publication workflow directly. It then records the incident and fails visibly. On a later healthy run it closes the persistent incident issue.

Default thresholds:

- stale success: 120 minutes;
- stuck active run: 90 minutes;
- watchdog schedule: minute 41 of every hour;
- coordinator schedule: minute 17 of every hour.

### 6. Observability

Both synchronization workflows and the watchdog will write GitHub step summaries containing the event, source identifiers, decisions, result states, and recovery action. A machine-readable watchdog JSON artifact will be retained for 30 days.

### 7. Action pinning and permissions

Remote actions used by the release gate will be pinned to immutable commit SHAs with version comments. Local reusable workflows remain referenced by path. Permissions will be granted only where required; no unsupported workflow-file write permission will be introduced.

### 8. Testing

Tests will cover:

- release API success, 404, 401/403, 429, 5xx, malformed JSON, transport failure, and retry exhaustion;
- healthy, running, recoverable, stale, failed, and stuck watchdog states;
- one-coordinator dispatch semantics;
- reusable alert invocation on primary workflow failures;
- retry helper inclusion for network fetches;
- immutable action pins;
- no asynchronous binary dispatch;
- no `latest` promotion before successful binary publication;
- owned workflow snapshot preservation including the new alert and watchdog workflows.

## Files

Create:

- `scripts/lib/github-release.mjs`
- `scripts/resolve-github-release.mjs`
- `scripts/lib/sync-health.mjs`
- `scripts/check-sync-health.mjs`
- `scripts/ci/retry.sh`
- `scripts/__tests__/github-release.test.mjs`
- `scripts/__tests__/sync-health.test.mjs`
- `.github/workflows/automation-alert.yml`
- `.github/workflows/sync-watchdog.yml`
- `docs/UPSTREAM_SYNC_RUNBOOK.md`

Modify:

- `.github/workflows/backend-ci.yml`
- `.github/workflows/infinite-canvas-upstream-sync.yml`
- `.github/workflows/upstream-theme-sync.yml`
- `.github/workflows/theme-binary-release.yml`
- `scripts/lib/release-pipeline-contract.mjs`
- `scripts/__tests__/release-pipeline-contract.test.mjs`
- `scripts/__tests__/infinite-canvas-workflows.test.mjs`
- `scripts/__tests__/workflow-trigger.test.mjs`

## Rollout

1. Implement on a branch created from current `origin/main` in an isolated worktree.
2. Run all workflow contract tests and script tests locally.
3. Push the branch and open a pull request.
4. Wait for repository CI and security checks.
5. Merge only after all required checks pass.
6. Manually dispatch the watchdog and the coordinator on `main`.
7. Verify the watchdog reports healthy and the coordinator produces a successful no-op or a complete atomic release.

## Acceptance Criteria

The work is complete only when:

- all new tests were observed failing before implementation and pass afterward;
- all existing release contract tests pass;
- workflow YAML is accepted by GitHub and remote CI succeeds;
- the watchdog is active on `main` and a manual run completes successfully;
- the coordinator is active on `main` and a manual run completes successfully;
- no old workspace files are modified or deleted;
- the incident issue mechanism and optional Telegram path are present;
- the runbook documents manual repair, rollback, alert interpretation, and release-only synchronization semantics.