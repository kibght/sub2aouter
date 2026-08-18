import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applyTheme } from '../lib/theme-overlay.mjs'

const APP_HEADER = 'frontend/src/components/layout/AppHeader.vue'

async function appHeaderFixture(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-app-header-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-app-header-overlay-'))
  await mkdir(path.join(root, 'frontend/src/components/layout'), { recursive: true })
  await mkdir(path.join(overlay, 'patches'), { recursive: true })
  await writeFile(path.join(root, APP_HEADER), source)

  const manifest = JSON.parse(await readFile('theme/apophis/manifest.json', 'utf8'))
  const rolePatch = manifest.patches.find((entry) =>
    entry.target === APP_HEADER && entry.source === 'patches/app-header-user-role.txt'
  )
  assert.ok(rolePatch, 'AppHeader role patch must exist')
  await writeFile(
    path.join(overlay, rolePatch.source),
    await readFile(path.join('theme/apophis', rolePatch.source), 'utf8'),
  )
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({ patches: [rolePatch] }))
  return { root, overlay }
}

test('localized upstream AppHeader role markup keeps translation while adding the theme hook', async () => {
  const { root, overlay } = await appHeaderFixture([
    '              <div class="text-xs text-gray-500 dark:text-dark-400">',
    "                {{ t('admin.users.roles.' + user.role) }}",
    '              </div>',
    '',
  ].join('\n'))

  const first = await applyTheme({ root, overlay })
  const second = await applyTheme({ root, overlay })
  const header = await readFile(path.join(root, APP_HEADER), 'utf8')

  assert.match(header, /class="app-header-user-role text-xs text-gray-500 dark:text-dark-400"/)
  assert.match(header, /\{\{ t\('admin\.users\.roles\.' \+ user\.role\) \}\}/)
  assert.doesNotMatch(header, /\{\{ user\.role \}\}/)
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)
})

test('legacy themed AppHeader role markup migrates to the localized role copy', async () => {
  const { root, overlay } = await appHeaderFixture([
    '              <div class="app-header-user-role text-xs capitalize text-gray-500 dark:text-dark-400">',
    '                {{ user.role }}',
    '              </div>',
    '',
  ].join('\n'))

  const first = await applyTheme({ root, overlay })
  const second = await applyTheme({ root, overlay })
  const header = await readFile(path.join(root, APP_HEADER), 'utf8')

  assert.match(header, /class="app-header-user-role text-xs text-gray-500 dark:text-dark-400"/)
  assert.match(header, /\{\{ t\('admin\.users\.roles\.' \+ user\.role\) \}\}/)
  assert.doesNotMatch(header, /capitalize/)
  assert.doesNotMatch(header, /\{\{ user\.role \}\}/)
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)
})

test('generated workflow snapshots use one shared helper before verification and final publication', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const helper = 'scripts/ci/restore-workflow-snapshots.sh'
  const copyIndex = workflow.indexOf('name: Copy permanent theme source')
  const firstRestoreIndex = workflow.indexOf(helper, copyIndex)
  const verifyIndex = workflow.indexOf('name: Verify theme overlay and UTF-8')
  const releaseBranchIndex = workflow.indexOf('name: Update generated release branch')
  const secondRestoreIndex = workflow.indexOf(helper, releaseBranchIndex)

  assert.ok(copyIndex >= 0, 'theme source copy step must exist')
  assert.ok(firstRestoreIndex > copyIndex, 'workflow restoration must follow the permanent source copy')
  assert.ok(verifyIndex > firstRestoreIndex, 'workflow restoration must run before generated source verification')
  assert.ok(releaseBranchIndex > verifyIndex, 'release branch update must follow verification')
  assert.ok(secondRestoreIndex > releaseBranchIndex, 'final publication must restore workflows through the same helper')
  assert.equal(workflow.split(helper).length - 1, 2)
})
