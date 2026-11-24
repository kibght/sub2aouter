import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { applyBalanceNotificationReliability } from '../apply-balance-notification-reliability.mjs'

const servicePath = 'backend/internal/service/balance_notify_service.go'
const newPath = 'backend/internal/service/balance_notification_reliability.go'
const routePath = 'backend/internal/server/routes/bot.go'
const baseService = 'package service\nconst delivery = "old"\n' + '// upstream context\n'.repeat(15) + 'const upstream = "old"\n'

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'balance-notification-overlay-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  const put = async (file, value) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), value) }
  git('init', '-q'); git('config', 'user.name', 'Overlay Test'); git('config', 'user.email', 'overlay@example.invalid'); git('config', 'core.autocrlf', 'false')
  await put(servicePath, baseService)
  await put(routePath, 'bot := v1.Group("/bot")\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  await put(servicePath, baseService.replace('delivery = "old"', 'delivery = "reliable"'))
  await put(newPath, options.invalidUTF8 ? Buffer.from([255]) : 'package service\nconst durableDelivery = true\n')
  if (options.unreviewed) await put(routePath, 'bot := v1.Group("/unsafe")\n')
  git('add', '.'); git('commit', '-qm', 'reliability'); git('branch', 'fix/reliability')
  git('checkout', '--detach', '-q', base)
  let generated = baseService.replace('upstream = "old"', 'upstream = "current"')
  if (options.crlf) generated = generated.replaceAll('\n', '\r\n')
  await put(servicePath, generated)
  await put(routePath, 'bot := v1.Group("/admin/bot")\n')
  const manifest = { base_sha: base, paths: [servicePath, newPath] }
  const verify = (read) => assert.match(read(routePath), /\/admin\/bot/)
  const run = (args = {}) => applyBalanceNotificationReliability({ root, ref: 'fix/reliability', manifest, verify, ...args })
  const snapshot = async () => Promise.all([servicePath, newPath, routePath].map(async (file) => {
    try { return (await readFile(path.join(root, file))).toString('hex') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }))
  return { root, put, run, manifest, snapshot }
}

for (const crlf of [false, true]) {
  test('merges only the notification delta, preserves migrated QQ routes and upstream edits' + (crlf ? ' with CRLF' : ''), async (t) => {
    const f = await fixture(t, { crlf })
    assert.equal((await f.run()).changed, true)
    const service = await readFile(path.join(f.root, servicePath), 'utf8')
    assert.match(service, /delivery = "reliable"/); assert.match(service, /upstream = "current"/)
    if (crlf) assert.equal(service.replaceAll('\r\n', '').includes('\n'), false)
    const before = await f.snapshot()
    assert.equal((await f.run({ check: true })).changed, false)
    assert.equal((await f.run()).changed, false)
    assert.deepEqual(await f.snapshot(), before)
  })
}

test('check and conflicting source updates never partially write the generated tree', async (t) => {
  const f = await fixture(t), before = await f.snapshot()
  await assert.rejects(f.run({ check: true }), /overlay is not current/)
  assert.deepEqual(await f.snapshot(), before)
  await f.put(servicePath, baseService.replace('delivery = "old"', 'delivery = "different"'))
  const conflicting = await f.snapshot()
  await assert.rejects(f.run(), /Three-way notification merge conflict/)
  assert.deepEqual(await f.snapshot(), conflicting)
})

test('unreviewed source changes cannot alter migrated routes', async (t) => {
  const f = await fixture(t, { unreviewed: true }), before = await f.snapshot()
  await assert.rejects(f.run(), /unreviewed/)
  assert.deepEqual(await f.snapshot(), before)
})

test('invalid UTF-8 and integration guard failures leave every source untouched', async (t) => {
  const f = await fixture(t, { invalidUTF8: true }), before = await f.snapshot()
  await assert.rejects(f.run(), /Invalid UTF-8/)
  assert.deepEqual(await f.snapshot(), before)
  const valid = await fixture(t), validBefore = await valid.snapshot()
  await assert.rejects(valid.run({ verify: () => { throw new Error('missing QQ capability') } }), /missing QQ capability/)
  assert.deepEqual(await valid.snapshot(), validBefore)
})

test('manifest paths cannot escape the reviewed notification subsystem', async (t) => {
  const f = await fixture(t), before = await f.snapshot()
  for (const forbidden of ['../outside.go', routePath, 'backend/internal/service/../../outside.go']) {
    await assert.rejects(f.run({ manifest: { ...f.manifest, paths: [...f.manifest.paths, forbidden] } }), /scope|Unsafe/)
  }
  assert.deepEqual(await f.snapshot(), before)
})
