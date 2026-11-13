import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ALLOWED_PATHS, composeUsageSettingsText, replaceOrInsertBlock } from '../apply-bot-checkin-rewards.mjs'

const scriptPath = fileURLToPath(new URL('../apply-bot-checkin-rewards.mjs', import.meta.url))
const migrationPath = 'backend/migrations/250_bot_checkins.sql'
const migrationText = 'CREATE TABLE bot_checkins (id BIGINT PRIMARY KEY);\n'

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

async function createSourceTree({ extraSourceFile = false, followupAllowedChange = false, usageTests = false } = {}) {
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

  if (usageTests) {
    for (const relativePath of [
      'backend/internal/handler/admin/setting_handler_bot_checkin_usage_test.go',
      'backend/internal/repository/bot_checkin_repo_integration_test.go',
      'backend/internal/service/bot_checkin_usage_test.go',
      'backend/internal/service/setting_bot_checkin_usage_test.go',
    ]) {
      await writeFile(path.join(root, relativePath), 'package test\n')
    }
    git(root, ['add', '--all'])
    git(root, ['commit', '-qm', 'configurable usage regression tests'])
    git(root, ['branch', '-f', 'source', 'HEAD'])
  }

  if (followupAllowedChange) {
    await writeFile(path.join(root, 'backend/internal/service/bot_checkin.go'), 'follow-up feature content\n')
    git(root, ['add', 'backend/internal/service/bot_checkin.go'])
    git(root, ['commit', '-qm', 'follow-up check-in fix'])
    git(root, ['branch', '-f', 'source', 'HEAD'])
  }

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

test('uses the complete overlay commit as the base when the source branch has follow-up commits', async (t) => {
  const { root } = await createSourceTree({ followupAllowedChange: true })
  t.after(() => rm(root, { recursive: true, force: true }))

  const run = (...args) => execFileSync(process.execPath, [scriptPath, '--root', root, '--ref', 'source', ...args], { encoding: 'utf8' })

  run()
  assert.equal((await readFile(path.join(root, 'backend/internal/service/bot_checkin.go'), 'utf8')).replaceAll('\r\n', '\n'), 'follow-up feature content\n')
  assert.match(run('--check'), /base .*migration/)
})

test('composes the errors import required by machine-readable check-in errors', async () => {
  const script = await readFile(scriptPath, 'utf8')
  assert.match(script, /target\.includes\('infraerrors\.ToHTTP'\)/)
  assert.match(script, /infraerrors "github\.com\/Wei-Shaw\/sub2api\/internal\/pkg\/errors"/)
})

test('carries optional usage regression tests without changing the complete-overlay base', async (t) => {
  const { root } = await createSourceTree({ usageTests: true })
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync(process.execPath, [scriptPath, '--root', root, '--ref', 'source'], { encoding: 'utf8' })
  assert.equal((await readFile(path.join(root, 'backend/internal/service/bot_checkin_usage_test.go'), 'utf8')).replaceAll('\r\n', '\n'), 'package test\n')
})

test('merges usage settings into preserved admin GET and PUT files without removing upstream selectors', () => {
  const fields = ['UsageRequirement', 'RequiredTokens', 'RequiredAmount']
  const getPath = 'backend/internal/handler/admin/setting_handler.go'
  const getTarget = '\t\tNewUpstreamSelector: settings.NewUpstreamSelector,\n\t\tBotCheckInEnabled: settings.Enabled,\n'
  const getSource = fields.map((field) => `\t\tBotCheckIn${field}: settings.${field},\n`).join('') + '\t\tBotCheckInEnabled: settings.Enabled,\n'
  const mergedGet = composeUsageSettingsText(getPath, getTarget, getSource)
  assert.match(mergedGet, /NewUpstreamSelector: settings.NewUpstreamSelector/)
  for (const field of fields) assert.match(mergedGet, new RegExp(`BotCheckIn${field}: settings\\.${field}`))
  assert.equal(composeUsageSettingsText(getPath, mergedGet, getSource), mergedGet)

  const updatePath = 'backend/internal/handler/admin/setting_handler_update.go'
  const enabled = '\tBotCheckInEnabled *bool `json:"bot_checkin_enabled"`\n'
  const mergeStart = '\tbotCheckIn := previousSettings.BotCheckInSettings\n'
  const mergeEnd = '\tif req.BotCheckInEnabled != nil {\n\t\tbotCheckIn.Enabled = *req.BotCheckInEnabled\n\t}\n'
  const response = '\t\tBotCheckInEnabled: updatedSettings.Enabled,\n'
  const updateTarget = enabled + '\tNewUpstreamSelector bool\n' + mergeStart + mergeEnd + response
  const updateSource = fields.map((field) => `\tBotCheckIn${field} *string\n`).join('') + enabled + mergeStart +
    fields.map((field) => `\tif req.BotCheckIn${field} != nil {\n\t\tbotCheckIn.${field} = *req.BotCheckIn${field}\n\t}\n`).join('') + mergeEnd +
    fields.map((field) => `\t\tBotCheckIn${field}: updatedSettings.${field},\n`).join('') + response
  const mergedUpdate = composeUsageSettingsText(updatePath, updateTarget, updateSource)
  assert.match(mergedUpdate, /NewUpstreamSelector bool/)
  for (const field of fields) {
    assert.match(mergedUpdate, new RegExp(`botCheckIn\\.${field} = \\*req\\.BotCheckIn${field}`))
    assert.match(mergedUpdate, new RegExp(`BotCheckIn${field}: updatedSettings\\.${field}`))
  }
  assert.equal(composeUsageSettingsText(updatePath, mergedUpdate, updateSource), mergedUpdate)
})

test('restores usage persistence and default normalization in a preserved settings service', () => {
  const relativePath = 'backend/internal/service/setting_update.go'
  const target = '\tif err := validateBotCheckInSettings(settings.BotCheckInSettings); err != nil {\n\t}\n' +
    '\tupdates[SettingKeyNewUpstreamSelector] = settings.NewUpstreamSelector\n' +
    '\tupdates[SettingKeyBotCheckInEnabled] = enabled\n'
  const source = '\tsettings.BotCheckInSettings = defaultBotCheckInUsage(settings.BotCheckInSettings)\n' + target +
    ['UsageRequirement', 'RequiredTokens', 'RequiredAmount'].map((field) => `\tupdates[SettingKeyBotCheckIn${field}] = settings.${field}\n`).join('')
  const merged = composeUsageSettingsText(relativePath, target, source)
  assert.match(merged, /defaultBotCheckInUsage/)
  assert.match(merged, /SettingKeyNewUpstreamSelector/)
  for (const field of ['UsageRequirement', 'RequiredTokens', 'RequiredAmount']) {
    assert.match(merged, new RegExp(`updates\\[SettingKeyBotCheckIn${field}\\] = settings\\.${field}`))
  }
  assert.equal(composeUsageSettingsText(relativePath, merged, source), merged)
})

test('updates existing response and check-in blocks once when reapplying a newer source', () => {
  const source = 'type botCheckInResponse struct {\n\tTodayAmount float64\n}\n\ntype botProfileResponse struct {}\n' +
    '// CheckIn\nfunc (h *BotHandler) CheckIn() { newUsageFields() }\n\n// Unbind\nfunc (h *BotHandler) Unbind() {}\n'
  let target = 'type botCheckInResponse struct {\n\tTodayTokens int64\n}\n\ntype botProfileResponse struct {}\n' +
    '// CheckIn\nfunc (h *BotHandler) CheckIn() { oldUsageFields() }\n\n// Unbind\nfunc (h *BotHandler) Unbind() {}\n'
  const compose = (text) => {
    text = replaceOrInsertBlock(text, source, 'type botCheckInResponse struct {', 'type botProfileResponse', 'response')
    return replaceOrInsertBlock(text, source, '// CheckIn\n', '// Unbind', 'method')
  }
  target = compose(target)
  assert.match(target, /TodayAmount/)
  assert.match(target, /newUsageFields/)
  assert.doesNotMatch(target, /oldUsageFields/)
  assert.equal(target.match(/type botCheckInResponse/g).length, 1)
  assert.equal(target.match(/func \(h \*BotHandler\) CheckIn/g).length, 1)
  assert.equal(compose(target), target)
})
