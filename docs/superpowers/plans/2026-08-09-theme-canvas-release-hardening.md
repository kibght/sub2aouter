# Theme, Canvas, and Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make theme/Canvas drift checks exact, restore self-hosted Canvas behavior, and serialize source, binary, and `latest` publication around an immutable generated commit.

**Architecture:** Exact replacement blocks become the idempotency contract instead of sentinel-only checks. GitHub Release discovery is read once and fails closed, upstream tags use a private ref, Canvas merge is bound to the tested SHA, and the binary workflow becomes a reusable job awaited by the source publication workflow before `latest` promotion.

**Tech Stack:** Node.js `node:test`, Vue 3/Vitest, GitHub Actions YAML/Bash, Git worktrees/submodules, pnpm, Bun, Go.

## Global Constraints

- Preserve all existing Chinese source text verbatim unless the approved fix requires adding new text; never introduce mojibake.
- Work from `origin/main` in `codex/fix-theme-canvas-release-batches-1-2`.
- Follow red-green-refactor for every behavior change.
- Do not implement the separate third-batch credential isolation in this change.
- Generated and permanent copies of workflow, Canvas, test, and documentation files must remain byte-equivalent where the repository already enforces copies.

---

### Task 1: Reject partial theme and Canvas replacement drift

**Files:**
- Modify: `scripts/lib/theme-overlay.mjs`
- Modify: `scripts/apply-sub2-infinite-canvas-integration.mjs`
- Modify: `scripts/__tests__/theme-overlay.test.mjs`
- Create: `scripts/__tests__/infinite-canvas-replacement.test.mjs`

**Interfaces:**
- Consumes: manifest `marker`, `sentinel`, `operation`, and patch source text.
- Produces: exact replacement idempotency; `ensureReplace()` rejects sentinel-only partial drift.

- [ ] **Step 1: Write failing partial-drift tests**

