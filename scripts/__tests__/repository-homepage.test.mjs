import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')

test('repository homepage documents the themed distribution instead of upstream defaults', async () => {
  const readme = await read('README.md')
  assert.match(readme, /Sub2Aouter Apophis Theme/)
  assert.match(readme, /ghcr\.io\/kibght\/sub2aouter:latest/)
  assert.match(readme, /theme\/apophis/)
  assert.doesNotMatch(readme, /README_CN\.md.*README_JA\.md/)
})

test('custom repository homepage and preview survive upstream generation', async () => {
  const manifest = JSON.parse(await read('theme/apophis/manifest.json'))
  const targets = new Set((manifest.files || []).map((entry) => entry.target))
  assert.ok(targets.has('README.md'))
  assert.ok(targets.has('docs/images/theme-overview.png'))
  await access(new URL('docs/images/theme-overview.png', root))
  await access(new URL('theme/apophis/files/README.md', root))
  await access(new URL('theme/apophis/files/docs/images/theme-overview.png', root))
})

test('repository preview image is explicitly tracked despite upstream docs ignore rules', async () => {
  const [gitignore, manifestText] = await Promise.all([
    read('.gitignore'),
    read('theme/apophis/manifest.json'),
  ])
  const manifest = JSON.parse(manifestText)
  assert.match(gitignore, /!docs\/images\/theme-overview\.png/)
  assert.ok((manifest.patches || []).some((entry) =>
    entry.target === '.gitignore' && entry.sentinel === '!docs/images/theme-overview.png'
  ))
})
