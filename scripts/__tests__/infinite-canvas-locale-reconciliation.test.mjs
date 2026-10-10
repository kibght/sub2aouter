import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { reconcileInfiniteCanvasLocaleBlock } from '../apply-sub2-infinite-canvas-integration.mjs'

test('stale Infinite Canvas translations are replaced with the complete locale block', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'infinite-canvas-locale-'))
  const file = path.join(root, 'common.ts')
  const source = await readFile('frontend/src/i18n/locales/zh/common.ts', 'utf8')
  const start = source.indexOf('  infiniteCanvas: {')
  const end = source.indexOf('  // Auth', start)
  const expected = source.slice(start, end)

  try {
    await writeFile(
      file,
      `export default {
  infiniteCanvas: {
    title: 'stale',
  },

  // Auth
  auth: {},
}
`,
      'utf8',
    )

    await reconcileInfiniteCanvasLocaleBlock(file, expected, false)
    await reconcileInfiniteCanvasLocaleBlock(file, expected, true)

    const content = await readFile(file, 'utf8')
    assert.equal(content.includes(expected), true)
    assert.match(content, /connectCodex:/)
    assert.match(content, /codexHelpTitle:/)
    assert.match(content, /agentUnavailable:/)
    assert.match(content, /noTokenInUrl:/)
    assert.equal((content.match(/infiniteCanvas: {/g) || []).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
