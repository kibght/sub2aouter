import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')
const workflowPaths = [
  '.github/workflows/release.yml',
  '.github/workflows/infinite-canvas-upstream-sync.yml',
  '.github/workflows/upstream-theme-sync.yml',
  '.github/workflows/theme-binary-release.yml',
  '.github/workflows/backend-ci.yml',
]

function externalActions(workflow) {
  return [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)\s*$/gm)]
    .map((match) => match[1])
    .filter((reference) => !reference.startsWith('./'))
}

function checkoutBlocks(workflow) {
  return workflow.match(/^\s*- (?:name:.*\n\s+)?uses:\s*actions\/checkout@[^\n]+(?:\n(?!\s*- (?:name:|uses:|run:))[^\n]*)*/gm) || []
}

function topLevelPermissions(workflow) {
  const jobsIndex = workflow.indexOf('\njobs:')
  return jobsIndex >= 0 ? workflow.slice(0, jobsIndex) : workflow
}

test('release workflows pin external actions and disable persisted checkout credentials', async () => {
  for (const path of workflowPaths) {
    const workflow = await read(path)
    for (const reference of externalActions(workflow)) {
      assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/, `${path}: ${reference} must use a full commit SHA`)
    }
    for (const block of checkoutBlocks(workflow)) {
      assert.match(block, /persist-credentials:\s*false/, `${path}: checkout must not persist credentials`)
    }
  }
})

test('release workflows isolate write permissions from untrusted build execution', async () => {
  const release = await read('.github/workflows/release.yml')
  const canvas = await read('.github/workflows/infinite-canvas-upstream-sync.yml')
  const sync = await read('.github/workflows/upstream-theme-sync.yml')
  const binary = await read('.github/workflows/theme-binary-release.yml')
  const ci = await read('.github/workflows/backend-ci.yml')

  for (const [path, workflow] of [
    ['.github/workflows/release.yml', release],
    ['.github/workflows/infinite-canvas-upstream-sync.yml', canvas],
    ['.github/workflows/upstream-theme-sync.yml', sync],
    ['.github/workflows/theme-binary-release.yml', binary],
    ['.github/workflows/backend-ci.yml', ci],
  ]) {
    assert.doesNotMatch(topLevelPermissions(workflow), /\b(?:actions|contents|packages|pull-requests):\s*write\b/, `${path}: top-level write permission is forbidden`)
  }

  assert.match(release, /^  build-release:\n[\s\S]*?permissions:\n\s+contents:\s+read/m)
  assert.match(release, /^  publish-release:\n[\s\S]*?permissions:\n\s+contents:\s+write\n\s+packages:\s+write/m)
  assert.match(release, /^  sync-version-file:\n[\s\S]*?permissions:\n\s+contents:\s+write/m)
  assert.match(canvas, /^  discover:\n[\s\S]*?permissions:\n\s+contents:\s+read/m)
  assert.match(canvas, /^  validate-update:\n[\s\S]*?permissions:\n\s+contents:\s+read/m)
  assert.match(canvas, /^  publish-update:\n[\s\S]*?permissions:\n\s+contents:\s+write\n\s+pull-requests:\s+write/m)
  assert.match(sync, /^  discover:\n[\s\S]*?permissions:\n\s+contents:\s+read/m)
  assert.match(sync, /^  build-release:\n[\s\S]*?permissions:\n\s+contents:\s+read/m)
  assert.match(sync, /^  publish-release:\n[\s\S]*?permissions:\n\s+contents:\s+write\n\s+packages:\s+write/m)
  assert.match(binary, /^  build-artifacts:\n[\s\S]*?permissions:\n\s+contents:\s+read/m)
  assert.match(binary, /^  publish-release:\n[\s\S]*?permissions:\n\s+contents:\s+write/m)

  const releasePublish = release.slice(release.indexOf('\n  publish-release:'), release.indexOf('\n  sync-version-file:'))
  const canvasPublish = canvas.slice(canvas.indexOf('\n  publish-update:'), canvas.indexOf('\n  full-ci:'))
  const syncPublish = sync.slice(sync.indexOf('\n  publish-release:'), sync.indexOf('\n  binary-release:'))
  const binaryPublish = binary.slice(binary.indexOf('\n  publish-release:'))
  for (const [name, job] of [
    ['legacy release publish', releasePublish],
    ['Canvas publish', canvasPublish],
    ['theme publish', syncPublish],
    ['binary publish', binaryPublish],
  ]) {
    assert.doesNotMatch(job, /\b(?:pnpm|bun)\s+install\b|\bgo\s+test\b|\bdocker\s+build\b|goreleaser\s+release\b/, `${name} must not execute untrusted build steps`)
  }
})

test('release publication verifies checksum manifests before consuming build artifacts', async () => {
  const sync = await read('.github/workflows/upstream-theme-sync.yml')
  const binary = await read('.github/workflows/theme-binary-release.yml')
  assert.match(sync, /sha256sum --check release-artifacts\.sha256/)
  assert.match(sync, /prepared-release\.bundle/)
  assert.match(sync, /name: Create immutable verified release bundle/)
  assert.match(sync, /verified-release\.bundle/)
  assert.ok(sync.indexOf('name: Reconcile frontend security overrides') < sync.indexOf('name: Create immutable verified release bundle'))
  const buildJob = sync.slice(sync.indexOf('\n  build-release:'), sync.indexOf('\n  publish-release:'))
  const publishJob = sync.slice(sync.indexOf('\n  publish-release:'), sync.indexOf('\n  binary-release:'))
  assert.doesNotMatch(buildJob, /needs\.build-release/)
  assert.ok(buildJob.indexOf('name: Reconcile frontend security overrides') < buildJob.indexOf('name: Seal reconciled build input'))
  assert.ok(buildJob.indexOf('name: Seal reconciled build input') < buildJob.indexOf('name: Install frontend dependencies'))
  assert.match(buildJob, /git diff --exit-code/)
  assert.match(buildJob, /git ls-files --others --exclude-standard/)
  assert.match(buildJob, /\[\[ "\$VERIFIED_TREE" == "\$BUILD_INPUT_TREE" \]\]/)
  assert.doesNotMatch(buildJob.slice(buildJob.indexOf('name: Install frontend dependencies')), /git add --all/)
  assert.match(publishJob, /VERIFIED_COMMIT: \$\{\{ needs\.build-release\.outputs\.verified_commit \}\}/)
  assert.match(sync, /git -C "\$GITHUB_WORKSPACE" bundle verify "\$RUNNER_TEMP\/release-artifacts\/verified-release\.bundle"/)
  assert.match(sync, /git -C "\$GITHUB_WORKSPACE" fetch "\$RUNNER_TEMP\/release-artifacts\/verified-release\.bundle"/)
  assert.match(sync, /node "\$GITHUB_WORKSPACE\/scripts\/apply-theme\.mjs" --root "\$GENERATED_DIR" --check/)
  assert.match(sync, /themed-image\.tar/)
  assert.match(binary, /sha256sum --check binary-artifacts\.sha256/)
  assert.match(binary, /release-assets\.tar\.gz/)
})
