#!/usr/bin/env node

// Apply the unified QQ bot delta after the legacy bot-binding overlay.
// The source branch is a single commit on top of the original binding source,
// so its parent is a stable patch base and the generated upstream tree keeps
// all unrelated upstream changes.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const root = path.resolve(valueOf('--root', '.'))
const ref = valueOf('--ref', 'origin/feat/qq-bot-binding')
const checkOnly = argv.includes('--check')
const marker = 'backend/internal/repository/balance_notify_qq_repo.go'

const git = (args, options = {}) => execFileSync('git', args, {
  cwd: root,
  encoding: options.encoding || 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  ...options,
})

function replaceRequired(source, find, replacement, label) {
  if (source.includes(replacement)) return source
  if (!source.includes(find)) {
    throw new Error(`unsupported ${label} wiring`)
  }
  return source.replace(find, replacement)
}

function applyQQWireGen() {
  const file = 'backend/cmd/server/wire_gen.go'
  const filePath = path.join(root, file)
  let source = readFileSync(filePath, 'utf8')
  if (!source.includes('balanceNotifyQQRepository := repository.NewBalanceNotifyQQRepository(db)')) {
    source = source.replace(
      /(^\tuserService := service\.(?:NewUserService|ProvideUserService)\([^\n]+\)\r?\n)/m,
      '\tbalanceNotifyQQRepository := repository.NewBalanceNotifyQQRepository(db)\n$1',
    )
  }
  source = replaceRequired(
    source,
    '\tuserService := service.NewUserService(userRepository, settingRepository, apiKeyAuthCacheInvalidator, billingCache)',
    '\tuserService := service.ProvideUserService(userRepository, settingRepository, apiKeyAuthCacheInvalidator, billingCache, balanceNotifyQQRepository)',
    'user service',
  )
  source = replaceRequired(
    source,
    'service.ProvideBalanceNotifyService(emailService, settingRepository, accountRepository, notificationEmailService)',
    'service.ProvideBalanceNotifyService(emailService, settingRepository, accountRepository, notificationEmailService, balanceNotifyQQRepository)',
    'balance notification service',
  )
  source = replaceRequired(
    source,
    'handler.ProvideBotHandler(botBindingService, usageService, apiKeyService, userService)',
    'handler.ProvideBotHandler(botBindingService, usageService, apiKeyService, userService, balanceNotifyQQRepository)',
    'bot handler',
  )
  writeFileSync(filePath, source, 'utf8')
}

function ensureQQWireGenTest({ repair = true } = {}) {
  const filePath = path.join(root, 'backend/cmd/server/wire_gen_test.go')
  if (!existsSync(filePath)) return
  let source = readFileSync(filePath, 'utf8')
  const legacyCall = 'service.ProvideBalanceNotifyService(nil, nil, nil, nil)'
  if (!source.includes(legacyCall)) return
  if (!repair) fail('generated Wire test still uses the legacy balance notification provider call')
  source = source.replaceAll(legacyCall, 'service.ProvideBalanceNotifyService(nil, nil, nil, nil, nil)')
  writeFileSync(filePath, source, 'utf8')
}

function applyQQHandlerWire() {
  const filePath = path.join(root, 'backend/internal/handler/wire.go')
  let source = readFileSync(filePath, 'utf8')
  source = replaceRequired(
    source,
    '\tusers *service.UserService,\n) *BotHandler {\n\th := NewBotHandler(bindings, usage, apiKeys, users)\n\treturn h\n}',
    '\tusers *service.UserService,\n\tqqBalanceNotifyRepo service.BalanceNotifyQQRepository,\n) *BotHandler {\n\th := NewBotHandler(bindings, usage, apiKeys, users)\n\th.SetBalanceNotifyQQRepository(qqBalanceNotifyRepo)\n\treturn h\n}',
    'bot handler',
  )
  writeFileSync(filePath, source, 'utf8')
}

function applyQQRepositoryWire() {
  const filePath = path.join(root, 'backend/internal/repository/wire.go')
  let source = readFileSync(filePath, 'utf8')
  source = replaceRequired(
    source,
    '\tNewBotBindingRepository,\n',
    '\tNewBotBindingRepository,\n\tNewBalanceNotifyQQRepository,\n',
    'repository',
  )
  writeFileSync(filePath, source, 'utf8')
}

function applyQQRouter() {
  const filePath = path.join(root, 'backend/internal/server/router.go')
  let source = readFileSync(filePath, 'utf8')
  source = replaceRequired(
    source,
    'routes.RegisterBotRoutes(v1, h, botAuth, panelRateLimiter)',
    'routes.RegisterBotRoutes(v1, h, adminAuth, botAuth, panelRateLimiter)',
    'bot route',
  )
  writeFileSync(filePath, source, 'utf8')
}