Add a theme test that applies a multi-line replacement, changes a non-sentinel line, and asserts `checkTheme()` rejects or reports drift. Add a Canvas test using a temporary file where sentinel remains but the full replacement is damaged.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node --test scripts/__tests__/theme-overlay.test.mjs scripts/__tests__/infinite-canvas-replacement.test.mjs
```

Expected: the new partial-drift assertions fail because current code returns on sentinel presence.

- [ ] **Step 3: Implement exact replacement checks**

Normalize the replacement first. Return only when the full normalized replacement exists. Throw a drift error when sentinel exists without the full replacement. Export `ensureReplace` for direct file-level tests.

- [ ] **Step 4: Run focused and complete Node tests**

```powershell
node --test scripts/__tests__/theme-overlay.test.mjs scripts/__tests__/infinite-canvas-replacement.test.mjs
node --test scripts/__tests__/*.test.mjs
```

Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add scripts/lib/theme-overlay.mjs scripts/apply-sub2-infinite-canvas-integration.mjs scripts/__tests__/theme-overlay.test.mjs scripts/__tests__/infinite-canvas-replacement.test.mjs
git commit -m "fix: reject partial theme and canvas drift"
```

### Task 2: Fix self-hosted Canvas entry, gateway, and locale bridge

**Files:**
- Modify: `frontend/src/features/infiniteCanvas/bridge.ts`
- Modify: `frontend/src/features/infiniteCanvas/__tests__/bridge.spec.ts`
- Modify: `frontend/src/views/user/InfiniteCanvasView.vue`
- Modify: `frontend/src/views/user/__tests__/InfiniteCanvasView.spec.ts`
- Modify: `scripts/infinite-canvas-integration/sub2-files/frontend/src/features/infiniteCanvas/bridge.ts`
- Modify: `scripts/infinite-canvas-integration/sub2-files/frontend/src/features/infiniteCanvas/__tests__/bridge.spec.ts`
- Modify: `scripts/infinite-canvas-integration/sub2-files/frontend/src/views/user/InfiniteCanvasView.vue`
- Modify: `scripts/infinite-canvas-integration/sub2-files/frontend/src/views/user/__tests__/InfiniteCanvasView.spec.ts`
- Modify: `scripts/infinite-canvas-integration/canvas-files/web/src/lib/sub2-bridge.ts`
- Modify: `scripts/__tests__/infinite-canvas-integration.test.mjs`
- Modify: `docs/infinite-canvas.md`
- Modify: `scripts/infinite-canvas-integration/sub2-files/docs/infinite-canvas.md`

**Interfaces:**
- Produces: `buildCanvasEntryUrl(origin, appPath?)`, idempotent `buildGatewayBaseUrl(baseUrl)`, and locale application in child bridge.

- [ ] **Step 1: Write failing frontend and template tests**

Require current-origin `/canvas-app/canvas?mode=new`, configured gateway Base URL, no duplicate `/v1`, and child `changeAppLocale` usage.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
corepack pnpm --dir frontend exec vitest run src/features/infiniteCanvas/__tests__/bridge.spec.ts src/views/user/__tests__/InfiniteCanvasView.spec.ts
node --test scripts/__tests__/infinite-canvas-integration.test.mjs
```

- [ ] **Step 3: Implement helpers and view wiring**

Use a computed entry URL and gateway Base URL based on `cachedPublicSettings.api_base_url || window.location.origin`. Validate and apply child locale.

- [ ] **Step 4: Synchronize permanent template copies and docs**

Copy changed Sub2 files byte-for-byte to `scripts/infinite-canvas-integration/sub2-files`. Update both Canvas documents to use the current-site `/canvas-app/canvas?mode=new` entry.

- [ ] **Step 5: Run focused tests and integration check**

```powershell
corepack pnpm --dir frontend exec vitest run src/features/infiniteCanvas/__tests__/bridge.spec.ts src/views/user/__tests__/InfiniteCanvasView.spec.ts
node --test scripts/__tests__/infinite-canvas-integration.test.mjs
node scripts/apply-sub2-infinite-canvas-integration.mjs --root . --check
```

- [ ] **Step 6: Commit**

```powershell
git add frontend/src/features/infiniteCanvas frontend/src/views/user/InfiniteCanvasView.vue frontend/src/views/user/__tests__/InfiniteCanvasView.spec.ts scripts/infinite-canvas-integration scripts/__tests__/infinite-canvas-integration.test.mjs docs/infinite-canvas.md
git commit -m "fix: honor self-hosted canvas configuration"
```

### Task 3: Harden Release discovery, tag refs, and Canvas merge identity

**Files:**
- Modify: `.github/workflows/infinite-canvas-upstream-sync.yml`
- Modify: `.github/workflows/upstream-theme-sync.yml`
- Modify: `scripts/__tests__/infinite-canvas-workflows.test.mjs`
- Modify: `scripts/lib/release-pipeline-contract.mjs`
- Modify: `scripts/__tests__/release-pipeline-contract.test.mjs`

**Interfaces:**
- Produces: fail-closed release discovery, `refs/apophis/upstream-release`, monotonic SHA validation, and `--match-head-commit` merge.

- [ ] **Step 1: Add failing workflow contract tests**

Reject `releases/latest ... || true`, reject `refs/tags/${UPSTREAM_RELEASE_TAG}` as a destination, require a single tag/id query, require ancestry checks, require external tag values through `env:`, and require PR head comparison plus `--match-head-commit`.

- [ ] **Step 2: Run workflow tests and verify RED**

```powershell
node --test scripts/__tests__/infinite-canvas-workflows.test.mjs scripts/__tests__/release-pipeline-contract.test.mjs
```

- [ ] **Step 3: Implement fail-closed release reads and private ref fetches**

Capture `tag_name` and `id` from one API response. Treat only 404 as no release. Fetch Sub2 tags into `refs/apophis/upstream-release`. Require scheduled target ancestry and identity+SHA deduplication.

- [ ] **Step 4: Lock Canvas merge to tested SHA**

Move release tag output into an `env:` value, compare `headRefOid` with `update_sha`, and merge using `--match-head-commit`.

- [ ] **Step 5: Run contract tests**

```powershell
node --test scripts/__tests__/infinite-canvas-workflows.test.mjs scripts/__tests__/release-pipeline-contract.test.mjs
node scripts/verify-release-pipeline.mjs --root .
```

- [ ] **Step 6: Commit**

```powershell
git add .github/workflows/infinite-canvas-upstream-sync.yml .github/workflows/upstream-theme-sync.yml scripts/lib/release-pipeline-contract.mjs scripts/__tests__/infinite-canvas-workflows.test.mjs scripts/__tests__/release-pipeline-contract.test.mjs
git commit -m "fix: bind upstream updates to immutable releases"
```

### Task 4: Serialize binary publication and promote latest last

**Files:**
- Modify: `.github/workflows/theme-binary-release.yml`
- Modify: `.github/workflows/upstream-theme-sync.yml`
- Modify: `theme/apophis/files/.github/workflows/theme-binary-release.yml`
- Modify: `scripts/__tests__/infinite-canvas-workflows.test.mjs`
- Modify: `scripts/lib/release-pipeline-contract.mjs`
- Modify: `scripts/__tests__/release-pipeline-contract.test.mjs`
- Modify: `scripts/__tests__/theme-boundary.test.mjs`
- Modify: `scripts/__tests__/workflow-trigger.test.mjs`

**Interfaces:**
- `sync-build-publish` outputs `run_binary`, `should_promote_latest`, `release_ref`, and `release_version`.
- Reusable binary workflow consumes `release_ref: string`.
- `promote-latest` consumes `release_version` only after reusable binary success.

- [ ] **Step 1: Add failing orchestration tests**

Require `workflow_call`, forbid `workflow_run`, require immutable checkout input, require caller reusable job, require `promote-latest` after binary, forbid direct `gh workflow run theme-binary-release.yml`, and forbid `latest` push inside source job.

- [ ] **Step 2: Run tests and verify RED**

```powershell
node --test scripts/__tests__/infinite-canvas-workflows.test.mjs scripts/__tests__/release-pipeline-contract.test.mjs scripts/__tests__/theme-boundary.test.mjs scripts/__tests__/workflow-trigger.test.mjs
```

- [ ] **Step 3: Convert binary workflow to reusable/manual single entry**

Add `workflow_call.inputs.release_ref`; keep manual `workflow_dispatch.inputs.release_ref`; remove `workflow_run`; checkout `${{ inputs.release_ref || 'themed-release' }}`; key concurrency by release ref.

- [ ] **Step 4: Export source job outputs and call reusable binary workflow**

Remove explicit binary dispatch. Export the exact remote `themed-release` commit and effective version. Add a job-level reusable workflow invocation guarded by `run_binary == 'true'`.

- [ ] **Step 5: Promote latest only after binary success**

Add a minimal packages-write job that pulls `:${release_version}`, tags it `:latest`, and pushes only when `should_promote_latest == 'true'` and binary succeeded.

- [ ] **Step 6: Synchronize permanent binary workflow copy**

Copy `.github/workflows/theme-binary-release.yml` byte-for-byte to `theme/apophis/files/.github/workflows/theme-binary-release.yml`.

- [ ] **Step 7: Run orchestration contracts**

```powershell
node --test scripts/__tests__/infinite-canvas-workflows.test.mjs scripts/__tests__/release-pipeline-contract.test.mjs scripts/__tests__/theme-boundary.test.mjs scripts/__tests__/workflow-trigger.test.mjs
node scripts/verify-release-pipeline.mjs --root .
```

- [ ] **Step 8: Commit**

```powershell
git add .github/workflows theme/apophis/files/.github/workflows/theme-binary-release.yml scripts/lib/release-pipeline-contract.mjs scripts/__tests__
git commit -m "fix: publish themed releases atomically"
```

### Task 5: Preserve verified workflows and bind push content to its SHA

**Files:**
- Modify: `.github/workflows/upstream-theme-sync.yml`
- Modify: `scripts/__tests__/theme-boundary.test.mjs`
- Modify: `scripts/__tests__/workflow-trigger.test.mjs`
- Modify: `scripts/lib/release-pipeline-contract.mjs`
- Modify: `scripts/__tests__/release-pipeline-contract.test.mjs`

- [ ] **Step 1: Add failing snapshot and checkout tests**

Forbid removal/restoration of generated workflows, require a final contract/cmp gate before `git write-tree`, require push checkout at `github.sha`, and require repository source SHA from actual `HEAD`.

- [ ] **Step 2: Run tests and verify RED**

```powershell
node --test scripts/__tests__/theme-boundary.test.mjs scripts/__tests__/workflow-trigger.test.mjs scripts/__tests__/release-pipeline-contract.test.mjs
```

- [ ] **Step 3: Remove workflow restoration and add final verification**

Keep the freshly generated workflow directory. Compare critical workflows with `$GITHUB_WORKSPACE` and rerun release contract before creating the root snapshot.

- [ ] **Step 4: Fix push checkout/source SHA consistency**

Use the push event SHA for push checkouts and `git rev-parse HEAD` as repository release source.

- [ ] **Step 5: Run focused contracts and commit**

```powershell
node --test scripts/__tests__/theme-boundary.test.mjs scripts/__tests__/workflow-trigger.test.mjs scripts/__tests__/release-pipeline-contract.test.mjs
node scripts/verify-release-pipeline.mjs --root .
git add .github/workflows/upstream-theme-sync.yml scripts/lib/release-pipeline-contract.mjs scripts/__tests__
git commit -m "fix: publish the verified workflow snapshot"
```

### Task 6: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `theme/apophis/files/README.md`
- Modify: `THEME.md`
- Modify: `docs/infinite-canvas.md`
- Modify: `scripts/infinite-canvas-integration/sub2-files/docs/infinite-canvas.md`

- [ ] **Step 1: Update release and synchronization documentation**

Describe the single hourly coordinator, fail-closed Release reads, immutable generated commit, awaited binary publication, and final `latest` promotion.

- [ ] **Step 2: Run complete Node and encoding verification**

```powershell
node scripts/check-encoding.mjs .
node scripts/apply-theme.mjs --root . --check
node scripts/apply-sub2-infinite-canvas-integration.mjs --root . --check
node scripts/verify-release-pipeline.mjs --root .
node --test scripts/__tests__/*.test.mjs
```

- [ ] **Step 3: Run frontend verification**

```powershell
corepack pnpm --dir frontend install --frozen-lockfile
corepack pnpm --dir frontend run lint:check
corepack pnpm --dir frontend run typecheck
corepack pnpm --dir frontend run test:run
corepack pnpm --dir frontend run build
```

- [ ] **Step 4: Run Canvas verification**

Apply the adapter in a disposable submodule checkout, install with Bun 1.3.13, then run Canvas typecheck and production build with `VITE_BASE=/canvas-app/`.

- [ ] **Step 5: Run Go and repository verification**

```powershell
go test -tags=unit ./...
git diff --check
git status --short
```

- [ ] **Step 6: Commit documentation and final corrections**

```powershell
git add README.md theme/apophis/files/README.md THEME.md docs/infinite-canvas.md scripts/infinite-canvas-integration/sub2-files/docs/infinite-canvas.md
git commit -m "docs: describe serialized themed releases"
```
