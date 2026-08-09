import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  RELEASE_PIPELINE_FILES,
  verifyReleasePipelineContract,
} from '../lib/release-pipeline-contract.mjs'

async function loadContractFiles() {
  const entries = await Promise.all(
    RELEASE_PIPELINE_FILES.map(async (path) => [path, await readFile(path, 'utf8')]),
  )
  return new Map(entries)
}

function readerFor(files) {
  return async (path) => {
    if (!files.has(path)) {
      throw new Error(`fixture is missing ${path}`)
    }
    return files.get(path)
  }
}

test('current repository satisfies the automatic release and frontend update contract', async () => {
  const violations = await verifyReleasePipelineContract('.')
  assert.deepEqual(violations, [])
})

test('contract rejects literal question-mark placeholders in upstream release notes', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/upstream-theme-sync.yml'
  files.set(
    path,
    files.get(path).replace(
      "cat \"$GENERATED_DIR/.apophis-upstream-release-notes.md\"",
      "printf '???????%s\\n\\n' \"$UPSTREAM_RELEASE_URL\"",
    ),
  )

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.release_notes_encoding'))
})

test('contract rejects any long literal question-mark sequence in release workflows', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/upstream-theme-sync.yml'
  files.set(path, `${files.get(path)}
printf '?????????'
`)

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.release_notes_encoding'))
})

test('contract rejects a coordinator that moves off the hourly schedule', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/infinite-canvas-upstream-sync.yml'
  files.set(path, files.get(path).replace("cron: '7 * * * *'", "cron: '0 * * * *'"))

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'canvas_sync.schedule'))
})

test('contract requires a reusable binary entry and forbids workflow_run recursion', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/theme-binary-release.yml'
  files.set(
    path,
    files.get(path)
      .replace('workflow_call:', 'disabled_workflow_call:')
      .replace('workflow_dispatch:', 'workflow_dispatch:\n  workflow_run:'),
  )

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'binary.reusable_entry'))
})

test('contract rejects a frontend that checks the upstream repository instead of themed releases', async () => {
  const files = await loadContractFiles()
  const path = 'frontend/src/components/common/VersionBadge.vue'
  files.set(path, files.get(path).replace('kibght/sub2aouter', 'Wei-Shaw/sub2api'))

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'frontend.repository'))
})

test('contract rejects an explicit contributor card in the shipped frontend template', async () => {
  const files = await loadContractFiles()
  const path = 'frontend/src/views/HomeView.vue'
  files.set(path, `${files.get(path)}\n<section><h2>Contributors</h2><span>KKBK-233</span></section>\n`)

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'template.contributors'))
})
test('contract rejects a return to calendar release versions', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/upstream-theme-sync.yml'
  files.set(
    path,
    files.get(path).replace(
      'node scripts/next-release-version.mjs "$PREVIOUS_RELEASE_VERSION"',
      'date -u +%Y.%m.%d',
    ),
  )

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.release_version'))
})

test('contract requires stable upstream release identity deduplication', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/upstream-theme-sync.yml'
  const workflow = files.get(path)
  files.set(path, workflow.replaceAll('UPSTREAM_RELEASE_ID', 'REMOVED_UPSTREAM_RELEASE_ID'))

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.upstream_release_identity'))
})

test('contract requires Canvas sync to dispatch the themed release workflow', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/infinite-canvas-upstream-sync.yml'
  files.set(path, files.get(path).replace('gh workflow run upstream-theme-sync.yml', 'echo downstream-release-disabled'))

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'canvas_sync.release_dispatch'))
})

test('contract requires the coordinated dispatch to fetch the current Sub2API release', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/infinite-canvas-upstream-sync.yml'
  files.set(path, files.get(path).replace('-f scheduled_round=true', '-f scheduled_round=false'))

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'canvas_sync.release_dispatch'))
})

test('contract requires scheduled recovery for repository and Canvas drift', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/upstream-theme-sync.yml'
  files.set(path, files.get(path).replaceAll('PREVIOUS_CANVAS_SHA', 'DISABLED_CANVAS_BASELINE'))

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.repository_recovery'))
})

test('contract rejects binary publication without repository and Canvas source guards', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/theme-binary-release.yml'
  files.set(path, files.get(path).replaceAll('MAIN_CANVAS_SHA', 'DISABLED_CANVAS_HEAD'))

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'binary.source_guard'))
})

test('contract blocks publication when main is behind the latest Canvas release', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/upstream-theme-sync.yml'
  files.set(path, files.get(path).replaceAll('LATEST_CANVAS_SHA', 'DISABLED_LATEST_CANVAS_HEAD'))

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.canvas_freshness'))
})