function applyQQBalanceNotify() {
  const file = 'backend/internal/service/balance_notify_service.go'
  const filePath = path.join(root, file)
  let source = readFileSync(filePath, 'utf8')
  if (!source.includes('qqNotificationRepo       BalanceNotifyQQRepository')) {
    const usageField = /(^\tusageNotifications\s+\*usageNotificationWorker\r?\n)/m
    if (usageField.test(source)) {
      source = source.replace(usageField, '$1\tqqNotificationRepo       BalanceNotifyQQRepository\n')
    } else {
      source = source.replace(
        /(^\tnotificationEmailService \*NotificationEmailService\r?\n)/m,
        '$1\tqqNotificationRepo       BalanceNotifyQQRepository\n',
      )
    }
  }
  if (!source.includes('SetBalanceNotifyQQRepository')) {
    const setter = 'func (s *BalanceNotifyService) SetNotificationEmailService(notificationEmailService *NotificationEmailService) {\n\ts.notificationEmailService = notificationEmailService\n}\n'
    source = replaceRequired(
      source,
      setter,
      `${setter}\nfunc (s *BalanceNotifyService) SetBalanceNotifyQQRepository(repo BalanceNotifyQQRepository) {\n\ts.qqNotificationRepo = repo\n}\n`,
      'balance notification repository setter',
    )
  }
  source = replaceRequired(
    source,
    'if user == nil || s.emailService == nil || s.settingRepo == nil {',
    'if user == nil || s.settingRepo == nil || (s.emailService == nil && s.qqNotificationRepo == nil) {',
    'balance notification guard',
  )
  if (!source.includes('s.qqNotificationRepo.EnqueueBalanceLow')) {
    const anchor = '\trecipients := s.collectBalanceNotifyRecipients(user)\n'
    const addition = '\tif s.qqNotificationRepo != nil {\n' +
      '\t\tqueueCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)\n' +
      '\t\terr := s.qqNotificationRepo.EnqueueBalanceLow(queueCtx, user.ID, BalanceLowQQAlert{\n' +
      '\t\t\tBalance:     newBalance,\n' +
      '\t\t\tThreshold:   threshold,\n' +
      '\t\t\tSiteName:    siteName,\n' +
      '\t\t\tRechargeURL: rechargeURL,\n' +
      '\t\t\tCreatedAt:   time.Now().UTC(),\n' +
      '\t\t})\n' +
      '\t\tcancel()\n' +
      '\t\tif err != nil {\n' +
      '\t\t\tslog.Error("failed to queue QQ low balance notification", "user_id", user.ID, "error", err)\n' +
      '\t\t}\n' +
      '\t}\n'
    source = replaceRequired(source, anchor, anchor + addition, 'balance notification queue')
  }
  const directSend = '\ts.sendBalanceLowEmails(ctx, recipients, user.ID, user.Username, user.Email, newBalance, threshold, siteName, rechargeURL)\n'
  if (!source.includes('\t\t' + directSend.trimStart())) {
    source = replaceRequired(
      source,
      directSend,
      '\tif s.emailService != nil {\n\t' + directSend + '\t}\n',
      'balance notification email guard',
    )
  }
  writeFileSync(filePath, source, 'utf8')
}

function applyQQServiceWire() {
  const filePath = path.join(root, 'backend/internal/service/wire.go')
  let source = readFileSync(filePath, 'utf8')
  source = replaceRequired(source, '\tNewUserService,\n', '\tProvideUserService,\n', 'user service provider')
  if (!source.includes('func ProvideUserService(')) {
    const anchor = '// ProvideBalanceNotifyService creates BalanceNotifyService\n'
    const addition = '// ProvideUserService wires the QQ balance notification repository into UserService.\n' +
      'func ProvideUserService(userRepo UserRepository, settingRepo SettingRepository, authCacheInvalidator APIKeyAuthCacheInvalidator, billingCache BillingCache, qqRepo BalanceNotifyQQRepository) *UserService {\n' +
      '\tsvc := NewUserService(userRepo, settingRepo, authCacheInvalidator, billingCache)\n' +
      '\tsvc.SetBalanceNotifyQQRepository(qqRepo)\n' +
      '\treturn svc\n}\n\n'
    source = replaceRequired(source, anchor, addition + anchor, 'user service provider function')
  }
  const oldBalance = 'func ProvideBalanceNotifyService(emailService *EmailService, settingRepo SettingRepository, accountRepo AccountRepository, notificationEmailService *NotificationEmailService) *BalanceNotifyService {\n\tsvc := NewBalanceNotifyService(emailService, settingRepo, accountRepo)\n\tsvc.SetNotificationEmailService(notificationEmailService)\n\treturn svc\n}'
  const newBalance = 'func ProvideBalanceNotifyService(emailService *EmailService, settingRepo SettingRepository, accountRepo AccountRepository, notificationEmailService *NotificationEmailService, qqRepo BalanceNotifyQQRepository) *BalanceNotifyService {\n\tsvc := NewBalanceNotifyService(emailService, settingRepo, accountRepo)\n\tsvc.SetNotificationEmailService(notificationEmailService)\n\tsvc.SetBalanceNotifyQQRepository(qqRepo)\n\treturn svc\n}'
  source = replaceRequired(source, oldBalance, newBalance, 'balance notification provider')
  writeFileSync(filePath, source, 'utf8')
}

