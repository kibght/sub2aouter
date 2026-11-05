import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ALLOWED_PATHS } from '../apply-bot-checkin-rewards.mjs'

const scriptPath = fileURLToPath(new URL('../apply-bot-checkin-rewards.mjs', import.meta.url))
const migrationPath = 'backend/migrations/250_bot_checkins.sql'
const migrationText = 'CREATE TABLE bot_checkins (id BIGINT PRIMARY KEY);\n'

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

async function createSourceTree({ extraSourceFile = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-checkin-sync-'))
  git(root, ['init', '-q'])
  git(root, ['config', 'user.name', 'Bot Check-in Test'])
  git(root, ['config', 'user.email', 'bot-checkin-test@example.invalid'])

  for (const relativePath of ALLOWED_PATHS) {
    if (relativePath === migrationPath) continue
    const absolutePath = path.join(root, relativePath)
    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, 'base content\n')
  }
  const existingMigration = path.join(root, 'backend/migrations/001_existing.sql')
  await mkdir(path.dirname(existingMigration), { recursive: true })
  await writeFile(existingMigration, 'SELECT 1;\n')
  git(root, ['add', '--all'])
  git(root, ['commit', '-qm', 'themed main base'])
  const base = git(root, ['rev-parse', 'HEAD'])

  for (const relativePath of ALLOWED_PATHS) {
    if (relativePath === migrationPath) continue
    await writeFile(path.join(root, relativePath), 'feature content\n')
  }
  const sourceMigration = path.join(root, migrationPath)
  await mkdir(path.dirname(sourceMigration), { recursive: true })
  await writeFile(sourceMigration, migrationText)
  git(root, ['add', '--all'])
  git(root, ['commit', '-qm', 'bot check-in rewards'])
  git(root, ['branch', 'source'])
  const sourceCommit = git(root, ['rev-parse', 'source'])

  if (extraSourceFile) {
    await writeFile(path.join(root, 'README.md'), 'unrelated\n')
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-qm', 'unrelated source change'])
    git(root, ['branch', '-f', 'source', 'HEAD'])
  }

  git(root, ['checkout', '--detach', base])
  return { root, sourceCommit }
}

test('applies only the bot rewards delta, allocates its migration, and is idempotent', async (t) => {
  const { root } = await createSourceTree()
  t.after(() => rm(root, { recursive: true, force: true }))

  const run = (...args) => execFileSync(process.execPath, [scriptPath, '--root', root, '--ref', 'source', ...args], { encoding: 'utf8' })

  run()
  assert.equal((await readFile(path.join(root, 'backend/internal/handler/bot_handler.go'), 'utf8')).replaceAll('\r\n', '\n'), 'feature content\n')
  assert.equal((await readFile(path.join(root, 'backend/migrations/002_bot_checkins.sql'), 'utf8')).replaceAll('\r\n', '\n'), migrationText)
  assert.match(run('--check'), /Verified bot check-in rewards overlay/)
  assert.match(run(), /Preserved bot check-in rewards overlay/)
})

test('rejects source commits that contain files outside the bot rewards allowlist', async (t) => {
  const { root } = await createSourceTree({ extraSourceFile: true })
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.throws(
    () => execFileSync(process.execPath, [scriptPath, '--root', root, '--ref', 'source'], { encoding: 'utf8', stdio: 'pipe' }),
    /outside the bot rewards allowlist/,
  )
})

test('composes the errors import required by machine-readable check-in errors', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.match(script, /target\.includes\('infraerrors\.ToHTTP'\)/)
  assert.match(script, /infraerrors "github\.com\/Wei-Shaw\/sub2api\/internal\/pkg\/errors"/)
})
