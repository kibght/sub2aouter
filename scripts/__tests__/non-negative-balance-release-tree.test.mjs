import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)

test('release workflow carries the non-negative balance guard into generated source', async () => {
  const workflow = await readFile(new URL('.github/workflows/upstream-theme-sync.yml', root), 'utf8')
  assert.match(workflow, /name: Carry non-negative balance migration/)
  assert.match(workflow, /node scripts\/apply-non-negative-balance\.mjs --root \.\n/)
  assert.match(workflow, /node scripts\/apply-non-negative-balance\.mjs --root \. --check/)
  assert.match(workflow, /name: Apply billing overdraft settlement policy/)
  assert.match(workflow, /node scripts\/apply-billing-overdraft\.mjs --root \. --source/)
  assert.match(workflow, /node scripts\/apply-billing-overdraft\.mjs --root \. --source "\$GITHUB_WORKSPACE" --check/)
})

test('generated release contract rejects a source tree without the balance migration', async () => {
  const contract = await readFile(new URL('scripts/lib/release-pipeline-contract.mjs', root), 'utf8')
  assert.match(contract, /sync\.balance_guard/)
})

test('repository release can explicitly republish a deleted version', async () => {
  const workflow = await readFile(new URL('.github/workflows/upstream-theme-sync.yml', root), 'utf8')
  assert.match(workflow, /release_version:/)
  assert.match(workflow, /RELEASE_VERSION_OVERRIDE/)
  assert.match(workflow, /RELEASE_VERSION_OVERRIDE.*RELEASE_VERSION=/s)
})
