import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Sub2 upstream releases carry and verify the Infinite Canvas integration', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  assert.match(workflow, /git rev-parse HEAD:integrations\/infinite-canvas/)
  assert.match(workflow, /apply-sub2-infinite-canvas-integration\.mjs --root "\$GENERATED_DIR"/)
  assert.match(workflow, /apply-sub2-infinite-canvas-integration\.mjs --root \. --check/)
  assert.match(workflow, /submodule update --init --depth=1/)
  assert.match(workflow, /cp \.github\/workflows\/infinite-canvas-upstream-sync\.yml/)
  assert.match(workflow, /apply-infinite-canvas-patches\.mjs --root \"\$GENERATED_DIR\/integrations\/infinite-canvas\"/)
})

test('Infinite Canvas upstream updates are gated by adapter checks and pull requests', async () => {
  const workflow = await readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8')
  assert.match(workflow, /schedule:/)
  assert.match(workflow, /apply-infinite-canvas-patches\.mjs/)
  assert.match(workflow, /bun run typecheck/)
  assert.match(workflow, /bun run build/)
  assert.match(workflow, /pushd integrations\/infinite-canvas\/web/)
  assert.match(workflow, /popd/)
  assert.doesNotMatch(workflow, /cd \.\.\/\.\./)
  assert.match(workflow, /gh pr create/)
  assert.match(workflow, /actions:\s*write/)
  assert.match(workflow, /gh pr merge --squash \"\$PR_NUMBER\"/)
  assert.match(workflow, /gh workflow run upstream-theme-sync\.yml/)
  assert.match(workflow, /repository_release=false/)
  assert.match(workflow, /scheduled_round=true/)
  assert.match(workflow, /steps\.upstream\.outputs\.changed != ''/)
  const patchScript = await readFile('scripts/apply-infinite-canvas-patches.mjs', 'utf8')
  const integrationScript = await readFile('scripts/apply-sub2-infinite-canvas-integration.mjs', 'utf8')
  assert.match(integrationScript, /reconcileInfiniteCanvasLocaleBlock/)
  assert.match(patchScript, /web\/src\/pages\/home\/index\.tsx/)
  assert.match(patchScript, /navigate\(\"\/image\"\)/)
})


test('both upstream workflows inspect published release metadata before syncing', async () => {
  const sub2Workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const canvasWorkflow = await readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8')

  assert.match(sub2Workflow, /repos\/Wei-Shaw\/sub2api\/releases\/latest/)
  assert.match(sub2Workflow, /UPSTREAM_RELEASE_TAG/)
  assert.match(canvasWorkflow, /CANVAS_REPOSITORY: basketikun\/infinite-canvas/)
  assert.match(canvasWorkflow, /repos\/\$\{CANVAS_REPOSITORY\}\/releases\/latest/)
  assert.match(canvasWorkflow, /INFINITE_CANVAS_RELEASE_TAG/)
})

test('repository and canvas drift are recovered before release publication', async () => {
  const syncWorkflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const binaryWorkflow = await readFile('.github/workflows/theme-binary-release.yml', 'utf8')

  assert.match(syncWorkflow, /repository_release:/)
  assert.match(syncWorkflow, /CURRENT_REPOSITORY_SHA/)
  assert.match(syncWorkflow, /PREVIOUS_CANVAS_SHA/)
  assert.match(syncWorkflow, /PREVIOUS_REPOSITORY_SHA.*PREVIOUS_CANVAS_SHA/)
  assert.match(syncWorkflow, /\.apophis-canvas-sha/)
  assert.match(syncWorkflow, /name: Verify Infinite Canvas dependency is current/)
  assert.match(syncWorkflow, /LATEST_CANVAS_SHA/)
  assert.match(binaryWorkflow, /name: Verify themed release matches main repository and canvas/)
  assert.match(binaryWorkflow, /RELEASE_REPOSITORY_SHA/)
  assert.match(binaryWorkflow, /MAIN_CANVAS_SHA/)
  assert.match(binaryWorkflow, /RELEASE_CANVAS_SHA/)
  assert.match(binaryWorkflow, /LATEST_CANVAS_SHA/)
})

test('the themed binary release verifies all requested platform artifacts before publishing', async () => {
  const workflow = await readFile('.github/workflows/theme-binary-release.yml', 'utf8')
  const goreleaser = await readFile('.goreleaser.theme.yaml', 'utf8')

  assert.match(goreleaser, /goos: \[linux, windows, darwin\]/)
  assert.match(goreleaser, /goarch: \[amd64, arm64\]/)
  assert.match(workflow, /name: Verify GoReleaser artifacts/)
  assert.match(workflow, /linux.*amd64/)
  assert.match(workflow, /windows.*amd64/)
  assert.match(workflow, /darwin.*arm64/)
  assert.match(workflow, /dist\/checksums\.txt/)
})


test('successful theme sync explicitly dispatches serialized binary publication', async () => {
  const [syncWorkflow, binaryWorkflow] = await Promise.all([
    readFile('.github/workflows/upstream-theme-sync.yml', 'utf8'),
    readFile('.github/workflows/theme-binary-release.yml', 'utf8'),
  ])

  assert.match(syncWorkflow, /name: Trigger themed binary publication/)
  assert.match(syncWorkflow, /gh workflow run theme-binary-release\.yml/)
  assert.match(syncWorkflow, /permissions:\n\s+actions:\s+write/)
  assert.match(binaryWorkflow, /workflow_dispatch:/)
  assert.match(binaryWorkflow, /group: themed-binary-release/)
  assert.match(binaryWorkflow, /github\.event_name == 'workflow_dispatch' \|\| github\.event\.workflow_run\.conclusion == 'success'/)
})


test('hourly sync recovers missing or incomplete binary releases without minting another version', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')

  assert.match(workflow, /NEEDS_BINARY_RELEASE/)
  assert.match(workflow, /gh release view "\$PREVIOUS_RELEASE_TAG"/)
  assert.match(workflow, /targetCommitish/)
  assert.match(workflow, /\.assets\[\]\.name/)
  assert.match(workflow, /sub2api_\$\{PREVIOUS_RELEASE_VERSION\}_linux_amd64\.tar\.gz/)
  assert.match(workflow, /env\.SHOULD_PUBLISH == 'true' \|\| env\.NEEDS_BINARY_RELEASE == 'true'/)
})

test('binary release repairs incomplete assets and verifies the published result', async () => {
  const workflow = await readFile('.github/workflows/theme-binary-release.yml', 'utf8')

  assert.match(workflow, /RELEASE_EXISTS/)
  assert.match(workflow, /gh release upload "\$RELEASE_TAG"[\s\S]*--clobber/)
  assert.match(workflow, /gh release edit "\$RELEASE_TAG"/)
  assert.match(workflow, /name: Verify published GitHub release/)
  assert.match(workflow, /Missing published release asset/)
  assert.match(workflow, /grep -Fqx/)
})

test('new upstream releases are not mistaken for binary-only repairs', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')

  const identityIndex = workflow.indexOf('UPSTREAM_ALREADY_SYNCHRONIZED=false')
  const repairIndex = workflow.indexOf('Upstream source is synchronized, but its binary release needs repair.')
  const nextVersionIndex = workflow.indexOf('node scripts/next-release-version.mjs')
  assert.ok(identityIndex >= 0)
  assert.ok(repairIndex > identityIndex)
  assert.ok(nextVersionIndex > repairIndex)
  assert.match(workflow, /\$UPSTREAM_ALREADY_SYNCHRONIZED" == "true"/)
})

test('the Canvas workflow is the single hourly upstream coordinator', async () => {
  const sub2Workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const canvasWorkflow = await readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8')

  assert.match(canvasWorkflow, /cron:\s*'7 \* \* \* \*'/)
  assert.doesNotMatch(sub2Workflow, /schedule:/)
  assert.match(canvasWorkflow, /steps\.upstream\.outputs\.changed != ''/)
  assert.match(canvasWorkflow, /gh workflow run upstream-theme-sync\.yml[\s\S]*repository_release=false/)
  assert.doesNotMatch(canvasWorkflow, /repository_release=true/)
  assert.match(sub2Workflow, /workflow_dispatch:/)
  assert.match(sub2Workflow, /github\.event_name != 'push' \|\| !contains\(github\.event\.head_commit\.message, 'Infinite Canvas'\)/)
})
