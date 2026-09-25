# Upstream Synchronization Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden upstream synchronization and release monitoring against all previously observed release, network, workflow-permission, scheduling, and partial-publication failures.

**Architecture:** Preserve the verified single-coordinator and reusable-binary architecture on `origin/main`. Add tested release-discovery and health-evaluation libraries, a reusable alert workflow, and a scheduled watchdog that dispatches only the coordinator. Strengthen existing workflows with retry helpers, immutable action pins, summaries, timeouts, and contract enforcement.

**Tech Stack:** GitHub Actions YAML, Node.js 24 ESM, Bash, GitHub CLI, Node test runner.

## Global Constraints

- Work only in `E:\sub2模板\.worktrees\sync-hardening` on `codex/sync-hardening`.
- Do not modify or delete untracked files in `E:\sub2模板`.
- Scheduled source synchronization must consume published releases, not arbitrary upstream `main` commits.
- `latest` must not move before binary release verification succeeds.
- Network retries must be bounded; deterministic validation failures must fail immediately.
- New JavaScript modules must be dependency-free and testable with injected fetch, sleep, clock, and randomness.
- Preserve all existing Chinese source text exactly.

---

### Task 1: Tested GitHub Release Discovery

**Files:**
- Create: `scripts/lib/github-release.mjs`
- Create: `scripts/resolve-github-release.mjs`
- Test: `scripts/__tests__/github-release.test.mjs`

**Interfaces:**
- Produces: `fetchLatestRelease(options): Promise<{ found: boolean, tag: string, id: string, publishedAt: string }>`.
- Produces: CLI outputs `found`, `tag`, `id`, and `published_at` through `--github-output`.

- [ ] **Step 1: Write failing unit tests**

Cover success, 404, 401, 403, 429 retry, 500 retry, malformed JSON, transport retry, and exhaustion using injected `fetchImpl`, `sleep`, and `random`.

