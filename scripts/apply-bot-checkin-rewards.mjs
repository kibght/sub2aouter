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
  'backend/internal/repository/bot_checkin_repo_test.go',
  'backend/internal/server/api_contract_test.go',
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
  'frontend/src/views/user/RedeemView.vue',
  'frontend/src/views/user/__tests__/RedeemView.spec.ts',
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
const COMPOSED_PATHS = new Set([
  'backend/cmd/server/wire_gen.go',
  'backend/internal/handler/admin/setting_handler.go',
  'backend/internal/handler/admin/setting_handler_update.go',
  'backend/internal/handler/bot_handler.go',
  'backend/internal/handler/wire.go',
  'backend/internal/repository/wire.go',
  'backend/internal/server/routes/bot.go',
  'backend/internal/server/routes/bot_test.go',
  'backend/internal/service/setting_update.go',
])
// These files already contain the check-in settings in the generated tree.
// Keep newer selector fixes from that tree when the source overlay is based
// on an older bot-rewards commit and Git reports a textual conflict.
const PRESERVE_TARGET_PATHS = new Set([
  'backend/internal/handler/admin/setting_handler.go',
  'backend/internal/handler/admin/setting_handler_update.go',
  'backend/internal/service/setting_update.go',
])
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

function sourceFile(refName, relativePath) {
  try {
    return git(['show', refName + ':' + relativePath])
  } catch (error) {
    fail('cannot read ' + relativePath + ' from ' + refName + ': ' + (error.stderr?.toString() || error.message))
  }
}

function readTarget(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8').replaceAll('\r\n', '\n')
}

function writeTarget(relativePath, text) {
  writeFileSync(path.join(root, relativePath), text, 'utf8')
}

function targetHeadFile(relativePath) {
  try {
    return git(['show', 'HEAD:' + relativePath])
  } catch (error) {
    fail('cannot restore generated target ' + relativePath + ': ' + (error.stderr?.toString() || error.message))
  }
}

function insertOnce(text, marker, addition, label) {
  if (text.includes(addition.trim())) return text
  const index = text.indexOf(marker)
  if (index < 0) fail('cannot compose ' + label + ': anchor not found')
  return text.slice(0, index) + addition + text.slice(index)
}

function insertBeforeRegex(text, pattern, addition, label) {
  if (text.includes(addition.trim())) return text
  const match = pattern.exec(text)
  if (!match) fail('cannot compose ' + label + ': anchor not found')
  return text.slice(0, match.index) + addition + text.slice(match.index)
}

function extractBlock(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker)
  if (start < 0) fail('cannot compose source block: ' + startMarker)
  const end = text.indexOf(endMarker, start)
  if (end < 0) fail('cannot compose source block end: ' + endMarker)
  return text.slice(start, end)
}

