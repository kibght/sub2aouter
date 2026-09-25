import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('upstream theme workflow never publishes automatically on a main push', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  assert.match(workflow, /\non:\n  workflow_dispatch:/)
  assert.doesNotMatch(workflow, /\n  push:/)
})

test('upstream theme workflow runs the full regression suite before publishing latest', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  assert.match(workflow, /pnpm run test:run/)
  assert.doesNotMatch(workflow, /pnpm exec vitest run \\/)
  const tests = workflow.indexOf('pnpm run test:run')
  const backend = workflow.indexOf('name: Backend unit tests')
  const immutablePush = workflow.indexOf('name: Push immutable themed image')
  const releaseBranch = workflow.indexOf('name: Update generated release branch')
  const binaryPublication = workflow.indexOf('  binary-release:')
  const latestPromotion = workflow.indexOf('  promote-latest:')
  assert.ok(tests >= 0 && tests < backend)
  assert.ok(backend < immutablePush)
  assert.ok(immutablePush < releaseBranch)
  assert.ok(releaseBranch < binaryPublication)
  assert.ok(binaryPublication < latestPromotion)
})
test('upstream sync verifies the release contract before fetching upstream', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const contract = workflow.indexOf('name: Verify release pipeline contract')
  const fetch = workflow.indexOf('name: Prepare release source')
  assert.match(workflow, /node scripts\/verify-release-pipeline\.mjs --root \./)
  assert.ok(contract >= 0, 'release contract step must exist')
  assert.ok(contract < fetch, 'release contract must run before fetching upstream')
})


test('manual repository releases build the checked out main commit', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  assert.match(workflow, /REPOSITORY_RELEASE.*true/)
  assert.match(workflow, /git worktree add --detach "\$GENERATED_DIR" "\$\{\{ github\.sha \}\}"/)
  assert.match(workflow, /RELEASE_KIND="repository"/)
  assert.match(workflow, /\u4ed3\u5e93\u4fee\u590d/)
  assert.match(workflow, /\.apophis-release-notes\.md/)
  assert.match(workflow, /rm -rf \"\$GENERATED_DIR\/theme\" \"\$GENERATED_DIR\/scripts\"/)
})

test('generated release snapshots keep the current owned automation workflows', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const restore = workflow.indexOf('rm -rf "$GENERATED_DIR/.github/workflows"')
  const config = workflow.indexOf('git config user.name github-actions[bot]', restore)

  assert.ok(restore >= 0, 'release publication must restore non-owned workflow snapshots')
  assert.ok(config > restore, 'git commit must follow workflow restoration')
  const block = workflow.slice(restore, config)
  for (const name of [
    'upstream-theme-sync.yml',
    'infinite-canvas-upstream-sync.yml',
    'backend-ci.yml',
    'theme-binary-release.yml',
  ]) {
    assert.match(block, new RegExp(`PRESERVED_WORKFLOW_DIR.*${name}|${name}.*PRESERVED_WORKFLOW_DIR`, 's'))
  }
  assert.match(block, /cp "\$PRESERVED_WORKFLOW_DIR\/\$workflow" "\.github\/workflows\/\$workflow"/)
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

test('scheduled upstream sync builds the latest upstream ref instead of the last release tag', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const sourceStart = workflow.indexOf('git remote add upstream')
  const sourceEnd = workflow.indexOf('UPSTREAM_SHA="$(git -C "$GENERATED_DIR" rev-parse HEAD)"', sourceStart)
  const sourceBlock = workflow.slice(sourceStart, sourceEnd)

  assert.match(sourceBlock, /fetch_upstream_with_retry/)
  assert.match(sourceBlock, /git worktree add --detach "\$GENERATED_DIR" FETCH_HEAD/)
  assert.doesNotMatch(sourceBlock, /refs\/tags\/\$\{UPSTREAM_RELEASE_TAG\}/)
  assert.match(sourceBlock, /latest Sub2API upstream ref/)
})
