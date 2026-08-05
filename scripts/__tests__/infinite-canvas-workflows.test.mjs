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
