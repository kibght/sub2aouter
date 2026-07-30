import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('upstream theme workflow runs when main is pushed', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  assert.match(workflow, /\non:\n(?:.|\n)*?  push:\n    branches:\n      - main\n/)
})

test('upstream theme workflow runs the full regression suite before publishing latest', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  assert.match(workflow, /pnpm run test:run/)
  assert.doesNotMatch(workflow, /pnpm exec vitest run \\/)
  const tests = workflow.indexOf('pnpm run test:run')
  const backend = workflow.indexOf('name: Backend unit tests')
  const immutablePush = workflow.indexOf('name: Push immutable themed image')
  const releaseBranch = workflow.indexOf('name: Update generated release branch')
  const latestPush = workflow.indexOf('name: Publish latest image after release branch succeeds')
  assert.ok(tests >= 0 && tests < backend)
  assert.ok(backend < immutablePush)
  assert.ok(immutablePush < releaseBranch)
  assert.ok(releaseBranch < latestPush)
})
