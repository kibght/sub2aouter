import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { HELPER_FILES, MANIFEST_PATH } from '../apply-qqbot-website.mjs'

const scriptPath = fileURLToPath(new URL('../apply-qqbot-website.mjs', import.meta.url))
const testPath = fileURLToPath(import.meta.url)
const baseFiles = {
  'backend/internal/server/routes/bot.go': `package routes
func RegisterBotRoutes() {
 v1.POST("/bot-bindings/redeem", gin.HandlerFunc(adminAuth), panelRateLimiter.PublicIP(), h.Bot.Redeem)
 bot := v1.Group("/bot")
 bot.Use(gin.HandlerFunc(adminAuth))
 bot.Use(gin.HandlerFunc(botAuth))
 bot.Use(panelRateLimiter.Global())
 bot.POST("/check-in", h.Bot.CheckIn)
 bot.GET("/balance-alerts", h.Bot.BalanceLowAlerts)
 bot.GET("/personal-info", panelRateLimiter.Heavy(), h.Bot.PersonalInfo)
}
`,
  'backend/internal/server/routes/bot_lottery.go': `package routes
func RegisterBotLotteryRoutes() {
 bot := v1.Group("/bot")
 bot.Use(gin.HandlerFunc(adminAuth))
 bot.Use(gin.HandlerFunc(botAuth), panelRateLimiter.Global())
 bot.GET("/lottery", h.BotConfig)
}
`,
  'backend/internal/server/routes/bot_recharge.go': `package routes
func RegisterBotRechargeRoutes() {
 bot := v1.Group("/bot")
 bot.Use(gin.HandlerFunc(adminAuth))
 bot.Use(gin.HandlerFunc(botAuth))
 bot.Use(middleware.BackendModeUserGuard(settingService))
 bot.Use(panelRateLimiter.Global())
 bot.GET("/recharge/options", h.Options)
}
`,
  'backend/internal/handler/wire.go': `package handler
func ProvideBotHandler() {
 h.SetCheckInService(checkIn)
 h.SetBalanceNotifyQQRepository(qqBalanceNotifyRepo)
 h.SetConcurrencyReader(concurrencyCache)
}
var ProviderSet = wire.NewSet(NewBotLotteryHandler, NewBotRechargeHandler)
`,
  'backend/internal/handler/handler.go': 'package handler\ntype Handlers struct { BotLottery *BotLotteryHandler; BotRecharge *BotRechargeHandler }\n',
  'backend/internal/repository/wire.go': 'package repository\nvar ProviderSet = wire.NewSet(NewBotLotteryRepository, NewBotRechargeRepository)\n',
  'backend/internal/service/wire.go': 'package service\nvar ProviderSet = wire.NewSet(ProvideBotLotteryService, NewBotRechargeService)\n',
  'backend/internal/server/router.go': 'package server\nfunc registerRoutes() { routes.RegisterBotRoutes(); routes.RegisterBotLotteryRoutes(); routes.RegisterBotRechargeRoutes() }\n',
  'backend/cmd/server/wire.go': 'package main\nfunc provideCleanup(botLottery *service.BotLotteryService) { botLottery.Stop() }\n',
  'backend/cmd/server/wire_gen.go': 'package main\nfunc initialize() { service.ProvideBotLotteryService(); service.NewBotRechargeService() }\nfunc provideCleanup(botLottery *service.BotLotteryService) { botLottery.Stop() }\n',
  'frontend/src/views/HomeView.vue': '<template>\n<header>Base home</header>\n' + '<section>Content</section>\n'.repeat(12) + '<footer>Base footer</footer>\n</template>\n',
  'backend/internal/service/payment_order.go': 'package service\n// unchanged payment boundary\nconst paymentGuard = true\n' + '// preserved upstream context\n'.repeat(12) + 'const transportGuard = false\n',
  'frontend/src/original.ts': 'export const label = "原文"\n',
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qqbot-website-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.name', 'QQ Overlay Test'); git('config', 'user.email', 'qq-overlay@example.invalid'); git('config', 'core.autocrlf', 'false')
  const put = async (file, content) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content) }
  for (const [file, content] of Object.entries(baseFiles)) await put(file, content)
  git('add', '.'); git('commit', '-qm', 'website baseline')
  const base = git('rev-parse', 'HEAD').trim()
  const source = new Map(Object.entries(baseFiles))
  source.set('frontend/src/views/HomeView.vue', source.get('frontend/src/views/HomeView.vue').replace('Base home', 'QQ website home'))
  source.set('backend/internal/service/payment_order.go', source.get('backend/internal/service/payment_order.go').replace('transportGuard = false', 'transportGuard = true'))
  source.set('frontend/src/api/admin/botLottery.ts', 'export const lotteryEnabled = true\n')
  source.set('frontend/public/homepage-assets/hero.png', Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]))
  if (options.alterSource) options.alterSource(source)
  const paths = []
  for (const [file, content] of source) {
    if (content !== baseFiles[file]) { await put(file, content); paths.push(file) }
  }
  for (const [file, content] of [
    [HELPER_FILES[0], await readFile(scriptPath)],
    [HELPER_FILES[1], await readFile(testPath)],
    [MANIFEST_PATH, JSON.stringify({ base_sha: base, paths: options.manifestPaths ? options.manifestPaths(paths) : paths }, null, 2) + '\n'],
  ]) await put(file, content)
  git('add', '.'); git('commit', '-qm', 'QQ website features'); git('branch', 'QQbot')
  git('checkout', '--detach', '-q', base)
  let home = baseFiles['frontend/src/views/HomeView.vue'].replace('Base footer', 'Current upstream footer')
  if (options.crlf) home = home.replaceAll('\n', '\r\n')
  await put('frontend/src/views/HomeView.vue', home)
  await put('backend/internal/service/payment_order.go', baseFiles['backend/internal/service/payment_order.go'].replace('paymentGuard = true', 'paymentGuard = secureUpstreamDefault'))
  const allPaths = [...new Set([...Object.keys(baseFiles), ...source.keys(), ...HELPER_FILES])]
  const snapshot = async () => new Map(await Promise.all(allPaths.map(async (file) => {
    try { return [file, (await readFile(path.join(root, file))).toString('hex')] } catch (error) { if (error.code !== 'ENOENT') throw error; return [file, null] }
  })))
  const run = (...args) => execFileSync(process.execPath, [scriptPath, '--root', root, '--ref', 'QQbot', ...args], { encoding: 'utf8', stdio: 'pipe' })
  return { root, put, run, snapshot, git }
}

