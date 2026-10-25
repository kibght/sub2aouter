#!/usr/bin/env node
// 把 feat/deepseek-bot-binding 分支上的机器人绑定功能叠加到上游生成树里。
// 与 theme overlay / Infinite Canvas integration 一样，作为自动同步流程的一步执行：
//   node scripts/apply-bot-binding.mjs --root <generated-dir> --ref origin/feat/deepseek-bot-binding
// 新增文件直接从分支读取；共享文件按锚点插入；迁移按当前最大编号顺延；脚本幂等。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const root = path.resolve(valueOf('--root', '.'))
const ref = valueOf('--ref', 'origin/feat/deepseek-bot-binding')
const checkOnly = argv.includes('--check')

const CHANGED = []
const problems = []

const sh = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const fromRef = (p) => sh(['show', ref + ':' + p])
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const writeFile = (p, text) => {
  const abs = path.join(root, p)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, text, 'utf8')
  CHANGED.push(p)
}

function fail(message) {
  problems.push(message)
}

function ensureFile(p) {
  if (!existsSync(path.join(root, p))) fail('missing file: ' + p)
}

// 在第一个 anchor 之后插入纯新增内容（anchor 本身不重复写入）。
function insertAfter(p, anchor, addition, marker) {
  ensureFile(p)
  const text = read(p)
  if (marker && text.includes(marker)) return false
  const index = text.indexOf(anchor)
  if (index < 0) {
    fail('anchor not found in ' + p + ': ' + anchor.split('\n')[0].slice(0, 80))
    return false
  }
  if (checkOnly) return true
  const at = index + anchor.length
  writeFile(p, text.slice(0, at) + addition + text.slice(at))
  return true
}

// 在第一个 anchor 之前插入纯新增内容。
function insertBefore(p, anchor, addition, marker) {
  ensureFile(p)
  const text = read(p)
  if (marker && text.includes(marker)) return false
  const index = text.indexOf(anchor)
  if (index < 0) {
    fail('anchor not found in ' + p + ': ' + anchor.split('\n')[0].slice(0, 80))
    return false
  }
  if (checkOnly) return true
  writeFile(p, text.slice(0, index) + addition + text.slice(index))
  return true
}

function replaceAll(p, find, replacement, marker) {
  ensureFile(p)
  const text = read(p)
  if (marker && text.includes(marker)) return false
  if (!text.includes(find)) {
    fail('pattern not found in ' + p + ': ' + find.split('\n')[0].slice(0, 80))
    return false
  }
  if (checkOnly) return true
  writeFile(p, text.split(find).join(replacement))
  return true
}

function insertInLine(p, linePrefix, lineSuffix, token, addition, marker) {
  ensureFile(p)
  const text = read(p)
  if (marker && text.includes(marker)) return false
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.startsWith(linePrefix) && line.includes(lineSuffix))
  if (index < 0) {
    fail('line not found in ' + p + ': ' + linePrefix + ' / ' + lineSuffix)
    return false
  }
  if (!lines[index].includes(token)) {
    fail('token not found in ' + p + ': ' + token)
    return false
  }
  if (checkOnly) return true
  lines[index] = lines[index].replace(token, token + addition)
  writeFile(p, lines.join('\n'))
  return true
}

const NEW_FILES = [
  'backend/internal/service/bot_binding.go',
  'backend/internal/service/bot_binding_test.go',
  'backend/internal/repository/bot_binding_repo.go',
  'backend/internal/repository/bot_binding_repo_integration_test.go',
  'backend/internal/handler/bot_handler.go',
  'backend/internal/handler/bot_handler_test.go',
  'backend/internal/server/middleware/bot_auth.go',
  'backend/internal/server/middleware/bot_auth_test.go',
  'backend/internal/server/routes/bot.go',
  'backend/internal/server/routes/bot_test.go',
  'frontend/src/api/botBindings.ts',
  'frontend/src/components/user/profile/ProfileBotBindingCard.vue',
  'frontend/src/components/user/profile/__tests__/ProfileBotBindingCard.spec.ts',
]

