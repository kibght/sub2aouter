import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ensureReplace } from '../apply-sub2-infinite-canvas-integration.mjs'

test('ensureReplace rejects partial drift when the sentinel remains', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2-canvas-replacement-'))
  const file = path.join(root, 'router.ts')
  const marker = 'meta: { requiresAuth: false, title: "Batch" }'
  const replacement = 'meta: { requiresAuth: true, title: "Infinite Canvas" }'
  const sentinel = 'requiresAuth: true'

  await writeFile(file, `${marker}\n`)
  await ensureReplace(file, marker, replacement, sentinel, false)
  assert.equal(await readFile(file, 'utf8'), `${replacement}\n`)

  await writeFile(file, 'meta: { requiresAuth: true, title: "Broken" }\n')

  await assert.rejects(
    ensureReplace(file, marker, replacement, sentinel, true),
    /Infinite Canvas integration drift/,
  )
  await assert.rejects(
    ensureReplace(file, marker, replacement, sentinel, false),
    /Infinite Canvas integration drift/,
  )
})