for (const crlf of [false, true]) {
  test('merges all website features while preserving upstream and legacy bot integration' + (crlf ? ' with CRLF' : ''), async (t) => {
    const f = await fixture(t, { crlf })
    assert.match(f.run(), /Applied QQbot website overlay/)
    const home = await readFile(path.join(f.root, 'frontend/src/views/HomeView.vue'), 'utf8')
    assert.match(home, /QQ website home/); assert.match(home, /Current upstream footer/)
    if (crlf) assert.equal(home.replaceAll('\r\n', '').includes('\n'), false)
    const payment = await readFile(path.join(f.root, 'backend/internal/service/payment_order.go'), 'utf8')
    assert.match(payment, /paymentGuard = secureUpstreamDefault/); assert.match(payment, /transportGuard = true/)
    assert.equal(await readFile(path.join(f.root, 'frontend/src/original.ts'), 'utf8'), baseFiles['frontend/src/original.ts'])
    assert.deepEqual(await readFile(path.join(f.root, 'frontend/public/homepage-assets/hero.png')), Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]))
    for (const file of HELPER_FILES) assert.ok((await readFile(path.join(f.root, file))).length > 0)
    const before = await f.snapshot(); assert.match(f.run('--check'), /Verified QQbot website overlay/); assert.deepEqual(await f.snapshot(), before)
    f.run(); assert.deepEqual(await f.snapshot(), before, 'a repeated application must be idempotent')
  })
}

test('check reports a missing overlay without any target writes', async (t) => {
  const f = await fixture(t); const before = await f.snapshot()
  assert.throws(() => f.run('--check'), /overlay is not current/); assert.deepEqual(await f.snapshot(), before)
})

test('preflights every file and never partially copies on a text conflict', async (t) => {
  const f = await fixture(t)
  await f.put('frontend/src/views/HomeView.vue', baseFiles['frontend/src/views/HomeView.vue'].replace('Base home', 'Different generated home'))
  const before = await f.snapshot(); assert.throws(() => f.run(), /Three-way merge conflict/); assert.deepEqual(await f.snapshot(), before)
})

