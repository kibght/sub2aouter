import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const pnpmVersion = '9.15.9'

test('frontend and Docker builds pin the same pnpm version', async () => {
  const packageJson = JSON.parse(await readFile('frontend/package.json', 'utf8'))
  const dockerfile = await readFile('Dockerfile', 'utf8')
  const deployDockerfile = await readFile('deploy/Dockerfile', 'utf8')

  assert.equal(packageJson.packageManager, `pnpm@${pnpmVersion}`)
  assert.match(dockerfile, new RegExp(`corepack prepare pnpm@${pnpmVersion.replaceAll('.', '\\.')}`))
  assert.match(deployDockerfile, new RegExp(`corepack prepare pnpm@${pnpmVersion.replaceAll('.', '\\.')}`))
})

test('GitHub workflows use the pinned pnpm version', async () => {
  const workflows = [
    '.github/workflows/backend-ci.yml',
    '.github/workflows/release.yml',
    '.github/workflows/security-scan.yml',
    '.github/workflows/upstream-theme-sync.yml',
  ]

  for (const workflow of workflows) {
    const source = await readFile(workflow, 'utf8')
    assert.match(source, new RegExp(`uses: pnpm/action-setup@[0-9a-f]{40} \# v6[\\s\\S]{0,80}version: ${pnpmVersion.replaceAll('.', '\\.')}`), workflow)
  }
})

test('theme overlay preserves package manager and Docker pins', async () => {
  const manifest = JSON.parse(await readFile('theme/apophis/manifest.json', 'utf8'))
  const packagePatch = manifest.patches.find((entry) => entry.target === 'frontend/package.json' && entry.sentinel?.includes(`pnpm@${pnpmVersion}`))
  const dockerPatch = manifest.patches.find((entry) => entry.target === 'Dockerfile' && entry.sentinel?.includes(`pnpm@${pnpmVersion}`))

  assert.ok(packagePatch)
  assert.ok(dockerPatch)
})

test('frontend security override pins the patched nanoid release across upstream syncs', async () => {
  const packageJson = JSON.parse(await readFile('frontend/package.json', 'utf8'))
  const lockfile = await readFile('frontend/pnpm-lock.yaml', 'utf8')
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const manifest = JSON.parse(await readFile('theme/apophis/manifest.json', 'utf8'))

  assert.equal(packageJson.pnpm?.overrides?.['nanoid@<3.3.17'], '3.3.17')
  assert.match(lockfile, /nanoid@3\.3\.17/)
  assert.doesNotMatch(lockfile, /nanoid@3\.3\.16/)
  assert.ok((manifest.patches || []).some((entry) =>
    entry.target === 'frontend/package.json' &&
    entry.source === 'patches/frontend-nanoid-override.txt' &&
    entry.sentinel === '      "nanoid@<3.3.17": "3.3.17",'
  ))
  const reconcile = workflow.indexOf('pnpm install --lockfile-only --no-frozen-lockfile')
  const contractCheck = workflow.indexOf('name: Verify theme overlay and UTF-8')
  const frozenInstall = workflow.indexOf('pnpm install --frozen-lockfile')
  assert.ok(reconcile >= 0 && reconcile < contractCheck)
  assert.ok(contractCheck < frozenInstall)
})
