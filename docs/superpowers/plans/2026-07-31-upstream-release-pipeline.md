# Upstream Release Pipeline Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add executable regression protection for automatic upstream publishing and frontend discovery of newly published themed releases.

**Architecture:** A dependency-free Node.js module reads critical workflow, backend, frontend, and theme-manifest files and returns contract violations. A CLI exposes the verifier to GitHub Actions, while tests build temporary broken fixtures to prove each failure path.

**Tech Stack:** Node.js ESM, `node:test`, GitHub Actions YAML, Go unit tests.

---

### Task 1: Add failing release-pipeline contract tests

**Files:**
- Create: `scripts/__tests__/release-pipeline-contract.test.mjs`
- Create: `scripts/lib/release-pipeline-contract.mjs`

- [ ] Write tests importing `verifyReleasePipelineContract` from the missing module.
- [ ] Cover the valid repository plus broken schedule, missing successful `workflow_run`, wrong frontend repository, and explicit contributor-card content.
- [ ] Run `node --test scripts/__tests__/release-pipeline-contract.test.mjs` and verify it fails because the module is missing.

### Task 2: Implement the contract verifier and CLI

**Files:**
- Create: `scripts/lib/release-pipeline-contract.mjs`
- Create: `scripts/verify-release-pipeline.mjs`

- [ ] Implement file loading, ordered workflow checks, manifest persistence checks, frontend update checks, and template contributor checks.
- [ ] Implement CLI argument parsing for `--root`, print every violation to stderr, and return exit code 1 on failure.
- [ ] Run the focused test and verify all cases pass.
- [ ] Run `node scripts/verify-release-pipeline.mjs --root .` and verify exit code 0.

### Task 3: Enforce the contract in upstream sync

**Files:**
- Modify: `.github/workflows/upstream-theme-sync.yml`
- Modify: `scripts/__tests__/workflow-trigger.test.mjs`

- [ ] Add a failing test requiring `Verify release pipeline contract` before upstream fetch/build/publish steps.
- [ ] Run the focused workflow test and verify failure.
- [ ] Add the CLI step immediately after checkout.
- [ ] Run the focused workflow test and verify success.

### Task 4: Verify calendar release versions and frontend update discovery

**Files:**
- Modify: `backend/internal/service/update_service_test.go`
- Modify: `scripts/__tests__/theme-boundary.test.mjs` only if the contract is not already covered by the new integration test.

- [ ] Add table-driven Go tests proving `2026.7.21 < 2026.7.22`, `2026.7.99 < 2026.8.1`, and `2026.12.99 < 2027.1.1`.
- [ ] Run the focused Go unit test.
- [ ] Run all script tests and the release-pipeline CLI.

### Task 5: Final verification and delivery

**Files:**
- Verify all changed files.

- [ ] Run `node --test scripts/__tests__/*.test.mjs`.
- [ ] Run `node scripts/verify-release-pipeline.mjs --root .`.
- [ ] Run `go test -tags unit ./internal/service -run 'TestCompareVersionsCalendarRelease|TestUpdateService'` from `backend`.
- [ ] Run `git diff --check` and inspect `git status`.
- [ ] Commit and push to `main`, then verify CI, Sync Upstream With Apophis Theme, Docker latest, and Publish Themed Binary Release.