import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowPath = new URL('../../.github/workflows/upstream-theme-sync.yml', import.meta.url)

const workflow = await readFile(workflowPath, 'utf8')

test('all upstream syncs build the discovered latest published release tag', () => {
  assert.match(workflow, /steps\.upstream_release\.outputs\.tag/)
  assert.match(workflow, /refs\/tags\/\$\{UPSTREAM_RELEASE_TAG\}:\$\{UPSTREAM_RELEASE_REF\}/)
  assert.match(workflow, /git worktree add --detach \"\$GENERATED_DIR\" \"\$UPSTREAM_RELEASE_REF\"/)
  assert.match(workflow, /\[\[ \"\$DISCOVERED_UPSTREAM_RELEASE\" != \"true\" \]\]/)
  assert.doesNotMatch(workflow, /upstream_ref:|UPSTREAM_REF|FETCH_HEAD/)
  assert.doesNotMatch(workflow, /MAIN_UPSTREAM_VERSION/)
})

test('latest themed release validation accepts the v0.2 release line', () => {
  assert.match(workflow, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/)
  assert.doesNotMatch(workflow, /\^v0\\\.1\\\.\[0-9\]\+\$/)
})

test('upstream sync validates the source VERSION inside a published release tag', () => {
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
  assert.match(repositorySourceBlock, /RELEASE_KIND=\"repository\"/)
})

test('the next themed version increments from the latest published themed Release', () => {
  assert.match(workflow, /repos\/\$\{GITHUB_REPOSITORY\}\/releases\/latest/)
  assert.match(workflow, /LATEST_RELEASE_TAG=.*jq -r '\.tag_name \/\/ \"\"'/)
  assert.match(workflow, /LATEST_RELEASE_VERSION=\"\$\{LATEST_RELEASE_TAG#v\}\"/)
  assert.match(workflow, /node scripts\/next-release-version\.mjs \"\$LATEST_RELEASE_VERSION\"/)
})
