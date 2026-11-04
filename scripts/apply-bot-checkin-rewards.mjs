#!/usr/bin/env node

// Carry only the bot binding reward and check-in changes into a generated tree.
// The source branch is a single commit on top of the current themed main branch.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ALLOWED_PATHS = [
  'backend/cmd/server/wire_gen.go',
  'backend/internal/handler/admin/setting_handler.go',
  'backend/internal/handler/admin/setting_handler_update.go',
  'backend/internal/handler/admin/user_handler.go',
  'backend/internal/handler/bot_handler.go',
  'backend/internal/handler/bot_handler_test.go',
  'backend/internal/handler/dto/settings.go',
  'backend/internal/handler/dto/types.go',
  'backend/internal/handler/dto/mappers.go',
  'backend/internal/handler/dto/mappers_bot_rewards_test.go',
  'backend/internal/handler/wire.go',
  'backend/internal/repository/bot_binding_repo.go',
  'backend/internal/repository/bot_checkin_repo.go',
  'backend/internal/repository/wire.go',
  'backend/internal/server/routes/bot.go',
  'backend/internal/server/routes/bot_test.go',
  'backend/internal/service/bot_binding.go',
  'backend/internal/service/bot_checkin.go',
  'backend/internal/service/bot_checkin_test.go',
  'backend/internal/service/domain_constants.go',
  'backend/internal/service/setting_parse.go',
  'backend/internal/service/setting_service.go',
  'backend/internal/service/setting_update.go',
  'backend/internal/service/settings_view.go',
  'backend/internal/service/wire.go',
  'backend/migrations/250_bot_checkins.sql',
  'frontend/src/api/admin/settings.ts',
  'frontend/src/api/admin/users.ts',
  'frontend/src/components/admin/user/UserBalanceHistoryModal.vue',
  'frontend/src/i18n/locales/en/admin/overview.ts',
  'frontend/src/i18n/locales/en/admin/settings.ts',
  'frontend/src/i18n/locales/en/dashboard.ts',
  'frontend/src/i18n/locales/zh/admin/overview.ts',
  'frontend/src/i18n/locales/zh/admin/settings.ts',
  'frontend/src/i18n/locales/zh/dashboard.ts',
  'frontend/src/views/admin/SettingsView.vue',
  'frontend/src/views/admin/__tests__/SettingsView.spec.ts',
]

const MIGRATION_SOURCE = 'backend/migrations/250_bot_checkins.sql'
const PATCH_PATHS = ALLOWED_PATHS.filter((file) => file !== MIGRATION_SOURCE)
const argv = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const root = path.resolve(valueOf('--root', '.'))
const ref = valueOf('--ref', 'origin/feat/bot-checkin-rewards')
const checkOnly = argv.includes('--check')
const scriptPath = fileURLToPath(import.meta.url)

const git = (args, options = {}) => execFileSync('git', args, {
  cwd: root,
  encoding: options.encoding ?? 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  ...options,
})

function fail(message) {
  throw new Error('apply-bot-checkin-rewards: ' + message)
}

