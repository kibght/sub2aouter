import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const composeFiles = [
  'deploy/docker-compose.yml',
  'deploy/docker-compose.local.yml',
  'deploy/docker-compose.standalone.yml',
]
const image = 'ghcr.io/kibght/sub2aouter:latest'
const expectedImageLine = 'image: ${SUB2API_IMAGE:-' + image + '}'

test('all Docker Compose deployment modes default to the themed GHCR image', async () => {
  for (const file of composeFiles) {
    const content = await readFile(file, 'utf8')
    assert.ok(content.includes(expectedImageLine), `${file} must use ${expectedImageLine}`)
    assert.doesNotMatch(content, /image: weishaw\/sub2api:latest/)
  }
})

test('the theme manifest persists Docker image replacements across upstream syncs', async () => {
  const manifest = JSON.parse(await readFile('theme/apophis/manifest.json', 'utf8'))
  const replacementTargets = manifest.patches
    .filter((patch) => patch.operation === 'replace' && patch.sentinel?.includes(image))
    .map((patch) => patch.target)
    .sort()

  assert.deepEqual(replacementTargets, [...composeFiles].sort())
})