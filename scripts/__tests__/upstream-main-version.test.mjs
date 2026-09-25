import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowPath = new URL('../../.github/workflows/upstream-theme-sync.yml', import.meta.url)

const workflow = await readFile(workflowPath, 'utf8')

test('scheduled sync builds the latest published upstream release tag', () => {
  assert.match(workflow, /steps\.upstream_release\.outputs\.tag/)
  assert.match(workflow, /refs\/tags\/\$\{UPSTREAM_RELEASE_TAG\}:\$\{UPSTREAM_RELEASE_REF\}/)
  assert.match(workflow, /git worktree add --detach \"\$GENERATED_DIR\" \"\$UPSTREAM_RELEASE_REF\"/)
  assert.doesNotMatch(workflow, /MAIN_UPSTREAM_VERSION/)
  assert.doesNotMatch(workflow, /FETCH_HEAD/)
})

test('scheduled sync validates the source VERSION inside a published release tag', () => {
  assert.match(workflow, /TAG_UPSTREAM_VERSION=.*git show "\$UPSTREAM_RELEASE_REF":backend\/cmd\/server\/VERSION/)
  assert.match(workflow, /RELEASE_VERSION_FROM_TAG=/)
  assert.match(workflow, /contains invalid VERSION/)
})

test('published upstream releases keep source VERSION metadata', () => {
  assert.match(workflow, /UPSTREAM_SOURCE_VERSION=.*git -C "\$GENERATED_DIR" show HEAD:backend\/cmd\/server\/VERSION/)
  assert.match(workflow, /echo "UPSTREAM_SOURCE_VERSION=\$UPSTREAM_SOURCE_VERSION"/)
  assert.match(workflow, /UPSTREAM_RELEASE_PUBLISHED/)
  assert.match(workflow, /No published Sub2API release was found; refusing to build a branch snapshot/)
})

test('repository releases initialize upstream release metadata before exporting it', () => {
  const repositorySourceBlock = workflow.match(
    /if \[\[ "\$REPOSITORY_RELEASE" == "true" \]\]; then([\s\S]*?)\n          else/
  )?.[1]

  assert.ok(repositorySourceBlock)
  assert.match(repositorySourceBlock, /UPSTREAM_RELEASE_PUBLISHED=false/)
  assert.match(repositorySourceBlock, /UPSTREAM_SOURCE_FROM_MAIN=false/)
})