function isApplicable(args, patch) {
  try {
    git(args, { input: patch, stdio: ['pipe', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

function sourceChanges() {
  const changed = git(['diff', '--name-only', '-z', ref + '^', ref, '--']).split('\0').filter(Boolean)
  const unexpected = changed.filter((file) => !ALLOWED_PATHS.includes(file))
  if (unexpected.length > 0) {
    fail('source branch contains files outside the bot rewards allowlist: ' + unexpected.join(', '))
  }

  const missing = ALLOWED_PATHS.filter((file) => !changed.includes(file))
  if (missing.length > 0) {
    fail('source branch is missing expected bot rewards changes: ' + missing.join(', '))
  }
}

function sourceMigration() {
  try {
    return git(['show', ref + ':' + MIGRATION_SOURCE])
  } catch (error) {
    fail('cannot read bot check-in migration from ' + ref + ': ' + (error.stderr?.toString() || error.message))
  }
}

function targetMigrationPath(migrationText) {
  const directory = path.join(root, 'backend/migrations')
  if (existsSync(directory)) {
    for (const name of readdirSync(directory)) {
      if (!/^\d+_.*\.sql$/.test(name)) continue
      const file = path.join(directory, name)
      if (readFileSync(file, 'utf8') === migrationText) return 'backend/migrations/' + name
    }
  }

  const numbers = existsSync(directory)
    ? readdirSync(directory)
      .map((name) => /^(\d+)_.*\.sql$/.exec(name))
      .filter(Boolean)
      .map((match) => Number.parseInt(match[1], 10))
    : []
  const next = Math.max(0, ...numbers) + 1
  return 'backend/migrations/' + String(next).padStart(3, '0') + '_bot_checkins.sql'
}

function ensureTargetMigration(relativePath, migrationText, write) {
  const absolutePath = path.join(root, relativePath)
  if (existsSync(absolutePath)) {
    if (readFileSync(absolutePath, 'utf8') !== migrationText) {
      fail('migration path already exists with different content: ' + relativePath)
    }
    return
  }
  if (!write) fail('bot check-in migration is missing: ' + relativePath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, migrationText, 'utf8')
}

function verifyOverlayMarkers(migrationPath, migrationText) {
  const requiredMarkers = new Map([
    ['backend/internal/service/bot_checkin.go', ['type BotCheckInService', 'func (s *BotCheckInService) CheckIn(']],
    ['backend/internal/repository/bot_checkin_repo.go', ['type botCheckInRepository', 'func (r *botCheckInRepository) CheckIn(']],
    ['backend/internal/handler/bot_handler.go', ['SetCheckInService', 'func (h *BotHandler) CheckIn(']],
    ['backend/internal/server/routes/bot.go', ['CheckIn']],
    ['backend/cmd/server/wire_gen.go', ['botCheckInService :=']],
    ['backend/internal/handler/dto/mappers.go', ['BotCheckInRedeemType']],
    ['frontend/src/views/admin/SettingsView.vue', ['bot_checkin_enabled']],
  ])
  for (const [relativePath, markers] of requiredMarkers) {
    const absolutePath = path.join(root, relativePath)
    if (!existsSync(absolutePath)) fail('bot check-in overlay is missing: ' + relativePath)
    const text = readFileSync(absolutePath, 'utf8')
    for (const marker of markers) {
      if (!text.includes(marker)) fail('bot check-in overlay marker is missing in ' + relativePath + ': ' + marker)
    }
  }
  ensureTargetMigration(migrationPath, migrationText, false)
}

function main() {
  if (path.resolve(process.argv[1] || '') !== scriptPath) return

  let baseRef
  try {
    baseRef = git(['rev-parse', ref + '^']).trim()
  } catch (error) {
    fail('source branch must include its original themed main parent: ' + ref + ' (' + (error.stderr?.toString() || error.message) + ')')
  }

  sourceChanges()
  const patch = git(['diff', '--binary', baseRef, ref, '--', ...PATCH_PATHS], { encoding: 'buffer' })
  if (patch.length === 0) fail('source branch has no non-migration bot rewards patch')

  const migrationText = sourceMigration()
  const migrationPath = targetMigrationPath(migrationText)
  const reverseApplies = isApplicable(['apply', '--reverse', '--check', '--whitespace=nowarn'], patch)

  if (checkOnly) {
    if (!reverseApplies) verifyOverlayMarkers(migrationPath, migrationText)
    else ensureTargetMigration(migrationPath, migrationText, false)
    console.log('Verified bot check-in rewards overlay from ' + ref + ' (base ' + baseRef + ', migration ' + migrationPath + ').')
    return
  }

  if (!reverseApplies) {
    try {
      git(['add', '--all'])
      git(['apply', '--3way', '--whitespace=nowarn'], { input: patch })
    } catch (error) {
      const conflicts = git(['diff', '--name-only', '--diff-filter=U'])
        .split(/\r?\n/)
        .map((file) => file.trim())
        .filter(Boolean)
      const expected = new Set([
        'backend/cmd/server/wire_gen.go',
        'backend/internal/handler/bot_handler.go',
        'backend/internal/handler/wire.go',
        'backend/internal/repository/wire.go',
        'backend/internal/server/routes/bot.go',
        'backend/internal/server/routes/bot_test.go',
      ])
      if (conflicts.length === 0 || conflicts.some((file) => !expected.has(file))) {
        fail('cannot apply bot rewards patch' + (conflicts.length ? ' (conflicts: ' + conflicts.join(', ') + ')' : '') + ': ' + (error.stderr?.toString() || error.message))
      }

      // These generated and bot wiring files already contain the preceding
      // binding overlays. The rewards branch carries their complete merged
      // versions, so use those files for the known conflicts only.
      try {
        git(['checkout', '--theirs', '--', ...conflicts])
        git(['add', '--', ...conflicts])
      } catch (resolveError) {
        fail('cannot resolve bot rewards generated-file conflicts: ' + (resolveError.stderr?.toString() || resolveError.message))
      }
    }
  }

  ensureTargetMigration(migrationPath, migrationText, true)
  console.log((reverseApplies ? 'Preserved' : 'Applied') + ' bot check-in rewards overlay from ' + ref + ' (base ' + baseRef + ', migration ' + migrationPath + ').')
}

if (path.resolve(process.argv[1] || '') === scriptPath) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

export { ALLOWED_PATHS }
