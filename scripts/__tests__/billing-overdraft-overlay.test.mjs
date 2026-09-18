import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { applyBillingOverdraft, BILLING_OVERDRAFT_PATCHES, BILLING_OVERDRAFT_COPY_FILES } from '../apply-billing-overdraft.mjs'
import { applySourceHunks } from '../lib/source-overlay.mjs'

const sourceRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const normalize = (text) => text.replaceAll('\r\n', '\n')

async function fixture(t, legacyIndex = -1) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2-billing-overdraft-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const entry of BILLING_OVERDRAFT_PATCHES) {
    const current = normalize(await readFile(path.join(sourceRoot, entry.target), 'utf8'))
    const reverse = [...entry.hunks].reverse().map(({ before, after }) => ({ before: after, after: before }))
    let content = applySourceHunks(current, reverse, entry.target)
    if (legacyIndex >= 0 && entry.legacy.length) {
      content = applySourceHunks(content, entry.legacy[Math.min(legacyIndex, entry.legacy.length - 1)], entry.target)
    }
    const target = path.join(root, entry.target)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

test('billing cancellation overlay matches the maintained source', async () => {
  assert.deepEqual(await applyBillingOverdraft({ root: sourceRoot, sourceRoot, check: true }), { changed: false })
})

for (const [name, legacy] of [['fresh source after balance guard', -1], ['previous repository implementation', 0], ['previous generated release', 1]]) {
  test(`billing cancellation overlay upgrades ${name} and is idempotent`, async (t) => {
    const root = await fixture(t, legacy)
    await assert.rejects(applyBillingOverdraft({ root, sourceRoot, check: true }), /drift/)
    assert.equal((await applyBillingOverdraft({ root, sourceRoot })).changed, true)
    assert.equal((await applyBillingOverdraft({ root, sourceRoot, check: true })).changed, false)
    assert.equal((await applyBillingOverdraft({ root, sourceRoot })).changed, false)
    for (const entry of BILLING_OVERDRAFT_PATCHES) {
      assert.equal(normalize(await readFile(path.join(root, entry.target), 'utf8')), normalize(await readFile(path.join(sourceRoot, entry.target), 'utf8')), entry.target)
    }
    for (const relative of BILLING_OVERDRAFT_COPY_FILES) {
      assert.deepEqual(await readFile(path.join(root, relative)), await readFile(path.join(sourceRoot, relative)), relative)
    }
  })
}

test('upstream source drift fails before any patch is written', async (t) => {
  const root = await fixture(t)
  const entry = BILLING_OVERDRAFT_PATCHES.at(-1)
  const target = path.join(root, entry.target)
  const original = await readFile(target, 'utf8')
  await writeFile(target, original.replace(entry.hunks[0].before, '// incompatible upstream change\n'))
  const firstPath = path.join(root, BILLING_OVERDRAFT_PATCHES[0].target)
  const firstBefore = await readFile(firstPath)
  await assert.rejects(applyBillingOverdraft({ root, sourceRoot }), /drift/)
  assert.deepEqual(await readFile(firstPath), firstBefore)
})
