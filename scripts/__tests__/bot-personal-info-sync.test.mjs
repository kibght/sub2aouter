import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { SOURCE_FILES } from '../apply-bot-personal-info.mjs'

const scriptPath = fileURLToPath(new URL('../apply-bot-personal-info.mjs', import.meta.url))
const sharedFiles = {
  '.gitignore': 'node_modules/\ndocs/*\n',
  'backend/internal/handler/bot_handler.go': `package handler
type BotHandler struct {
\tbindings botBindingManager
\tcheckIn botCheckInReader
\tbalanceNotifyQQRepo service.BalanceNotifyQQRepository
\tusers botUserReader
}
`,
  'backend/internal/handler/wire.go': `package handler
func ProvideBotHandler(
\tbindings *service.BotBindingService,
\tcheckIn *service.BotCheckInService,
\tusage *service.UsageService,
\tapiKeys *service.APIKeyService,
\tusers *service.UserService,
\tqqBalanceNotifyRepo service.BalanceNotifyQQRepository,
) *BotHandler {
\th := NewBotHandler(bindings, usage, apiKeys, users)
\th.SetCheckInService(checkIn)
\th.SetBalanceNotifyQQRepository(qqBalanceNotifyRepo)
\treturn h
}
`,
  'backend/cmd/server/wire_gen.go': `package main
func initialize() {
\tconcurrencyCache := repository.ProvideConcurrencyCache(redisClient, configConfig)
\tbotHandler := handler.ProvideBotHandler(botBindingService, botCheckInService, usageService, apiKeyService, userService, balanceNotifyQQRepository)
\tpluginHandler := handler.NewPluginHandler(pluginService)
}
`,
  'backend/internal/server/routes/bot.go': `package routes
func RegisterBotRoutes() {
\tbot := v1.Group("/bot")
\tbot.Use(gin.HandlerFunc(adminAuth))
\tbot.Use(gin.HandlerFunc(botAuth))
\tbot.Use(panelRateLimiter.Global())
\t{
\t\tbot.GET("/profile", h.Bot.Profile)
\t\tbot.POST("/check-in", h.Bot.CheckIn)
\t\tbot.GET("/balance-alerts", h.Bot.BalanceLowAlerts)
\t}
}
`,
}

async function fixture(t, { crlf = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-personal-info-sync-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'Personal Info Test')
  git('config', 'user.email', 'personal-info@example.invalid')
  git('config', 'core.autocrlf', 'false')
  const sourceContents = new Map()
  for (const file of SOURCE_FILES) {
    const content = 'source file: ' + file + '\n'
    sourceContents.set(file, content)
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), content)
  }
  await writeFile(path.join(root, 'unrelated.txt'), 'do not copy\n')
  git('add', '.')
  git('commit', '-qm', 'personal info source')
  git('branch', 'source')
  for (const file of SOURCE_FILES) await rm(path.join(root, file))
  for (const [file, content] of Object.entries(sharedFiles)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), crlf ? content.replaceAll('\n', '\r\n') : content)
  }
  const run = (...args) => execFileSync(process.execPath, [scriptPath, '--root', root, '--ref', 'source', ...args], { encoding: 'utf8', stdio: 'pipe' })
  const snapshot = async () => new Map(await Promise.all([...SOURCE_FILES, ...Object.keys(sharedFiles), 'unrelated.txt'].map(async (file) => {
    try { return [file, await readFile(path.join(root, file), 'utf8')] } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return [file, null]
    }
  })))
  return { root, run, snapshot, sourceContents }
}

