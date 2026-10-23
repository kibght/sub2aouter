import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const officialPermissionCommand =
  'RUN mkdir -p /app/data && chown -R sub2api:sub2api /app'
const unsafePermissionCommand =
  'RUN mkdir -p /app/data && chown sub2api:sub2api /app/data'
const patchPath = 'theme/apophis/patches/dockerfile-update-permissions.txt'

test('runtime Dockerfiles keep /app writable for the non-root web updater', async () => {
  for (const file of ['Dockerfile', 'Dockerfile.goreleaser']) {
    const content = await readFile(file, 'utf8')
    assert.ok(
      content.includes(officialPermissionCommand),
      `${file} must preserve the official /app ownership contract`,
    )
  }

  const dockerfile = await readFile('Dockerfile', 'utf8')
  assert.ok(
    !dockerfile.includes(unsafePermissionCommand),
    'Dockerfile must not limit ownership to /app/data',
  )
})

test('theme sync persists the official Docker updater permission contract', async () => {
  const manifest = JSON.parse(await readFile('theme/apophis/manifest.json', 'utf8'))
  const patchSource = patchPath.replace('theme/apophis/', '')
  const patch = manifest.patches.find(
    (entry) => entry.target === 'Dockerfile' && entry.source === patchSource,
  )

  assert.ok(patch, `theme manifest must register ${patchPath}`)
  assert.equal(patch.operation, 'replace')
  assert.equal(patch.marker, unsafePermissionCommand)
  assert.equal(patch.sentinel, officialPermissionCommand)
  assert.equal((await readFile(patchPath, 'utf8')).trim(), officialPermissionCommand)
})