for (const p of NEW_FILES) {
  if (checkOnly) {
    ensureFile(p)
    continue
  }
  try {
    writeFile(p, fromRef(p))
  } catch (error) {
    fail('cannot read ' + p + ' from ' + ref + ': ' + error.message)
  }
}

function migrationFiles() {
  const dir = path.join(root, 'backend/migrations')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => /^\d+_.*\.sql$/.test(name))
}

function sourceMigrationFiles() {
  return sh(['ls-tree', '-r', '--name-only', ref, '--', 'backend/migrations'])
    .split(/\r?\n/)
    .map((name) => path.basename(name))
}

function allocateMigrationNames() {
  const files = migrationFiles()
  const bot = files.find((name) => /_bot_bindings\.sql$/.test(name))
  const scope = files.find((name) => /_bot_bindings_scope_unique_to_user\.sql$/.test(name))
  if (bot && scope) return [bot, scope]
  let max = 0
  for (const name of files) max = Math.max(max, Number.parseInt(name.split('_')[0], 10) || 0)
  return [
    bot || String(max + 1).padStart(3, '0') + '_bot_bindings.sql',
    scope || String(max + 2).padStart(3, '0') + '_bot_bindings_scope_unique_to_user.sql',
  ]
}

const [botMigration, scopeMigration] = allocateMigrationNames()
let sourceBotMigration = ''
let sourceScopeMigration = ''
try {
  const sourceFiles = sourceMigrationFiles()
  sourceBotMigration = sourceFiles.find((name) => /_bot_bindings\.sql$/.test(name)) || ''
  sourceScopeMigration = sourceFiles.find((name) => /_bot_bindings_scope_unique_to_user\.sql$/.test(name)) || ''
  if (!sourceBotMigration || !sourceScopeMigration) {
    fail('bot binding migration files are missing in ' + ref)
  }
} catch (error) {
  fail('cannot list bot binding migrations in ' + ref + ': ' + error.message)
}

if (checkOnly) {
  ensureFile('backend/migrations/' + botMigration)
  ensureFile('backend/migrations/' + scopeMigration)
  ensureFile('backend/migrations/bot_bindings_migration_test.go')
} else if (sourceBotMigration && sourceScopeMigration) {
  try {
    writeFile('backend/migrations/' + botMigration, fromRef('backend/migrations/' + sourceBotMigration))
    writeFile('backend/migrations/' + scopeMigration, fromRef('backend/migrations/' + sourceScopeMigration))
    writeFile(
      'backend/migrations/bot_bindings_migration_test.go',
      fromRef('backend/migrations/bot_bindings_migration_test.go')
        .split(sourceBotMigration).join(botMigration)
        .split(sourceScopeMigration).join(scopeMigration),
    )
  } catch (error) {
    fail('cannot carry bot binding migrations: ' + error.message)
  }
}

// ---- 后端接线 ----
replaceAll(
  'backend/internal/handler/handler.go',
  '\tBatchImage       *BatchImageHandler\n}',
  '\tBatchImage       *BatchImageHandler\n\tBot              *BotHandler\n}',
  'Bot              *BotHandler',
)
insertBefore(
  'backend/internal/handler/wire.go',
  '// ProvideHandlers creates the Handlers struct',
  "// ProvideBotHandler 创建机器人接口处理器。\n" +
    'func ProvideBotHandler(\n' +
    '\tbindings *service.BotBindingService,\n' +
    '\tusage *service.UsageService,\n' +
    '\tapiKeys *service.APIKeyService,\n' +
    '\tusers *service.UserService,\n' +
    ') *BotHandler {\n' +
    '\treturn NewBotHandler(bindings, usage, apiKeys, users)\n' +
    '}\n\n',
  'func ProvideBotHandler(',
)
insertAfter(
  'backend/internal/handler/wire.go',
  '\tbatchImageHandler *BatchImageHandler,\n',
  '\tbotHandler *BotHandler,\n',
  'botHandler *BotHandler',
)
insertAfter(
  'backend/internal/handler/wire.go',
  '\t\tBatchImage:       batchImageHandler,\n',
  '\t\tBot:              botHandler,\n',
  'Bot:              botHandler',
)
insertAfter(
  'backend/internal/handler/wire.go',
  '\tProvideBatchImageHandler,\n',
  '\tProvideBotHandler,\n',
  'ProvideBotHandler,\n',
)
insertAfter(
  'backend/internal/server/middleware/wire.go',
  '\tNewStepUpAuthMiddleware,\n',
  '\tNewBotAuthMiddleware,\n',
  'NewBotAuthMiddleware',
)
insertAfter(
  'backend/internal/service/wire.go',
  '\tNewUserService,\n',
  '\tNewBotBindingService,\n',
  'NewBotBindingService',
)
insertAfter(
  'backend/internal/repository/wire.go',
  '\tNewUserRepository,\n',
  '\tNewBotBindingRepository,\n',
  'NewBotBindingRepository',
)

