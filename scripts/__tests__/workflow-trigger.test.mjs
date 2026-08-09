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
  const binaryJob = workflow.indexOf('\n  binary-release:\n')
  const latestJob = workflow.indexOf('\n  promote-latest:\n')
  const latestPush = workflow.indexOf('docker push "${IMAGE}:latest"', latestJob)
  assert.ok(tests >= 0 && tests < backend)
  assert.ok(backend < immutablePush)
  assert.ok(immutablePush < releaseBranch)
  assert.ok(releaseBranch < binaryJob)
  assert.ok(binaryJob < latestJob && latestJob < latestPush)
  assert.equal(workflow.slice(0, binaryJob).includes('docker push "${IMAGE}:latest"'), false)
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
  assert.match(workflow, /\u4ed3\u5e93\u4fee\u590d/)
  assert.match(workflow, /\.apophis-release-notes\.md/)
  assert.match(workflow, /rm -rf \"\$GENERATED_DIR\/theme\" \"\$GENERATED_DIR\/scripts\"/)
})

test('the coordinated upstream round avoids hourly load boundaries and retries transient fetch failures', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const coordinator = await readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8')
  assert.match(coordinator, /cron:\s*'7 \* \* \* \*'/)
  assert.doesNotMatch(coordinator, /cron:\s*'\*\/30 \* \* \* \*'/)
  assert.doesNotMatch(workflow, /schedule:/)
  assert.match(workflow, /SCHEDULED_ROUND/)
  assert.match(workflow, /fetch_upstream_with_retry\(\)/)
  assert.match(workflow, /git fetch --depth=1 upstream "\$UPSTREAM_REF"/)
})

test('scheduled upstream sync deduplicates by release identity before falling back to SHA', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  assert.match(workflow, /UPSTREAM_RELEASE_ID/)
  assert.match(workflow, /\.apophis-upstream-release-id/)
  assert.match(workflow, /PREVIOUS_UPSTREAM_RELEASE_ID/)
  assert.match(workflow, /PREVIOUS_UPSTREAM_RELEASE_TAG/)
  assert.match(workflow, /RELEASE_KIND.*upstream.*github\.event_name.*schedule/)
  assert.match(workflow, /PREVIOUS_UPSTREAM_RELEASE_ID.*UPSTREAM_RELEASE_ID/)
  assert.match(workflow, /PREVIOUS_UPSTREAM_RELEASE_TAG.*UPSTREAM_RELEASE_TAG/)
})
