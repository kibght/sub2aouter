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

test('contract rejects binary publishing without a successful sync guard', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/theme-binary-release.yml'
  files.set(
    path,
    files.get(path).replace("github.event.workflow_run.conclusion == 'success'", 'true'),
  )

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'binary.success_guard'))
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