function composeBotHandler(source) {
  const relativePath = 'backend/internal/handler/bot_handler.go'
  if (!source.includes('type botCheckInReader interface {')) return
  let target = readTarget(relativePath)
  const checkInInterface = extractBlock(source, 'type botCheckInReader interface {', 'type botUsageReader interface')
  target = insertBeforeRegex(target, /type botUsageReader interface\s*\{/m, '\n' + checkInInterface + '\n', relativePath)

  if (!/\tcheckIn\s+botCheckInReader\b/.test(target)) {
    const field = target.includes('balanceNotifyQQRepo service.BalanceNotifyQQRepository')
      ? '\tcheckIn             botCheckInReader\n'
      : '\tcheckIn  botCheckInReader\n'
    const bindingField = target.match(/\tbindings[^\n]*\n/)
    if (!bindingField) fail('cannot compose ' + relativePath + ': handler fields missing')
    target = target.replace(bindingField[0], bindingField[0] + field)
  }
  const setter = extractBlock(source, 'func (h *BotHandler) SetCheckInService', '// NewBotHandler')
  target = insertOnce(target, '\n\n// NewBotHandler', '\n' + setter + '\n', relativePath)

  const responseFields = '\tBindBonusGranted bool                `json:"bind_bonus_granted"`\n' +
    '\tBindBonusAmount  float64             `json:"bind_bonus_amount"`\n'
  if (!target.includes('BindBonusGranted')) {
    target = insertBeforeRegex(target, /\tUser\s+botBindingClaimUser/m, responseFields, relativePath)
  }
  const checkInResponse = extractBlock(source, 'type botCheckInResponse struct {', 'type botProfileResponse')
  target = insertOnce(target, '\ntype botProfileResponse', '\n' + checkInResponse + '\n', relativePath)
  const checkInMethod = extractBlock(source, '// CheckIn 领取机器人每日签到余额。', '// Unbind')
  target = insertOnce(target, '// Unbind', checkInMethod + '\n', relativePath)

  if (target.includes('infraerrors.ToHTTP') && !target.includes('internal/pkg/errors')) {
    target = target.replace(
      '\t"context"\n',
      '\t"context"\n\tinfraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"\n',
    )
  }

  if (!target.includes('BindBonusGranted: claim.BindBonusGranted')) {
    const old = '\t\tBoundAt:     claim.BoundAt.UTC(),\n\t\tUser:        claimUser,\n'
    const replacement = '\t\tBoundAt:        claim.BoundAt.UTC(),\n\t\tBindBonusGranted: claim.BindBonusGranted,\n\t\tBindBonusAmount: claim.BindBonusAmount,\n\t\tUser:             claimUser,\n'
    if (target.includes(old)) target = target.replace(old, replacement)
  }
  writeTarget(relativePath, target)
}

function composeQQBotHandler(source) {
  const relativePath = 'backend/internal/handler/bot_handler.go'
  if (!source.includes('func (h *BotHandler) SetBalanceNotifyQQRepository')) return
  if (!existsSync(path.join(root, relativePath))) return
  let target = readTarget(relativePath)
  if (!target.includes('balanceNotifyQQRepo service.BalanceNotifyQQRepository')) {
    const field = '\tbalanceNotifyQQRepo service.BalanceNotifyQQRepository\n'
    const anchor = target.match(/\tbindings[^\n]*\n/)
    if (!anchor) fail('cannot compose QQ handler: fields missing')
    target = target.replace(anchor[0], anchor[0] + field)
  }
  const setter = extractBlock(source, 'func (h *BotHandler) SetBalanceNotifyQQRepository', '// NewBotHandler')
  target = insertOnce(target, '\n\n// NewBotHandler', '\n' + setter + '\n', relativePath)
  const balanceMethods = extractBlock(source, '// BalanceLowAlerts claims queued QQ balance alerts', '// Profile')
  target = insertOnce(target, '// Profile', balanceMethods + '\n', relativePath)
  writeTarget(relativePath, target)
}

function composeHandlerWire() {
  const relativePath = 'backend/internal/handler/wire.go'
  let target = readTarget(relativePath)
  if (!target.includes('\tcheckIn *service.BotCheckInService,')) {
    target = target.replace(
      'func ProvideBotHandler(\n\tbindings *service.BotBindingService,\n',
      'func ProvideBotHandler(\n\tbindings *service.BotBindingService,\n\tcheckIn *service.BotCheckInService,\n',
    )
  }
  if (!target.includes('h.SetCheckInService(checkIn)')) {
    target = target.replace('\th := NewBotHandler(bindings, usage, apiKeys, users)\n', '\th := NewBotHandler(bindings, usage, apiKeys, users)\n\th.SetCheckInService(checkIn)\n')
  }
  if (!target.includes('qqBalanceNotifyRepo service.BalanceNotifyQQRepository')) {
    target = target.replace('\tusers *service.UserService,\n', '\tusers *service.UserService,\n\tqqBalanceNotifyRepo service.BalanceNotifyQQRepository,\n')
  }
  if (!target.includes('h.SetBalanceNotifyQQRepository(qqBalanceNotifyRepo)')) {
    target = target.replace('\th.SetCheckInService(checkIn)\n', '\th.SetCheckInService(checkIn)\n\th.SetBalanceNotifyQQRepository(qqBalanceNotifyRepo)\n')
  }
  writeTarget(relativePath, target)
}

function composeRepositoryWire() {
  const relativePath = 'backend/internal/repository/wire.go'
  let target = readTarget(relativePath)
  if (!target.includes('NewBotCheckInRepository')) {
    target = target.replace('\tNewBotBindingRepository,\n', '\tNewBotBindingRepository,\n\tNewBotCheckInRepository,\n')
  }
  if (!target.includes('NewBalanceNotifyQQRepository')) {
    target = target.replace('\tNewBotBindingRepository,\n', '\tNewBotBindingRepository,\n\tNewBalanceNotifyQQRepository,\n')
  }
  writeTarget(relativePath, target)
}

function composeRoutes() {
  const relativePath = 'backend/internal/server/routes/bot.go'
  let target = readTarget(relativePath)
  if (!target.includes('bot.POST("/check-in"')) {
    target = target.replace('\t\tbot.POST("/unbind", h.Bot.Unbind)\n', '\t\tbot.POST("/unbind", h.Bot.Unbind)\n\t\tbot.POST("/check-in", h.Bot.CheckIn)\n')
  }
  if (!target.includes('\tadminAuth middleware.AdminAuthMiddleware,')) {
    target = target.replace('h *handler.Handlers,\n\tbotAuth middleware.BotAuthMiddleware,', 'h *handler.Handlers,\n\tadminAuth middleware.AdminAuthMiddleware,\n\tbotAuth middleware.BotAuthMiddleware,')
  }
  if (!target.includes('gin.HandlerFunc(adminAuth)')) {
    target = target.replace('panelRateLimiter.PublicIP(), h.Bot.Redeem)', 'gin.HandlerFunc(adminAuth), panelRateLimiter.PublicIP(), h.Bot.Redeem)')
  }
  if (!target.includes('bot.Use(gin.HandlerFunc(adminAuth))')) {
    target = target.replace('\tbot := v1.Group("/bot")\n', '\tbot := v1.Group("/bot")\n\tbot.Use(gin.HandlerFunc(adminAuth))\n')
  }
  if (!target.includes('balance-alerts')) {
    target = target.replace('\t\tbot.POST("/unbind", h.Bot.Unbind)\n', '\t\tbot.POST("/unbind", h.Bot.Unbind)\n\t\tbot.GET("/balance-alerts", h.Bot.BalanceLowAlerts)\n\t\tbot.POST("/balance-alerts/:id/ack", h.Bot.AckBalanceLowAlert)\n')
  }
  writeTarget(relativePath, target)

  const testPath = 'backend/internal/server/routes/bot_test.go'
  if (!existsSync(path.join(root, testPath))) return
  let test = readTarget(testPath)
  if (!test.includes('middleware.AdminAuthMiddleware')) {
    test = test.replace(
      '\t\t&handler.Handlers{Bot: handler.NewBotHandler(nil, nil, nil, nil)},\n\t\tmiddleware.BotAuthMiddleware',
      '\t\t&handler.Handlers{Bot: handler.NewBotHandler(nil, nil, nil, nil)},\n\t\tmiddleware.AdminAuthMiddleware(func(c *gin.Context) { c.Next() }),\n\t\tmiddleware.BotAuthMiddleware',
    )
    test = test.replace(
      '\t\t&handler.Handlers{},\n\t\tmiddleware.BotAuthMiddleware',
      '\t\t&handler.Handlers{},\n\t\tmiddleware.AdminAuthMiddleware(func(c *gin.Context) { c.Next() }),\n\t\tmiddleware.BotAuthMiddleware',
    )
  }
  if (!test.includes('/api/v1/bot/check-in')) {
    test = test.replace('\thttp.MethodPost + " /api/v1/bot/unbind",\n', '\thttp.MethodPost + " /api/v1/bot/unbind",\n\t\thttp.MethodPost + " /api/v1/bot/check-in",\n')
  }
  writeTarget(testPath, test)
}

function composeWireGen() {
  const relativePath = 'backend/cmd/server/wire_gen.go'
  let target = readTarget(relativePath)
  if (!target.includes('botCheckInService :=')) {
    const anchor = '\tbotBindingService := service.NewBotBindingService(botBindingRepository)\n'
    const addition = '\tbotBindingService.SetBillingCache(billingCacheService)\n' +
      '\tbotCheckInRepository := repository.NewBotCheckInRepository(db)\n' +
      '\tbotCheckInService := service.NewBotCheckInService(botCheckInRepository, settingService, billingCacheService, apiKeyAuthCacheInvalidator)\n'
    target = target.replace(anchor, anchor + addition)
  }
  target = target.replace(
    'handler.ProvideBotHandler(botBindingService, usageService,',
    'handler.ProvideBotHandler(botBindingService, botCheckInService, usageService,',
  )
  if (!target.includes('balanceNotifyQQRepository := repository.NewBalanceNotifyQQRepository(db)')) {
    target = target.replace('\tauthService := service.ProvideAuthService', '\tbalanceNotifyQQRepository := repository.NewBalanceNotifyQQRepository(db)\n\tauthService := service.ProvideAuthService')
  }
  target = target.replace(
    'userService := service.NewUserService(userRepository, settingRepository, apiKeyAuthCacheInvalidator, billingCache)',
    'userService := service.ProvideUserService(userRepository, settingRepository, apiKeyAuthCacheInvalidator, billingCache, balanceNotifyQQRepository)',
  )
  target = target.replace(
    'service.ProvideBalanceNotifyService(emailService, settingRepository, accountRepository, notificationEmailService)',
    'service.ProvideBalanceNotifyService(emailService, settingRepository, accountRepository, notificationEmailService, balanceNotifyQQRepository)',
  )
  target = target.replace(
    'handler.ProvideBotHandler(botBindingService, botCheckInService, usageService, apiKeyService, userService)',
    'handler.ProvideBotHandler(botBindingService, botCheckInService, usageService, apiKeyService, userService, balanceNotifyQQRepository)',
  )
  target = target.replace(
    'handler.ProvideBotHandler(botBindingService, usageService, apiKeyService, userService)',
    'handler.ProvideBotHandler(botBindingService, botCheckInService, usageService, apiKeyService, userService, balanceNotifyQQRepository)',
  )
  target = target.replace(
    'handler.ProvideBotHandler(botBindingService, usageService,',
    'handler.ProvideBotHandler(botBindingService, botCheckInService, usageService,',
  )
  writeTarget(relativePath, target)
}

function composeRouterCall() {
  const relativePath = 'backend/internal/server/router.go'
  const routePath = path.join(root, 'backend/internal/server/routes/bot.go')
  if (!existsSync(routePath) || !existsSync(path.join(root, relativePath))) return
  let target = readTarget(relativePath)
  const routes = readTarget('backend/internal/server/routes/bot.go')
  const expectsAdmin = routes.includes('\tadminAuth middleware.AdminAuthMiddleware,')
  if (expectsAdmin) {
    target = target.replace(
      'routes.RegisterBotRoutes(v1, h, botAuth, panelRateLimiter)',
      'routes.RegisterBotRoutes(v1, h, adminAuth, botAuth, panelRateLimiter)',
    )
  }
  writeTarget(relativePath, target)
}

function ensureScopedAdminKeyWiring() {
  const relativePath = 'backend/cmd/server/wire_gen.go'
  if (!existsSync(path.join(root, relativePath))) return
  let target = readTarget(relativePath)
  const staleCall = '\tsettingService := service.ProvideSettingService(settingRepository, groupRepository, proxyRepository, configConfig)'
  const fixedCall = '\tscopedAdminKeyRepository := repository.NewScopedAdminKeyRepository(db)\n' +
    '\tsettingService := service.ProvideSettingService(scopedAdminKeyRepository, settingRepository, groupRepository, proxyRepository, configConfig)'
  if (target.includes('service.ProvideSettingService(scopedAdminKeyRepository,')) return
  if (!target.includes(staleCall)) return
  writeTarget(relativePath, target.replace(staleCall, fixedCall))
}

function composeKnownConflicts(conflicts, source) {
  const unexpected = conflicts.filter((file) => !COMPOSED_PATHS.has(file))
  if (unexpected.length > 0) fail('cannot resolve bot rewards generated-file conflicts: ' + unexpected.join(', '))
  // git apply --3way leaves unmerged index entries. Reset those entries before
  // materializing a known-good QQ source file and composing the check-in delta.
  git(['reset', '--', ...conflicts])
  const qqRef = 'origin/feat/qq-bot-binding'
  for (const file of conflicts) {
    if (!COMPOSED_PATHS.has(file)) continue
    if (PRESERVE_TARGET_PATHS.has(file)) {
      writeTarget(file, targetHeadFile(file))
      continue
    }
    try {
      writeTarget(file, sourceFile(qqRef, file))
    } catch {
      // Isolated tests may not provide the optional QQ source ref.
    }
  }
  if (conflicts.includes('backend/internal/handler/bot_handler.go')) composeBotHandler(source)
  if (conflicts.includes('backend/internal/handler/bot_handler.go')) composeQQBotHandler(sourceFile(ref, 'backend/internal/handler/bot_handler.go'))
  if (conflicts.includes('backend/internal/handler/wire.go')) composeHandlerWire()
  if (conflicts.includes('backend/internal/repository/wire.go')) composeRepositoryWire()
  if (conflicts.includes('backend/internal/server/routes/bot.go') || conflicts.includes('backend/internal/server/routes/bot_test.go')) composeRoutes()
  if (conflicts.includes('backend/cmd/server/wire_gen.go')) composeWireGen()
  git(['add', '--', ...conflicts])
}

function composeSharedFeatures() {
  const handlerPath = path.join(root, 'backend/internal/handler/bot_handler.go')
  if (existsSync(handlerPath)) {
    composeBotHandler(sourceFile(ref, 'backend/internal/handler/bot_handler.go'))
    try {
      composeQQBotHandler(sourceFile('origin/feat/qq-bot-binding', 'backend/internal/handler/bot_handler.go'))
    } catch {
      // The isolated overlay unit tests do not create the optional QQ ref.
    }
  }
  if (existsSync(path.join(root, 'backend/internal/handler/wire.go'))) composeHandlerWire()
  if (existsSync(path.join(root, 'backend/internal/repository/wire.go'))) composeRepositoryWire()
  if (existsSync(path.join(root, 'backend/internal/server/routes/bot.go'))) composeRoutes()
  if (existsSync(path.join(root, 'backend/cmd/server/wire_gen.go'))) composeWireGen()
  composeRouterCall()
  ensureScopedAdminKeyWiring()
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
  const botHandler = readTarget('backend/internal/handler/bot_handler.go')
  if (botHandler.includes('balanceNotifyQQRepo')) {
    for (const marker of [
      'SetBalanceNotifyQQRepository',
      'func (h *BotHandler) BalanceLowAlerts(',
      'func (h *BotHandler) AckBalanceLowAlert(',
    ]) {
      if (!botHandler.includes(marker)) fail('composed QQ bot marker is missing in backend/internal/handler/bot_handler.go: ' + marker)
    }
    const routes = readTarget('backend/internal/server/routes/bot.go')
    if (!routes.includes('balance-alerts')) fail('composed QQ bot routes are missing')
    const wire = readTarget('backend/cmd/server/wire_gen.go')
    if (!wire.includes('balanceNotifyQQRepository')) fail('composed QQ bot wiring is missing')
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
        'backend/internal/handler/admin/setting_handler.go',
        'backend/internal/handler/admin/setting_handler_update.go',
        'backend/internal/handler/bot_handler.go',
        'backend/internal/handler/wire.go',
        'backend/internal/repository/wire.go',
        'backend/internal/server/routes/bot.go',
        'backend/internal/server/routes/bot_test.go',
        'backend/internal/service/setting_update.go',
      ])
      if (conflicts.length === 0 || conflicts.some((file) => !expected.has(file))) {
        fail('cannot apply bot rewards patch' + (conflicts.length ? ' (conflicts: ' + conflicts.join(', ') + ')' : '') + ': ' + (error.stderr?.toString() || error.message))
      }

      try {
        composeKnownConflicts(conflicts, sourceFile(ref, 'backend/internal/handler/bot_handler.go'))
      } catch (resolveError) {
        fail('cannot resolve bot rewards generated-file conflicts: ' + (resolveError.stderr?.toString() || resolveError.message))
      }
    }
  }

  ensureTargetMigration(migrationPath, migrationText, true)
  composeSharedFeatures()
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