// ---- 路由 ----
replaceAll(
  'backend/internal/server/router.go',
  '\tstepUpAuth middleware2.StepUpAuthMiddleware,\n\tapiKeyService *service.APIKeyService,',
  '\tstepUpAuth middleware2.StepUpAuthMiddleware,\n\tbotAuth middleware2.BotAuthMiddleware,\n\tapiKeyService *service.APIKeyService,',
  'botAuth middleware2.BotAuthMiddleware',
)
insertInLine(
  'backend/internal/server/router.go',
  '\tregisterRoutes(r, handlers,',
  'stepUpAuth, apiKeyService,',
  'stepUpAuth, ',
  'botAuth, ',
  'stepUpAuth, botAuth, apiKeyService',
)
insertBefore(
  'backend/internal/server/router.go',
  '\troutes.RegisterGatewayRoutes(',
  '\troutes.RegisterBotRoutes(v1, h, botAuth, panelRateLimiter)\n',
  'RegisterBotRoutes',
)
replaceAll(
  'backend/internal/server/http.go',
  '\tstepUpAuth middleware2.StepUpAuthMiddleware,\n\tapiKeyService *service.APIKeyService,',
  '\tstepUpAuth middleware2.StepUpAuthMiddleware,\n\tbotAuth middleware2.BotAuthMiddleware,\n\tapiKeyService *service.APIKeyService,',
  'botAuth middleware2.BotAuthMiddleware',
)
insertInLine(
  'backend/internal/server/http.go',
  '\treturn SetupRouter(r, handlers,',
  'stepUpAuth, apiKeyService,',
  'stepUpAuth, ',
  'botAuth, ',
  'stepUpAuth, botAuth, apiKeyService',
)
insertAfter(
  'backend/internal/server/routes/user.go',
  '\t\t\tuser.GET("/platform-quotas", h.User.GetMyPlatformQuotas)\n',
  '\n\t\t\t// 聊天机器人绑定：网站生成一次性绑定码，机器人用绑定码换取独立令牌。\n' +
    '\t\t\tuser.POST("/bot-bindings/code", h.Bot.CreateBindingCode)\n' +
    '\t\t\tuser.GET("/bot-bindings", h.Bot.ListBindings)\n' +
    '\t\t\tuser.DELETE("/bot-bindings/:id", h.Bot.RevokeBinding)\n',
  'user.POST("/bot-bindings/code"',
)

// ---- wire_gen 等价插入 ----
insertBefore(
  'backend/cmd/server/wire_gen.go',
  '\thandlers := handler.ProvideHandlers(',
  '\tbotBindingRepository := repository.NewBotBindingRepository(db)\n' +
    '\tbotBindingService := service.NewBotBindingService(botBindingRepository)\n' +
    '\tbotHandler := handler.ProvideBotHandler(botBindingService, usageService, apiKeyService, userService)\n',
  'botBindingService := service.NewBotBindingService(',
)
insertInLine(
  'backend/cmd/server/wire_gen.go',
  '\thandlers := handler.ProvideHandlers(',
  'batchImageHandler,',
  'batchImageHandler, ',
  'botHandler, ',
  'batchImageHandler, botHandler,',
)
insertBefore(
  'backend/cmd/server/wire_gen.go',
  '\tengine := server.ProvideRouter(',
  '\tbotAuthMiddleware := middleware.NewBotAuthMiddleware(botBindingService, userService)\n',
  'botAuthMiddleware := middleware.NewBotAuthMiddleware(',
)
insertInLine(
  'backend/cmd/server/wire_gen.go',
  '\tengine := server.ProvideRouter(',
  'stepUpAuthMiddleware,',
  'stepUpAuthMiddleware, ',
  'botAuthMiddleware, ',
  'stepUpAuthMiddleware, botAuthMiddleware,',
)

