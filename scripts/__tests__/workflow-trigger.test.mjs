import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('upstream theme workflow runs when main is pushed', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  assert.match(workflow, /\non:\n(?:.|\n)*?  push:\n    branches:\n      - main\n/)
})