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
    assert.match(source, new RegExp(`uses: pnpm/action-setup@v6[\\s\\S]{0,80}version: ${pnpmVersion.replaceAll('.', '\\.')}`), workflow)
  }
})

test('theme overlay preserves package manager and Docker pins', async () => {
  const manifest = JSON.parse(await readFile('theme/apophis/manifest.json', 'utf8'))
  const packagePatch = manifest.patches.find((entry) => entry.target === 'frontend/package.json' && entry.sentinel?.includes(`pnpm@${pnpmVersion}`))
  const dockerPatch = manifest.patches.find((entry) => entry.target === 'Dockerfile' && entry.sentinel?.includes(`pnpm@${pnpmVersion}`))

  assert.ok(packagePatch)
  assert.ok(dockerPatch)
})