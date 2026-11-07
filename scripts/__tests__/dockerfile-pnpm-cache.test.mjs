import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const expectedMount = 'id=sub2api-pnpm-store-v2,target=/root/.local/share/pnpm/store,sharing=locked,uid=0,gid=0,mode=0755'

test('Dockerfile uses an isolated writable pnpm cache mount', async () => {
  const dockerfile = await readFile('Dockerfile', 'utf8')
  assert.ok(dockerfile.includes(expectedMount))
  assert.doesNotMatch(dockerfile, /id=sub2api-pnpm-store,target=\/root\/\.local\/share\/pnpm\/store(?!,)/)
})

test('theme overlay persists the Dockerfile cache fix after upstream sync', async () => {
  const manifest = JSON.parse(await readFile('theme/apophis/manifest.json', 'utf8'))
  const patch = manifest.patches.find(
    (entry) => entry.target === 'Dockerfile' && entry.sentinel?.includes('sub2api-pnpm-store-v2'),
  )
  assert.ok(patch)
})