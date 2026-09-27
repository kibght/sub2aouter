# Upstream Automation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make upstream automation target the correct repository and gate every Infinite Canvas merge on the complete repository CI suite.

**Architecture:** Convert the existing CI workflow into a reusable workflow accepting an immutable commit SHA. Split the hourly Canvas coordinator into update, reusable-CI, merge, and release-dispatch jobs so publication cannot occur before validation and merge success.

**Tech Stack:** GitHub Actions YAML, Node.js `node:test`, existing release-pipeline contract verifier, Git submodules.

## Global Constraints

- Preserve all existing Chinese text verbatim unless a documented stale sentence is intentionally replaced.
- Keep `cron: '7 * * * *'` and the single hourly coordinator.
- Keep existing release versioning, release identity deduplication, image ordering, and recovery behavior.
- Do not alter unrelated user files or generated homepage assets.
- Every GitHub CLI repository-sensitive command added or changed must use `--repo "$GITHUB_REPOSITORY"`.

---

### Task 1: Add failing contracts for the complete CI gate

**Files:**
- Modify: `scripts/__tests__/infinite-canvas-workflows.test.mjs`
- Modify: `scripts/__tests__/release-pipeline-contract.test.mjs`
- Modify: `scripts/lib/release-pipeline-contract.mjs`

**Interfaces:**
- Consumes: Existing workflow text files loaded as UTF-8.
- Produces: Contract codes `ci.reusable_ref`, `canvas_sync.full_ci_gate`, and `canvas_sync.repository_selection`.

- [ ] **Step 1: Write failing workflow assertions**

Assert that `backend-ci.yml` has `workflow_call`, accepts `ref`, and all five checkout steps use `${{ inputs.ref || github.sha }}`. Assert that the Canvas workflow calls it with `needs.update.outputs.update_sha`, merges after that call, and uses explicit repository selection.

- [ ] **Step 2: Write failing mutation tests**

Mutate away `workflow_call`, the reusable CI call, the CI dependency, and explicit `--repo`; verify the matching contract violation codes are returned.

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
node --test scripts/__tests__/infinite-canvas-workflows.test.mjs scripts/__tests__/release-pipeline-contract.test.mjs
```

Expected: failures because the current Canvas workflow merges inside its only job and `backend-ci.yml` is not reusable.

### Task 2: Make CI reusable for an immutable ref

**Files:**
- Modify: `.github/workflows/backend-ci.yml`

**Interfaces:**
- Consumes: Optional `workflow_call.inputs.ref` string.
- Produces: Complete CI execution against `${{ inputs.ref || github.sha }}`.

- [ ] **Step 1: Add `workflow_call` input**

Add:

```yaml
  workflow_call:
    inputs:
      ref:
        description: Commit, branch, or tag to verify
        required: false
        type: string
```

- [ ] **Step 2: Pin every checkout to the selected ref**

Every `actions/checkout@v6` receives:

```yaml
with:
  ref: ${{ inputs.ref || github.sha }}
```

The Infinite Canvas checkout also retains `submodules: recursive`.

- [ ] **Step 3: Run targeted tests**

Run the command from Task 1. Expected: reusable-CI assertions pass; Canvas gate assertions remain RED.

### Task 3: Gate Canvas merge and release dispatch on complete CI

**Files:**
- Modify: `.github/workflows/infinite-canvas-upstream-sync.yml`

**Interfaces:**
- Produces from `update`: `changed`, `update_sha`, `pr_number`.
- Consumes in `full-ci`: `needs.update.outputs.update_sha`.
- Consumes in `merge`: `needs.update.outputs.pr_number` after `full-ci` succeeds.

- [ ] **Step 1: Add update job outputs**

Assign IDs to the update-branch and PR steps. Write the committed SHA and PR number to `$GITHUB_OUTPUT`.

- [ ] **Step 2: Stop merging in the update job**

The PR step only creates or locates the PR. Remove immediate `gh pr merge` and PR-state verification from this job.

- [ ] **Step 3: Add reusable full CI job**

```yaml
  full-ci:
    needs: update
    if: needs.update.outputs.changed == 'true'
    uses: ./.github/workflows/backend-ci.yml
    with:
      ref: ${{ needs.update.outputs.update_sha }}
```

- [ ] **Step 4: Add merge job**

Require `[update, full-ci]`, merge with `--repo "$GITHUB_REPOSITORY"`, and verify the resulting PR state is `MERGED`.

- [ ] **Step 5: Add guarded release-dispatch job**

Use `always()` so the unchanged path can run despite skipped CI/merge jobs, but require successful full CI and merge when `changed == true`. Dispatch `upstream-theme-sync.yml` with explicit `--repo`.

- [ ] **Step 6: Run targeted tests and verify GREEN**

Run the Task 1 command. Expected: all targeted tests pass.

### Task 4: Align active documentation and local submodule state

**Files:**
- Modify: `README.md`
- Modify: `theme/apophis/files/README.md`
- Restore checkout only: `integrations/infinite-canvas`

**Interfaces:**
- Active README and permanent theme copy remain identical for the edited sentences.

- [ ] **Step 1: Add documentation assertions**

Extend the repository homepage or release workflow tests to require hourly coordination and reject the stale 30-minute updater statement.

- [ ] **Step 2: Verify RED**

Run the affected test and confirm the stale README fails it.

- [ ] **Step 3: Update both active README copies**

Describe the hourly Canvas coordinator and the version card's cached-on-load/manual-refresh behavior.

- [ ] **Step 4: Restore the submodule checkout**

Verify the submodule has no file changes, then checkout the parent-recorded gitlink commit `a2576d559ad765ba83e9563894adfbcd4e63405a` without altering the gitlink.

### Task 5: Full verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Verify release contract**

```powershell
node scripts/verify-release-pipeline.mjs --root .
```

- [ ] **Step 2: Run all script tests**

```powershell
$tests = Get-ChildItem scripts\__tests__ -Filter '*.test.mjs' -File | ForEach-Object FullName
node --test $tests
```

Expected: zero failures.

- [ ] **Step 3: Validate encoding, YAML, and diff**

Run UTF-8 encoding check, parse all seven workflows with duplicate-key detection, and run `git diff --check`.

- [ ] **Step 4: Re-test CLI repository resolution**

Confirm a repository with both `origin` and `upstream` resolves implicitly to upstream, while every affected workflow command now contains explicit `--repo "$GITHUB_REPOSITORY"`.

- [ ] **Step 5: Review final diff**

Confirm only upstream automation, contracts, active documentation, design/plan files, and the restored submodule checkout changed.
