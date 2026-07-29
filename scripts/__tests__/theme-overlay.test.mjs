import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { applyTheme, checkTheme } from '../lib/theme-overlay.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-overlay-'))
  await mkdir(path.join(root, 'frontend/src/views'), { recursive: true })
  await mkdir(path.join(root, 'frontend/src/styles'), { recursive: true })
  await mkdir(path.join(overlay, 'files/frontend/src/views'), { recursive: true })
  await mkdir(path.join(overlay, 'patches'), { recursive: true })
  await writeFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'upstream-home\n')
  await writeFile(path.join(root, 'frontend/src/style.css'), '@tailwind base;\n')
  await writeFile(path.join(overlay, 'files/frontend/src/views/HomeView.vue'), 'themed-home\n')
  await writeFile(path.join(overlay, 'patches/style-import.txt'), "@import './styles/apophis-theme.css';\n\n")
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    files: [
      { source: 'files/frontend/src/views/HomeView.vue', target: 'frontend/src/views/HomeView.vue' },
    ],
    patches: [
      {
        target: 'frontend/src/style.css',
        marker: '@tailwind base;\n',
        position: 'before',
        source: 'patches/style-import.txt',
        sentinel: "@import './styles/apophis-theme.css';",
      },
    ],
  }))
  return { root, overlay }
}

test('applies file overlays and patches idempotently', async () => {
  const { root, overlay } = await fixture()

  const first = await applyTheme({ root, overlay })
  const second = await applyTheme({ root, overlay })

  assert.equal(await readFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'utf8'), 'themed-home\n')
  const stylesheet = await readFile(path.join(root, 'frontend/src/style.css'), 'utf8')
  assert.equal(stylesheet.match(/apophis-theme\.css/g)?.length, 1)
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)
})

test('check mode reports drift without mutating files', async () => {
  const { root, overlay } = await fixture()

  const result = await checkTheme({ root, overlay })

  assert.equal(result.ok, false)
  assert.deepEqual(result.drift.sort(), [
    'frontend/src/style.css',
    'frontend/src/views/HomeView.vue',
  ])
  assert.equal(await readFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'utf8'), 'upstream-home\n')
})