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
test('upstream sync verifies the release contract before fetching upstream', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const contract = workflow.indexOf('name: Verify release pipeline contract')
  const fetch = workflow.indexOf('name: Prepare release source')
  assert.match(workflow, /node scripts\/verify-release-pipeline\.mjs --root \./)
  assert.ok(contract >= 0, 'release contract step must exist')
  assert.ok(contract < fetch, 'release contract must run before fetching upstream')
})


test('main pushes reuse the existing themed release without fetching upstream', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  assert.match(workflow, /github\.event_name.*push/)
  assert.match(workflow, /git worktree add --detach "\$GENERATED_DIR" origin\/themed-release/)
  assert.match(workflow, /RELEASE_KIND="repository"/)
  assert.match(workflow, /Repository fixes/)
  assert.match(workflow, /\.apophis-release-notes\.md/)
  assert.match(workflow, /rm -rf \"\$GENERATED_DIR\/theme\" \"\$GENERATED_DIR\/scripts\"/)
})