test('rejects collisions for newly introduced binary assets', async (t) => {
  const f = await fixture(t); await f.put('frontend/public/homepage-assets/hero.png', Buffer.from([0, 9, 9, 9]))
  const before = await f.snapshot(); assert.throws(() => f.run(), /New source file collides/); assert.deepEqual(await f.snapshot(), before)
})

for (const forbidden of ['frontend/.env.production', 'backend/config.local.yaml', 'frontend/../outside.ts', 'scripts/unsafe.mjs', 'backend/private.pem']) {
  test('rejects an unsafe or sensitive reviewed path: ' + forbidden, async (t) => {
    const f = await fixture(t, { manifestPaths: (paths) => [...paths, forbidden] }); const before = await f.snapshot()
    assert.throws(() => f.run(), /Unsafe manifest path|outside the reviewed website scope|Sensitive or generated path/); assert.deepEqual(await f.snapshot(), before)
  })
}

test('rejects omitted changed application files', async (t) => {
  const f = await fixture(t, { manifestPaths: (paths) => paths.filter((file) => !file.endsWith('botLottery.ts')) }); const before = await f.snapshot()
  assert.throws(() => f.run(), /manifest omits a changed website file/); assert.deepEqual(await f.snapshot(), before)
})

test('rejects invalid UTF-8 without writing another planned file', async (t) => {
  const f = await fixture(t, { alterSource: (source) => source.set('frontend/src/broken.ts', Buffer.from([255, 254])) }); const before = await f.snapshot()
  assert.throws(() => f.run(), /Invalid UTF-8/); assert.deepEqual(await f.snapshot(), before)
})

test('rejects embedded private keys without echoing their contents', async (t) => {
  const canary = 'never-print-this-fixture-key'
  const f = await fixture(t, { alterSource: (source) => source.set('frontend/src/private.txt', '-----BEGIN ' + 'PRIVATE KEY-----\n' + canary + '\n') }); const before = await f.snapshot()
  try { f.run(); assert.fail('expected secret rejection') } catch (error) { assert.match(String(error.stderr), /Potential embedded credential rejected/); assert.ok(!String(error.stderr).includes(canary)); assert.ok(!String(error.stdout).includes(canary)) }
  assert.deepEqual(await f.snapshot(), before)
})

for (const [name, file, transform] of [
  ['administrator authentication', 'backend/internal/server/routes/bot_lottery.go', (value) => value.replace(' bot.Use(gin.HandlerFunc(adminAuth))\n', '')],
  ['bound-user authentication', 'backend/internal/server/routes/bot_recharge.go', (value) => value.replace(' bot.Use(gin.HandlerFunc(botAuth))\n', '')],
  ['administrator-first middleware order', 'backend/internal/server/routes/bot.go', (value) => value.replace(' bot.Use(gin.HandlerFunc(adminAuth))\n bot.Use(gin.HandlerFunc(botAuth))', ' bot.Use(gin.HandlerFunc(botAuth))\n bot.Use(gin.HandlerFunc(adminAuth))')],
]) {
  test('preserves existing bot ' + name, async (t) => {
    const f = await fixture(t, { alterSource: (source) => source.set(file, transform(baseFiles[file])) }); const before = await f.snapshot()
    assert.throws(() => f.run(), /Required integration or security anchor/); assert.deepEqual(await f.snapshot(), before)
  })
}

test('rejects removal of a legacy bot capability', async (t) => {
  const f = await fixture(t, { alterSource: (source) => source.set('backend/internal/handler/wire.go', baseFiles['backend/internal/handler/wire.go'].replace(' h.SetConcurrencyReader(concurrencyCache)\n', '')) }); const before = await f.snapshot()
  assert.throws(() => f.run(), /existing SetConcurrencyReader/); assert.deepEqual(await f.snapshot(), before)
})

test('workflow stages the source helper and verifies older layers before the website delta', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/upstream-theme-sync.yml', import.meta.url), 'utf8')
  assert.ok(workflow.indexOf('Verify legacy overlays before QQ website integration') < workflow.indexOf('Apply QQ website integration'))
  assert.match(workflow, /git show origin\/QQbot:scripts\/apply-qqbot-website\.mjs/)
  assert.match(workflow, /git fetch --unshallow origin/)
  assert.match(workflow, /apply-qqbot-website\.mjs" --root .* --ref origin\/QQbot --check/)
})
