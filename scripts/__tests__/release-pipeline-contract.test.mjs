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

test('contract rejects a sync workflow that no longer polls upstream every 30 minutes', async () => {
  const files = await loadContractFiles()
  const path = '.github/workflows/upstream-theme-sync.yml'
  files.set(path, files.get(path).replace("cron: '7,37 * * * *'", "cron: '0 * * * *'"))

  const violations = await verifyReleasePipelineContract('.', { readText: readerFor(files) })
  assert.ok(violations.some((violation) => violation.code === 'sync.schedule'))
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