function applyQQChanges(file) {
  switch (file) {
    case 'backend/cmd/server/wire_gen.go':
      applyQQWireGen()
      break
    case 'backend/internal/handler/wire.go':
      applyQQHandlerWire()
      break
    case 'backend/internal/repository/wire.go':
      applyQQRepositoryWire()
      break
    case 'backend/internal/server/router.go':
      applyQQRouter()
      break
    case 'backend/internal/service/balance_notify_service.go':
      applyQQBalanceNotify()
      break
    case 'backend/internal/service/wire.go':
      applyQQServiceWire()
      break
    default:
      throw new Error(`unsupported QQ overlay conflict: ${file}`)
  }
}

function fail(message) {
  console.error('apply-qq-bot-binding: ' + message)
  process.exit(1)
}

function ensureScopedAdminKeyWiring({ repair = true } = {}) {
  const wireGenPath = path.join(root, 'backend/cmd/server/wire_gen.go')
  if (!existsSync(wireGenPath)) {
    fail('generated Wire injector is missing: ' + wireGenPath)
  }

  const source = readFileSync(wireGenPath, 'utf8')
  const staleCall = '\tsettingService := service.ProvideSettingService(settingRepository, groupRepository, proxyRepository, configConfig)'
  const fixedCall = '\tscopedAdminKeyRepository := repository.NewScopedAdminKeyRepository(db)\n' +
    '\tsettingService := service.ProvideSettingService(scopedAdminKeyRepository, settingRepository, groupRepository, proxyRepository, configConfig)'

  if (source.includes('service.ProvideSettingService(scopedAdminKeyRepository,')) {
    return
  }
  if (!source.includes(staleCall)) {
    fail('generated Wire injector has an unsupported setting service wiring')
  }
  if (!repair) {
    fail('generated Wire injector still uses the stale setting service wiring')
  }

  writeFileSync(wireGenPath, source.replace(staleCall, fixedCall), 'utf8')
}

let baseRef
try {
  baseRef = git(['rev-parse', ref + '^']).trim()
} catch (error) {
  fail('source branch must include its original binding parent: ' + ref)
}

if (checkOnly) {
  if (!existsSync(path.join(root, marker))) {
    fail('QQ balance-alert integration is missing: ' + marker)
  }
  ensureQQWireGenTest({ repair: false })
  ensureScopedAdminKeyWiring({ repair: false })
  console.log('Verified QQ bot binding overlay from ' + ref + ' (base ' + baseRef + ').')
  process.exit(0)
}

if (existsSync(path.join(root, marker))) {
  ensureQQWireGenTest()
  ensureScopedAdminKeyWiring()
  console.log('Preserved existing QQ bot balance-alert integration.')
  process.exit(0)
}

let patch
try {
  patch = git(['diff', '--binary', baseRef, ref, '--'], { encoding: 'buffer' })
} catch (error) {
  fail('cannot build QQ bot delta: ' + (error.stderr?.toString() || error.message))
}

if (!patch || patch.length === 0) {
  fail('QQ bot source branch has no delta relative to its binding parent')
}

try {
  // The legacy overlay writes files directly, so refresh the worktree index
  // before applying a three-way patch against the original binding blobs.
  git(['add', '--all'])
  git(['apply', '--3way', '--whitespace=nowarn'], { input: patch })
} catch (error) {
  const conflicts = git(['diff', '--name-only', '--diff-filter=U'])
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
  const expected = new Set([
    'backend/cmd/server/wire_gen.go',
    'backend/internal/handler/wire.go',
    'backend/internal/repository/wire.go',
    'backend/internal/server/router.go',
    'backend/internal/service/balance_notify_service.go',
    'backend/internal/service/wire.go',
  ])
  if (conflicts.length === 0 || conflicts.some((file) => !expected.has(file))) {
    fail('cannot apply QQ bot delta: ' + (error.stderr?.toString() || error.message))
  }

  // Restore the generated upstream/legacy-overlay side, then apply only the
  // QQ-specific additions. Taking the feature branch file wholesale would
  // discard unrelated MCP wiring added by a newer upstream release.
  try {
    git(['checkout', '--ours', '--', ...conflicts])
    for (const file of conflicts) {
      applyQQChanges(file)
      git(['add', '--', file])
    }
  } catch (resolveError) {
    fail('cannot resolve QQ bot overlay conflicts: ' + (resolveError.stderr?.toString() || resolveError.message))
  }
}

if (!existsSync(path.join(root, marker))) {
  fail('QQ balance-alert integration is still missing after applying the delta')
}

ensureQQWireGenTest()
ensureScopedAdminKeyWiring()

console.log('Applied QQ bot balance-alert delta from ' + ref + ' (base ' + baseRef + ').')