// ---- 前端 ----
insertAfter(
  'frontend/src/views/user/ProfileView.vue',
  '      <ProfilePasskeyCard :enabled="passkeyEnabled" />\n',
  '      <ProfileBotBindingCard />\n',
  '<ProfileBotBindingCard />',
)
insertAfter(
  'frontend/src/views/user/ProfileView.vue',
  "import ProfilePasskeyCard from '@/components/user/profile/ProfilePasskeyCard.vue'\n",
  "import ProfileBotBindingCard from '@/components/user/profile/ProfileBotBindingCard.vue'\n",
  'ProfileBotBindingCard.vue',
)
insertAfter(
  'frontend/src/api/index.ts',
  "export { passkeyAPI, type PasskeyCredentialSummary } from './passkey'\n",
  'export {\n  botBindingsAPI,\n  type BotBinding,\n  type BotBindingCode,\n  type BotBindingListResponse,\n} from \'./botBindings\'\n',
  'botBindingsAPI',
)

function extractBlock(text, key) {
  const marker = '    ' + key + ': {'
  const start = text.indexOf(marker)
  if (start < 0) return ''
  let depth = 0
  let index = start + marker.length - 1
  for (; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) {
        index += 1
        break
      }
    }
  }
  while (index < text.length && (text[index] === ',' || text[index] === '\r')) index += 1
  if (text[index] === '\n') index += 1
  return text.slice(start, index)
}

for (const locale of ['zh', 'en']) {
  const target = 'frontend/src/i18n/locales/' + locale + '/dashboard.ts'
  ensureFile(target)
  const current = read(target)
  if (current.includes('botBinding:')) continue
  let block = ''
  try {
    block = extractBlock(fromRef(target), 'botBinding')
  } catch (error) {
    fail('cannot read i18n block from ' + ref + ': ' + error.message)
    continue
  }
  if (!block) {
    fail('botBinding i18n block missing in ' + ref + ':' + target)
    continue
  }
  const index = current.indexOf('    balanceNotify: {')
  if (index < 0) {
    fail('i18n anchor not found in ' + target)
    continue
  }
  if (!checkOnly) writeFile(target, current.slice(0, index) + block + current.slice(index))
}

insertAfter(
  'frontend/src/views/user/__tests__/ProfileView.spec.ts',
  "          ProfileTotpCard: { template: '<div data-testid=\"profile-totp-card\" />' },\n",
  "          ProfileBotBindingCard: { template: '<div data-testid=\"profile-bot-binding-card\" />' },\n",
  'profile-bot-binding-card',
)
insertAfter(
  'frontend/src/views/user/__tests__/ProfileView.spec.ts',
  "    expect(wrapper.get('[data-testid=\"profile-shell\"]').html()).toContain('profile-totp-card')\n",
  "    expect(wrapper.get('[data-testid=\"profile-shell\"]').html()).toContain('profile-bot-binding-card')\n",
  "toContain('profile-bot-binding-card')",
)

if (problems.length > 0) {
  console.error('apply-bot-binding: failed')
  for (const problem of problems) console.error(' - ' + problem)
  process.exit(1)
}

console.log(
  (checkOnly ? 'Verified' : 'Applied') +
    ' bot binding overlay from ' + ref + ' (' + CHANGED.length + ' file(s)' +
    (checkOnly ? '' : ' written') + ', migrations ' + botMigration + ' / ' + scopeMigration + ')',
)
