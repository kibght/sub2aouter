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
  assert.match(workflow, /gh pr create/)
  assert.match(workflow, /gh pr merge --auto --squash/)
  assert.match(workflow, /gh pr checks \"\$PR_NUMBER\" --watch/)
  assert.match(workflow, /gh pr merge --squash \"\$PR_NUMBER\"/)
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


test('the two upstream schedulers run hourly at distinct offsets', async () => {
  const sub2Workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const canvasWorkflow = await readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8')

  assert.match(sub2Workflow, /cron:\s*'7 \* \* \* \*'/)
  assert.match(canvasWorkflow, /cron:\s*'17 \* \* \* \*'/)
  assert.doesNotMatch(sub2Workflow, /cron:\s*'7,37 \* \* \* \*'/)
  assert.doesNotMatch(canvasWorkflow, /cron:\s*'17,47 \* \* \* \*'/)
})
