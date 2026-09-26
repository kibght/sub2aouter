import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { scanTextFiles } from '../lib/encoding-check.mjs'

test('detects replacement characters and common mojibake while preserving valid Chinese', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'encoding-check-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await mkdir(path.join(root, 'node_modules/example'), { recursive: true })
  const validChinese = String.fromCodePoint(0x4e2d, 0x6587, 0x6b63, 0x5e38)
  const replacementCharacter = String.fromCodePoint(0xfffd)
  const mojibakeMarker = String.fromCodePoint(0x951f, 0x65a4, 0x62f7)
  await writeFile(path.join(root, 'src/good.ts'), `export const text = '${validChinese}'\n`)
  await writeFile(path.join(root, 'src/bad.ts'), `export const broken = '${replacementCharacter}${mojibakeMarker}'\n`)
  await writeFile(path.join(root, 'node_modules/example/ignored.ts'), `export const ignored = '${replacementCharacter}'\n`)

  const issues = await scanTextFiles(root)

  assert.equal(issues.length, 1)
  assert.equal(issues[0].file, 'src/bad.ts')
  assert.deepEqual(issues[0].markers.sort(), ['U+FFFD', mojibakeMarker].sort())
})

test('skips nested Git worktrees such as submodules', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'encoding-check-submodule-'))
  const submodule = path.join(root, 'integrations/infinite-canvas')
  await mkdir(submodule, { recursive: true })
  await writeFile(path.join(submodule, '.git'), 'gitdir: ../../.git/modules/integrations/infinite-canvas\n')
  await writeFile(
    path.join(submodule, 'intentional-corruption-fixture.ts'),
    `export const fixture = '${String.fromCodePoint(0xfffd)}'\n`
  )

  const issues = await scanTextFiles(root)

  assert.deepEqual(issues, [])
})