for (const crlf of [false, true]) {
  test('composes personal info without replacing QQ or check-in features' + (crlf ? ' with CRLF' : ''), async (t) => {
    const { run, snapshot, sourceContents } = await fixture(t, { crlf })
    run()
    const applied = await snapshot()
    for (const [file, content] of sourceContents) assert.equal(applied.get(file), content)
    for (const [file, content] of Object.entries(sharedFiles)) {
      const result = applied.get(file).replaceAll('\r\n', '\n')
      for (const line of content.trimEnd().split('\n')) {
        if (line.includes('botHandler := handler.ProvideBotHandler')) continue
        assert.ok(result.split('\n').includes(line), 'preserves original line in ' + file + ': ' + line)
      }
      if (crlf) assert.equal(applied.get(file).replaceAll('\r\n', '').includes('\n'), false)
    }
    assert.match(applied.get('backend/internal/handler/bot_handler.go'), /concurrency\s+botConcurrencyReader/)
    assert.match(applied.get('backend/internal/handler/wire.go'), /h\.SetConcurrencyReader\(concurrencyCache\)/)
    assert.match(applied.get('backend/cmd/server/wire_gen.go'), /ProvideBotHandler\(botBindingService, botCheckInService, usageService, apiKeyService, userService, balanceNotifyQQRepository, concurrencyCache\)/)
    assert.match(applied.get('backend/internal/server/routes/bot.go'), /bot\.GET\("\/personal-info", panelRateLimiter\.Heavy\(\), h\.Bot\.PersonalInfo\)/)
    assert.match(applied.get('.gitignore'), /!docs\/bot-personal-info\.md/)
    assert.match(run('--check'), /Verified bot personal-info overlay/)
    assert.deepEqual(await snapshot(), applied, '--check must not write files')
    run()
    assert.deepEqual(await snapshot(), applied, 'repeat application must be idempotent')
  })
}

test('check rejects an incomplete overlay without creating files', async (t) => {
  const { run, snapshot } = await fixture(t)
  const before = await snapshot()
  assert.throws(() => run('--check'), /source file is missing/)
  assert.deepEqual(await snapshot(), before)
})

for (const [name, file, alter, error] of [
  ['wrong cache argument', 'backend/cmd/server/wire_gen.go', (text) => text.replace('userService, balanceNotifyQQRepository)', 'userService, concurrencyCache, balanceNotifyQQRepository)'), /unsupported generated bot concurrency argument/],
  ['wrong cache type', 'backend/internal/handler/wire.go', (text) => text.replace('\tusers *service.UserService,\n', '\tusers *service.UserService,\n\tconcurrencyCache *service.ConcurrencyService,\n'), /unsupported bot provider concurrency parameter/],
  ['wrong setter argument', 'backend/internal/handler/wire.go', (text) => text.replace('\treturn h\n', '\th.SetConcurrencyReader(nil)\n\treturn h\n'), /unsupported bot provider concurrency setter/],
  ['missing admin authentication', 'backend/internal/server/routes/bot.go', (text) => text.replace('\tbot.Use(gin.HandlerFunc(adminAuth))\n', ''), /bot authentication or global rate limit is missing/],
  ['missing heavy rate limit', 'backend/internal/server/routes/bot.go', (text) => text.replace('\t\tbot.GET("/profile", h.Bot.Profile)\n', '\t\tbot.GET("/profile", h.Bot.Profile)\n\t\tbot.GET("/personal-info", h.Bot.PersonalInfo)\n'), /unsupported personal-info route/],
]) {
  test('rejects ' + name + ' without partially applying the overlay', async (t) => {
    const { root, run, snapshot } = await fixture(t)
    await writeFile(path.join(root, file), alter(sharedFiles[file]))
    const before = await snapshot()
    assert.throws(() => run(), error)
    assert.deepEqual(await snapshot(), before)
  })
}

test('check rejects missing concurrency injection without repairing it', async (t) => {
  const { root, run, snapshot } = await fixture(t)
  run()
  const target = path.join(root, 'backend/internal/handler/wire.go')
  await writeFile(target, (await readFile(target, 'utf8')).replace('\th.SetConcurrencyReader(concurrencyCache)\n', ''))
  const before = await snapshot()
  assert.throws(() => run('--check'), /personal-info integration is missing/)
  assert.deepEqual(await snapshot(), before)
})
