# Theme, Infinite Canvas, and Release Pipeline Hardening Design

## Goal

Implement the approved first and second repair batches: make theme and Canvas integration checks detect partial drift, restore self-hosted Canvas behavior, and serialize upstream source generation, binary publication, and the final `latest` promotion around an immutable generated commit.

## Scope

This change includes:

1. Exact replacement validation for the theme overlay and Sub2/Canvas integration.
2. Self-hosted Canvas entry URL, configured `api_base_url`, and locale bridge behavior.
3. Fail-closed GitHub Release discovery, one-time tag/id capture, private upstream refs, and downgrade rejection.
4. Canvas pull-request merge binding to the exact head SHA that passed full CI.
5. Reusable `theme-binary-release.yml` via `workflow_call`, with the duplicate `workflow_run` trigger removed.
6. Awaited binary publication before GHCR `latest` promotion.
7. Preservation of the workflows verified in the current generation run instead of restoring an older generated snapshot.
8. Consistent push checkout and repository release source SHA.
9. Contract tests and operations documentation for all changed behavior.

This change does not implement the separately approved third-batch supply-chain isolation work. Read-only external build jobs, `persist-credentials: false`, and full action SHA pinning remain a follow-up.

## Design

### Exact patch validation

`theme-overlay.mjs` and `apply-sub2-infinite-canvas-integration.mjs` follow the same contract:

1. Normalize the complete replacement to the target file line endings.
2. Return idempotently only when the complete replacement already exists.
3. If the sentinel exists without the complete replacement, report partial drift and fail.
4. Apply the patch by marker only when neither the exact replacement nor the sentinel exists.
5. Check and apply modes must never allow a sentinel to hide damaged replacement content.

### Self-hosted Canvas configuration

- Build the standalone URL from `window.location.origin` and `/canvas-app/canvas?mode=new`.
- Prefer `appStore.cachedPublicSettings.api_base_url` for the model gateway, with current origin as the fallback.
- Do not append a second `/v1` when the configured gateway already contains it.
- Validate `zh-CN` and `en-US` in the child bridge and call `changeAppLocale`.

### Release metadata and tag refs

- Call `releases/latest` once per round and capture `tag_name` plus `id` from the same response.
- Treat only HTTP 404 as no published release; all other API failures stop the round.
- Fetch Sub2 release tags into `refs/apophis/upstream-release` instead of public `refs/tags`.
- Reject scheduled targets that are not descendants of the currently published revision.
- Deduplicate only when release identity and source SHA both match.
- Pass external release tags through step outputs and `env:` rather than interpolating them directly into `run:` scripts.

### Canvas merge gate

Full CI continues to validate `update_sha`. The merge job reads the current PR `headRefOid`, requires an exact match with `update_sha`, and merges with `gh pr merge --match-head-commit`.

### Atomic release orchestration

`upstream-theme-sync.yml` becomes a three-stage workflow:

1. `sync-build-publish` generates and tests source, pushes immutable/version images, updates `themed-release`, and outputs the exact release commit/version plus binary requirements.
2. `binary-release` invokes the local reusable `theme-binary-release.yml`, checks out the exact generated commit, and creates or repairs the GitHub Release.
3. `promote-latest` runs only for a new source publication after binary success, pulls the version image, retags it, and pushes `latest`.

`theme-binary-release.yml` keeps `workflow_call` and manual `workflow_dispatch` only. Removing `workflow_run` eliminates duplicate push/dispatch triggers.

The caller workflow remains active while the reusable binary workflow runs, so the existing `upstream-theme-sync` concurrency lock prevents a later round from rewriting `themed-release` before binary publication completes.

### Generated snapshot

Remove the pre-publication restoration of `origin/themed-release:.github/workflows`. The workflows copied and verified during the current generation run are the workflows committed to the generated root snapshot. Run the release contract and compare critical workflow files immediately before `git write-tree`.

### Push consistency

Push events check out `github.sha`; manual and coordinated dispatches check out `main`. Repository release source identity always comes from the actual checked-out `git rev-parse HEAD`.

## Verification criteria

- Damaging a non-sentinel line in a theme replacement makes `--check` fail.
- Damaging a Canvas route or Docker replacement while preserving its sentinel makes `--check` fail.
- Current-origin entry URLs, configured gateway URLs, existing `/v1`, and locale propagation have tests.
- Workflow contracts reject API `|| true`, public upstream tag destinations, unlocked PR merges, `workflow_run` duplicate triggers, `latest` promotion before binary success, and old workflow restoration.
- Node contracts, frontend lint/typecheck/Vitest/build, Canvas typecheck/build, Go unit tests, UTF-8 checks, and `git diff --check` pass.