test('contract requires binary release recovery and post-publication verification', async () => {
  const files = await loadContractFiles()
  const syncPath = '.github/workflows/upstream-theme-sync.yml'
  const binaryPath = '.github/workflows/theme-binary-release.yml'
  files.set(syncPath, files.get(syncPath).replaceAll('NEEDS_BINARY_RELEASE', 'DISABLED_BINARY_RELEASE'))
  files.set(binaryPath, files.get(binaryPath).replace('Verify published GitHub release', 'disabled verification'))

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.binary_recovery'))
  assert.ok(violations.some((violation) => violation.code === 'binary.release_recovery'))
})

test('contract requires awaited binary publication and final latest promotion', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/upstream-theme-sync.yml'
  files.set(
    path,
    files.get(path)
      .replace('uses: ./.github/workflows/theme-binary-release.yml', 'uses: ./.github/workflows/disabled-binary-release.yml')
      .replace("needs.binary-release.result == 'success'", 'true'),
  )

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.binary_call'))
  assert.ok(violations.some((violation) => violation.code === 'sync.latest_promotion'))
})

test('contract binds push checkout and repository metadata to the same immutable head', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/upstream-theme-sync.yml'
  files.set(
    path,
    files.get(path)
      .replace("ref: ${{ github.event_name == 'push' && github.sha || 'main' }}", 'ref: main')
      .replace('RELEASE_SOURCE_SHA="$(git rev-parse HEAD)"', 'RELEASE_SOURCE_SHA="${{ github.sha }}"'),
  )

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.push_checkout'))
  assert.ok(violations.some((violation) => violation.code === 'sync.repository_source_sha'))
})

test('contract requires generated workflows to pass a final snapshot gate', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/upstream-theme-sync.yml'
  files.set(
    path,
    files.get(path)
      .replace('cmp "$GITHUB_WORKSPACE/.github/workflows/theme-binary-release.yml" .github/workflows/theme-binary-release.yml', 'true # disabled binary workflow comparison')
      .replace(`node scripts/verify-release-pipeline.mjs --root .
          git config user.name`, `true # disabled final contract
          git config user.name`),
  )

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.verified_workflow_snapshot'))
})

test('contract requires reusable CI to verify an immutable Canvas update ref', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/backend-ci.yml'
  const workflow = await readFile(path, 'utf8')
  files.set(path, workflow.replace('workflow_call:', 'disabled_workflow_call:'))

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'ci.reusable_ref'))
})

test('contract requires complete CI before merging a Canvas update', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/infinite-canvas-upstream-sync.yml'
  files.set(
    path,
    files.get(path).replace('uses: ./.github/workflows/backend-ci.yml', 'uses: ./.github/workflows/disabled-ci.yml'),
  )

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'canvas_sync.full_ci_gate'))
})

test('contract requires explicit repository selection for Canvas automation commands', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/infinite-canvas-upstream-sync.yml'
  files.set(path, files.get(path).replaceAll('--repo "$GITHUB_REPOSITORY"', '--repo "Wei-Shaw/sub2api"'))

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'canvas_sync.repository_selection'))
})


test('contract requires fail-closed release discovery and a private upstream release ref', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/upstream-theme-sync.yml'
  files.set(
    path,
    files.get(path)
      .replaceAll('UPSTREAM_RELEASE_ERROR_FILE', 'DISABLED_RELEASE_ERROR_FILE')
      .replaceAll('refs/apophis/upstream-release', 'refs/tags/${UPSTREAM_RELEASE_TAG}'),
  )

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.release_fail_closed'))
  assert.ok(violations.some((violation) => violation.code === 'sync.upstream_release_ref'))
})

test('contract requires monotonic upstream source and identity plus SHA deduplication', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/upstream-theme-sync.yml'
  files.set(
    path,
    files.get(path)
      .replace(
        'merge-base --is-ancestor "$PREVIOUS_UPSTREAM_SHA" "$UPSTREAM_SHA"',
        'merge-base --is-ancestor "$UPSTREAM_SHA" "$PREVIOUS_UPSTREAM_SHA"',
      )
      .replaceAll('UPSTREAM_IDENTITY_AND_SHA_MATCH', 'DISABLED_IDENTITY_AND_SHA_MATCH'),
  )

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.upstream_monotonic'))
  assert.ok(violations.some((violation) => violation.code === 'sync.upstream_release_identity'))
})

test('contract requires fail-closed Canvas discovery and tested-head merge binding', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/infinite-canvas-upstream-sync.yml'
  files.set(
    path,
    files.get(path)
      .replaceAll('INFINITE_CANVAS_RELEASE_ERROR_FILE', 'DISABLED_CANVAS_RELEASE_ERROR_FILE')
      .replaceAll('--match-head-commit "$UPDATE_SHA"', '--admin'),
  )

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'canvas_sync.release_fail_closed'))
  assert.ok(violations.some((violation) => violation.code === 'canvas_sync.merge_identity'))
})