```js
const result = await fetchLatestRelease({
  repository: 'owner/repo',
  token: 'token',
  fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'v1.2.3', id: 42, published_at: '2026-08-17T00:00:00Z' }), { status: 200 }),
  sleep: async () => {},
  random: () => 0,
})
assert.deepEqual(result, { found: true, tag: 'v1.2.3', id: '42', publishedAt: '2026-08-17T00:00:00Z' })
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```powershell
node --test scripts/__tests__/github-release.test.mjs
```

Expected: FAIL because `scripts/lib/github-release.mjs` does not exist.

- [ ] **Step 3: Implement the library and CLI**

Implement bounded exponential backoff for transport errors, 429, and 5xx; explicit 404 no-release; fail-closed behavior for all other invalid responses.

- [ ] **Step 4: Run tests and confirm GREEN**

Run the same test command. Expected: all release discovery tests pass.

- [ ] **Step 5: Commit**

```powershell
git add scripts/lib/github-release.mjs scripts/resolve-github-release.mjs scripts/__tests__/github-release.test.mjs
git commit -m "feat: add fail-closed release discovery"
```

### Task 2: Tested Synchronization Health Evaluator

**Files:**
- Create: `scripts/lib/sync-health.mjs`
- Create: `scripts/check-sync-health.mjs`
- Test: `scripts/__tests__/sync-health.test.mjs`

**Interfaces:**
- Produces: `evaluateSyncHealth({ now, staleAfterMinutes, stuckAfterMinutes, workflows })`.
- Produces states: `healthy`, `running`, `recoverable`, and `critical`.
- CLI writes `healthy`, `state`, `should_dispatch`, `should_alert`, and `summary` to GitHub outputs and writes JSON with `--json-output`.

- [ ] **Step 1: Write failing tests**

Test fresh success, stale success, latest failure, active normal run, stuck active run, missing runs, and invalid API data.

```js
const health = evaluateSyncHealth({
  now: new Date('2026-08-17T12:00:00Z'),
  staleAfterMinutes: 120,
  stuckAfterMinutes: 90,
  workflows: [{ id: 'coordinator', latestSuccessAt: '2026-08-17T11:30:00Z', latestRun: { status: 'completed', conclusion: 'success' } }],
})
assert.equal(health.state, 'healthy')
```

- [ ] **Step 2: Run tests and confirm RED**

```powershell
node --test scripts/__tests__/sync-health.test.mjs
```

- [ ] **Step 3: Implement evaluator and CLI**

The CLI must query both workflow run APIs, avoid dispatch when an active run is younger than the stuck threshold, and return recoverable only when no active coordinator exists.

- [ ] **Step 4: Run tests and confirm GREEN**

- [ ] **Step 5: Commit**

```powershell
git add scripts/lib/sync-health.mjs scripts/check-sync-health.mjs scripts/__tests__/sync-health.test.mjs
git commit -m "feat: add synchronization health evaluation"
```

### Task 3: Contract Tests for Alerting, Watchdog, Retry, and Atomic Publication

**Files:**
- Modify: `scripts/__tests__/release-pipeline-contract.test.mjs`
- Modify: `scripts/__tests__/infinite-canvas-workflows.test.mjs`
- Modify: `scripts/__tests__/workflow-trigger.test.mjs`
- Modify: `scripts/lib/release-pipeline-contract.mjs`

**Interfaces:**
- Contract violation codes: `sync.release_discovery_cli`, `sync.network_retry`, `sync.failure_alert`, `sync.watchdog`, `sync.action_pins`, `sync.workflow_summary`, and `sync.owned_workflows`.

- [ ] **Step 1: Add failing tests**

Tests must mutate loaded workflow text to remove each required behavior and assert the corresponding violation code.

```js
files.set(path, files.get(path).replace('uses: ./.github/workflows/automation-alert.yml', ''))
const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
assert.ok(violations.some((violation) => violation.code === 'sync.failure_alert'))
```

- [ ] **Step 2: Run tests and confirm RED**

```powershell
node --test scripts/__tests__/release-pipeline-contract.test.mjs scripts/__tests__/infinite-canvas-workflows.test.mjs scripts/__tests__/workflow-trigger.test.mjs
```

- [ ] **Step 3: Add minimal contract checks**

Add checks without weakening existing immutable-release, exact-SHA, binary-repair, and latest-promotion checks.

- [ ] **Step 4: Run tests; expected partial GREEN**

Contract unit mutations pass, while the current repository conformance test remains RED until Tasks 4-6 add the required files and workflow content.

- [ ] **Step 5: Commit**

```powershell
git add scripts/lib/release-pipeline-contract.mjs scripts/__tests__/release-pipeline-contract.test.mjs scripts/__tests__/infinite-canvas-workflows.test.mjs scripts/__tests__/workflow-trigger.test.mjs
git commit -m "test: define synchronization hardening contract"
```

### Task 4: Reusable Alert Workflow and Watchdog

**Files:**
- Create: `.github/workflows/automation-alert.yml`
- Create: `.github/workflows/sync-watchdog.yml`

**Interfaces:**
- `automation-alert.yml` inputs: `workflow_name`, `severity`, `summary`, `run_url`, and optional `issue_title`.
- `sync-watchdog.yml` calls `scripts/check-sync-health.mjs`, dispatches `infinite-canvas-upstream-sync.yml` only when `should_dispatch == true`, calls the alert workflow when unhealthy, closes the incident issue on recovery, and uploads `/tmp/sync-health.json`.

- [ ] **Step 1: Run repository conformance test and confirm RED**

```powershell
node scripts/verify-release-pipeline.mjs --root .
```

Expected: violations for missing alert and watchdog workflows.

- [ ] **Step 2: Implement reusable alert workflow**

Use `gh issue list/create/comment` with a stable title and optional Telegram `curl`. Put inputs into environment variables rather than interpolating them directly into shell source.

- [ ] **Step 3: Implement watchdog workflow**

Use schedule `41 * * * *`, `workflow_dispatch`, `actions: write`, `issues: write`, and `contents: read`. Add `timeout-minutes: 15`, a JSON artifact, step summary, coordinator dispatch, alert call, recovery issue closure, and final visible failure for unhealthy states.

- [ ] **Step 4: Run contract tests**

Expected: watchdog and alert checks pass; existing-workflow hardening checks may remain RED.

- [ ] **Step 5: Commit**

```powershell
git add .github/workflows/automation-alert.yml .github/workflows/sync-watchdog.yml
git commit -m "feat: add synchronization watchdog and alerts"
```

### Task 5: Harden Existing Synchronization Workflows

**Files:**
- Create: `scripts/ci/retry.sh`
- Modify: `.github/workflows/infinite-canvas-upstream-sync.yml`
- Modify: `.github/workflows/upstream-theme-sync.yml`
- Modify: `.github/workflows/theme-binary-release.yml`

**Interfaces:**
- `retry_with_backoff MAX_ATTEMPTS BASE_DELAY COMMAND...` returns the final command exit code.
- Primary workflows call `automation-alert.yml` on required-job failure.

- [ ] **Step 1: Add a failing static test for retry helper and workflow use**

Assert the helper exists, contains bounded retry logic, and is sourced before network fetch or dispatch operations.

- [ ] **Step 2: Run tests and confirm RED**

- [ ] **Step 3: Implement retry helper**

Use exponential delay plus bounded jitter. Preserve the final exit code and print attempt counts.

- [ ] **Step 4: Replace release API discovery**

Use `node scripts/resolve-github-release.mjs` in both synchronization workflows. Preserve explicit no-release fallback and `git check-ref-format` validation.

- [ ] **Step 5: Wrap transient git and dispatch operations**

Source `scripts/ci/retry.sh` for upstream tag fetch, fallback branch fetch, Canvas tag fetch, and workflow dispatch. Do not wrap builds or validation commands.

- [ ] **Step 6: Add timeouts, summaries, and failure alerts**

Use job-level timeouts, final `$GITHUB_STEP_SUMMARY` steps, and reusable alert jobs. Move coordinator schedule from minute 7 to minute 17.

- [ ] **Step 7: Extend workflow snapshot allowlist**

Add `automation-alert.yml` and `sync-watchdog.yml` to the owned workflow snapshot set and comparison gate.

- [ ] **Step 8: Run contract and workflow tests**

Expected: all workflow conformance tests pass.

- [ ] **Step 9: Commit**

```powershell
git add scripts/ci/retry.sh .github/workflows/infinite-canvas-upstream-sync.yml .github/workflows/upstream-theme-sync.yml .github/workflows/theme-binary-release.yml
git commit -m "fix: harden synchronization orchestration"
```

### Task 6: Pin Remote Actions and Preserve the Pins

**Files:**
- Modify: `.github/workflows/backend-ci.yml`
- Modify: `.github/workflows/infinite-canvas-upstream-sync.yml`
- Modify: `.github/workflows/upstream-theme-sync.yml`
- Modify: `.github/workflows/theme-binary-release.yml`
- Modify: `.github/workflows/sync-watchdog.yml`

**Interfaces:**
- Remote action references use 40-character commit SHAs followed by comments naming the release tag.

- [ ] **Step 1: Add failing action-pin contract tests**

Reject remote `uses:` references ending in mutable tags such as `@v6` or `@v2`.

- [ ] **Step 2: Resolve official tag SHAs through the GitHub API**

Resolve checkout, setup-go, setup-node, pnpm/action-setup, setup-bun, golangci-lint-action, upload-artifact, and goreleaser-action tags to commits.

- [ ] **Step 3: Replace mutable references**

Keep local reusable workflow references unchanged.

- [ ] **Step 4: Run contract tests and confirm GREEN**

- [ ] **Step 5: Commit**

```powershell
git add .github/workflows
git commit -m "chore: pin synchronization actions"
```

### Task 7: Runbook and Complete Verification

**Files:**
- Create: `docs/UPSTREAM_SYNC_RUNBOOK.md`

**Interfaces:**
- Documents release-only semantics, states, alerts, manual dispatch, repair, rollback, and verification commands.

- [ ] **Step 1: Write the runbook**

Include exact `gh` commands for listing runs, dispatching the coordinator/watchdog, reading release metadata, checking incident issues, and validating required assets.

- [ ] **Step 2: Run all script tests**

```powershell
$tests = Get-ChildItem scripts/__tests__/*.test.mjs | ForEach-Object FullName
node --test @tests
```

Expected: zero failed tests.

- [ ] **Step 3: Run release contract and syntax checks**

```powershell
node scripts/verify-release-pipeline.mjs --root .
bash -n scripts/ci/retry.sh
git diff --check
node scripts/check-encoding.mjs
```

Expected: all commands exit zero.

- [ ] **Step 4: Commit**

```powershell
git add docs/UPSTREAM_SYNC_RUNBOOK.md
git commit -m "docs: add upstream synchronization runbook"
```

### Task 8: Remote Rollout and Live Verification

**Files:** None.

- [ ] **Step 1: Push branch and open pull request**

```powershell
git push -u origin codex/sync-hardening
gh pr create --base main --head codex/sync-hardening --title "fix: harden upstream synchronization and monitoring" --body-file docs/superpowers/specs/2026-08-17-sync-hardening-design.md
```

- [ ] **Step 2: Wait for all PR checks**

```powershell
gh pr checks --watch
```

Expected: all required checks pass.

- [ ] **Step 3: Merge the verified pull request**

```powershell
gh pr merge --squash --delete-branch
```

- [ ] **Step 4: Dispatch watchdog and coordinator on main**

```powershell
gh workflow run sync-watchdog.yml --ref main
gh workflow run infinite-canvas-upstream-sync.yml --ref main
```

- [ ] **Step 5: Wait for both runs and verify results**

Both workflows must complete successfully. The coordinator must produce either a verified no-op or a complete release. The watchdog must report `healthy` or `running` without opening an unresolved incident issue.

- [ ] **Step 6: Verify original workspace preservation**

Confirm the branch and untracked files under `E:\sub2模板` are unchanged.