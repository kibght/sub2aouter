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

test('active documentation matches the hourly coordinator and on-demand version check', async () => {
  const readmes = await Promise.all([
    read('README.md'),
    read('theme/apophis/files/README.md'),
  ])

  for (const readme of readmes) {
    assert.match(readme, /infinite-canvas-upstream-sync\.yml/)
    assert.match(readme, /\u6bcf\u5c0f\u65f6/)
    assert.doesNotMatch(readme, /\u6bcf 30 \u5206\u949f\u5b9a\u65f6\u89e6\u53d1/)
    assert.doesNotMatch(readme, /\u7248\u672c\u5361\u7247\u6bcf 30 \u5206\u949f\u68c0\u67e5/)
    assert.match(readme, /`0\.1\.x`/)
    assert.doesNotMatch(readme, /`2026\./)
  }
})
