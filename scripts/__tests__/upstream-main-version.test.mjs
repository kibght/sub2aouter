import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowPath = new URL('../../.github/workflows/upstream-theme-sync.yml', import.meta.url)

const workflow = await readFile(workflowPath, 'utf8')

test('scheduled sync prefers a newer upstream main version over a stale formal release', () => {
  assert.match(workflow, /MAIN_UPSTREAM_VERSION=/)
  assert.match(workflow, /git show FETCH_HEAD:backend\/cmd\/server\/VERSION/)
  assert.match(workflow, /sort -V/)
  assert.match(workflow, /Using newer unreleased upstream main version/)
  assert.match(workflow, /UPSTREAM_RELEASE_TAG=\"v\$\{MAIN_UPSTREAM_VERSION\}\"/)
  assert.match(workflow, /UPSTREAM_SOURCE_FROM_MAIN=true/)
  assert.match(workflow, /UPSTREAM_RELEASE_PUBLISHED=false/)
})

test('unreleased upstream snapshots use the source VERSION in release metadata', () => {
  assert.match(workflow, /upstream_version=.*backend\/cmd\/server\/VERSION/)
  assert.match(workflow, /v\$\{upstream_version\}/)
  assert.match(workflow, /Sub2API v\$\{upstream_version\}/)
  assert.match(workflow, /No published upstream release metadata/)
})
