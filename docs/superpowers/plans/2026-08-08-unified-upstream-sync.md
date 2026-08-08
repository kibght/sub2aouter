# Unified Upstream Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Collapse the Canvas and Sub2API scheduled checks into one hourly release round that publishes at most one version.

**Architecture:** The Infinite Canvas workflow owns the hourly schedule and always dispatches the theme sync after its Canvas check. The theme sync keeps manual and normal push entry points, but its independent schedule is removed and Canvas automation pushes are ignored to prevent duplicate publication.

**Tech Stack:** GitHub Actions YAML, Node.js `node:test`, PowerShell, Git.

---

### Task 1: Lock the unified scheduling contract with failing tests

**Files:**
- Modify: `scripts/__tests__/infinite-canvas-workflows.test.mjs`

- [x] Change the scheduler test to require Canvas cron `7 * * * *` and no Sub2 schedule.
- [x] Add assertions that Canvas dispatches `upstream-theme-sync.yml` with `repository_release=false` for both changed and unchanged Canvas states.
- [x] Add an assertion that the theme workflow skips the automated Canvas merge push.
- [x] Run `node --test scripts/__tests__/infinite-canvas-workflows.test.mjs` and confirm the old workflow fails these assertions.

### Task 2: Implement the single coordinator workflow

**Files:**
- Modify: `.github/workflows/infinite-canvas-upstream-sync.yml`

- [x] Change the schedule to `7 * * * *`.
- [x] Make the final dispatch run whenever the upstream detection step produced `changed=true` or `changed=false`.
- [x] Dispatch `upstream-theme-sync.yml` with `repository_release=false` and `scheduled_round=true`.
- [x] Keep Canvas PR validation and merge before dispatch when Canvas changed.

### Task 3: Remove the competing scheduled publisher

**Files:**
- Modify: `.github/workflows/upstream-theme-sync.yml`

- [x] Remove the independent `schedule` trigger.
- [x] Add a job-level guard that skips `main` push events whose commit message is the automated Infinite Canvas merge.
- [x] Preserve ordinary `main` pushes and manual dispatches.

### Task 4: Verify the release contract

**Files:**
- Test: `scripts/__tests__/infinite-canvas-workflows.test.mjs`
- Test: all `scripts/__tests__/*.test.mjs`

- [x] Run syntax checks, focused workflow tests, all Node tests, encoding checks, and `git diff --check`.
- [x] Confirm no workflow dispatch command was executed locally.

### Task 5: Commit and push only the intended files

**Files:**
- Add the design and plan docs plus workflow/test changes.
- Do not stage pre-existing untracked assets or unrelated scripts.

- [x] Review `git diff` and `git status`.
- [x] Commit with a message describing unified upstream synchronization.
- [x] Push the current `main` branch and verify the remote commit.
