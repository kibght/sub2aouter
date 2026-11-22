#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

export const MANIFEST_PATH = '.qqbot-website-overlay.json'
export const HELPER_FILES = [
  'scripts/apply-qqbot-website.mjs',
  'scripts/__tests__/qqbot-website-overlay.test.mjs',
  MANIFEST_PATH,
]

const utf8 = new TextDecoder('utf-8', { fatal: true })
const textExtensions = new Set(['.go', '.vue', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.sql', '.css', '.html', '.svg', '.yaml', '.yml', '.toml', '.txt', '.mod', '.sum'])
const fail = (message) => { throw new Error(message) }
const normalized = (text) => text.replaceAll('\r\n', '\n')
const equalBytes = (left, right) => left === null ? right === null : right !== null && left.equals(right)
const trees = new Map()
const blobs = new Map()

function git(root, args, { accept = [0] } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: null, maxBuffer: 128 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (result.error || !accept.includes(result.status)) fail('Git operation failed: ' + args[0])
  return result
}

function text(data, label) {
  try { return utf8.decode(data) } catch { fail('Invalid UTF-8 in ' + label) }
}

function assertApplicationPath(file) {
  if (typeof file !== 'string' || file === '' || file.includes('\\') || file.includes('\0') || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split('/').some((part) => part === '' || part === '.' || part === '..')) fail('Unsafe manifest path')
  const parts = file.split('/')
  const name = parts.at(-1)
  if (!['backend', 'frontend', 'theme', 'assets', 'docs'].includes(parts[0]) && !['.gitignore', '.gitattributes'].includes(file)) fail('Path is outside the reviewed website scope: ' + file)
  if (parts.some((part) => ['.git', '.worktrees', 'node_modules', 'artifacts', 'output', 'backups', '.codex'].includes(part)) || /^\.env(?:\.|$)/i.test(name) || /(?:^|\.)local(?:\.|$)/i.test(name) || /^(?:server-info|credentials|secrets)(?:\.|$)/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name) || /^id_(?:rsa|ed25519|ecdsa)/i.test(name)) fail('Sensitive or generated path is forbidden: ' + file)
}

function blob(root, ref, file, { required = false } = {}) {
  const key = root + '\0' + ref
  if (!trees.has(key)) {
    const entries = new Map()
    for (const value of text(git(root, ['ls-tree', '-r', '-z', ref]).stdout, 'source tree').split('\0').filter(Boolean)) {
      const match = value.match(/^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]+)$/)
      if (!match) fail('Invalid source tree entry')
      entries.set(match[4], { mode: match[1], type: match[2], hash: match[3] })
    }
    trees.set(key, entries)
  }
  const entry = trees.get(key).get(file)
  if (!entry) {
    if (required) fail('Required source file is missing: ' + file)
    return null
  }
  if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('Source must be a regular tracked file: ' + file)
  if (!blobs.has(entry.hash)) blobs.set(entry.hash, git(root, ['cat-file', 'blob', entry.hash]).stdout)
  return { data: blobs.get(entry.hash), mode: entry.mode === '100755' ? 0o755 : 0o644 }
}

function safeTarget(root, file) {
  const target = path.resolve(root, ...file.split('/'))
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('Target escapes the generated tree')
  let current = root
  const components = file.split('/')
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index])
    let info
    try { info = lstatSync(current) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (info.isSymbolicLink() || (index < components.length - 1 && !info.isDirectory()) || (index === components.length - 1 && !info.isFile())) fail('Target contains a link or non-file path: ' + file)
  }
  return target
}

function readTarget(root, file) {
  const target = safeTarget(root, file)
  if (!existsSync(target)) return null
  return readFileSync(target)
}

function decodedText(data, file) {
  if (data === null) return null
  if (data.includes(0)) {
    if (textExtensions.has(path.extname(file))) fail('Invalid text encoding in ' + file)
    return null
  }
  try { return utf8.decode(data) } catch {
    if (textExtensions.has(path.extname(file))) fail('Invalid UTF-8 in ' + file)
    return null
  }
}

function assertNoEmbeddedSecret(data, file) {
  const value = decodedText(data, file)
  if (value !== null && (/^\s*-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----\s*$/m.test(value) || /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/.test(value) || /\bgithub_pat_[A-Za-z0-9_]{50,}\b/.test(value))) fail('Potential embedded credential rejected in ' + file)
}

function additions(base, ours, theirs, label) {
  const gaps = (items) => {
    let position = 0
    const result = []
    for (const anchor of base) {
      const next = items.indexOf(anchor, position)
      if (next < 0) fail('Shared composer refuses removal or replacement in ' + label)
      result.push(items.slice(position, next)); position = next + 1
    }
    result.push(items.slice(position)); return result
  }
  const left = gaps(ours), right = gaps(theirs), output = []
  for (let index = 0; index <= base.length; index += 1) {
    for (const item of [...left[index], ...right[index], ...(index < base.length ? [base[index]] : [])]) if (!output.includes(item)) output.push(item)
  }
  for (const items of [ours, theirs]) {
    let previous = -1
    for (const item of items) { const position = output.indexOf(item); if (position <= previous) fail('Shared composer found an order conflict in ' + label); previous = position }
  }
  return output
}

const constructor = /^\s*([A-Za-z_]\w*) := ([A-Za-z_]\w*\.[A-Za-z_]\w*)\(([A-Za-z_]\w*(?:,\s*[A-Za-z_]\w*)*)?\)\s*$/
const newBotConstructors = new Map([
  ['botLotteryRepository', 'repository.NewBotLotteryRepository(db)'],
  ['botLotteryService', 'service.ProvideBotLotteryService(botLotteryRepository,billingCacheService,apiKeyAuthCacheInvalidator)'],
  ['botLotteryHandler', 'handler.NewBotLotteryHandler(botLotteryService)'],
  ['botRechargeRepository', 'repository.NewBotRechargeRepository(db)'],
  ['botRechargeService', 'service.NewBotRechargeService(paymentService,paymentConfigService,botRechargeRepository)'],
  ['botRechargeHandler', 'handler.NewBotRechargeHandler(botRechargeService)'],
])

function parseConstructors(lines, label) {
  return lines.filter((line) => line.trim()).map((line) => {
    const match = line.match(constructor)
    if (!match) fail('Unsupported shared constructor in ' + label)
    return { name: match[1], callee: match[2], args: match[3] ? match[3].split(',').map((item) => item.trim()) : [], line }
  })
}

function composeGeneratedWire(block, context) {
  const base = parseConstructors(block.base, 'base Wire block'), ours = parseConstructors(block.ours, 'generated Wire block'), theirs = parseConstructors(block.theirs, 'QQ Wire block')
  const baseByName = new Map(base.map((entry) => [entry.name, entry]))
  const current = new Map(context.ours.split('\n').map((line) => line.match(constructor)).filter(Boolean).map((match) => [match[1], match[2] + '(' + (match[3] || '').replaceAll(/\s/g, '') + ')']))
  const output = ours.filter((entry) => entry.name !== 'handlers').map((entry) => entry.line)
  const names = new Set(ours.map((entry) => entry.name))
  for (const entry of theirs.filter((entry) => entry.name !== 'handlers')) {
    const canonical = entry.callee + '(' + entry.args.join(',') + ')'
    const original = baseByName.get(entry.name)
    if (entry.name === 'botHandler') {
      const actual = ours.find((item) => item.name === entry.name)
      if (!actual || actual.callee !== entry.callee || entry.args.some((arg) => !actual.args.includes(arg))) fail('Generated bot handler lost a maintained dependency')
      continue
    }
    if (original) {
      if (original.callee + '(' + original.args.join(',') + ')' !== canonical || !current.has(entry.name)) fail('Shared composer refuses a changed maintained Wire constructor: ' + entry.name)
      continue
    }
    if (newBotConstructors.get(entry.name) !== canonical) fail('Shared composer refuses an unknown new Wire constructor: ' + entry.name)
    if (current.has(entry.name)) {
      if (current.get(entry.name) !== canonical) fail('Shared composer found a different existing Wire constructor: ' + entry.name)
      continue
    }
    if (!names.has(entry.name)) { output.push(entry.line); names.add(entry.name) }
  }
  const handler = (items) => { const rows = items.filter((item) => item.name === 'handlers' && item.callee === 'handler.ProvideHandlers'); if (rows.length !== 1) fail('Expected one generated Handlers construction'); return rows[0] }
  const baseHandler = handler(base), ourHandler = handler(ours), theirHandler = handler(theirs)
  if (theirHandler.args.some((arg) => !baseHandler.args.includes(arg) && !['botLotteryHandler', 'botRechargeHandler'].includes(arg))) fail('Unexpected source Handlers dependency')
  output.push('\thandlers := handler.ProvideHandlers(' + additions(baseHandler.args, ourHandler.args, theirHandler.args, 'Handlers arguments').join(', ') + ')')
  return output
}

function composeBotFields(block, context) {
  const parseFields = (lines) => {
    const fields = new Map()
    for (const line of lines) { const match = line.match(/^\s*([A-Za-z_]\w*)\s+([A-Za-z_][\w.*\[\]]*)\s*$/); if (!match) fail('Unsupported BotHandler field conflict'); if (fields.has(match[1])) fail('Duplicate BotHandler field'); fields.set(match[1], match[2]) }
    return fields
  }
  const end = block.theirs.findIndex((line) => line.trim() === '}')
  if (end < 0) fail('Unsupported BotHandler field layout')
  const ours = parseFields(block.ours), theirs = parseFields(block.theirs.slice(0, end)), base = parseFields(block.base)
  for (const [name, type] of base) if (ours.get(name) !== type || theirs.get(name) !== type) fail('A maintained BotHandler field was changed: ' + name)
  if (ours.size !== theirs.size || [...ours].some(([name, type]) => theirs.get(name) !== type)) fail('Different BotHandler field definitions require manual review')
  if (!/^}\s*func \(h \*BotHandler\) SetBalanceNotifyQQRepository\(repo service\.BalanceNotifyQQRepository\) \{\s*h\.balanceNotifyQQRepo = repo\s*$/.test(block.theirs.slice(end).join('\n'))) fail('Unsupported BotHandler setter conflict')
  if (!/func \(h \*BotHandler\) SetBalanceNotifyQQRepository\(repo service\.BalanceNotifyQQRepository\) \{\s*h\.balanceNotifyQQRepo = repo\s*}/.test(context.ours)) fail('Generated QQ setter is missing')
  return block.ours
}

function composeTestSuperset(block) {
  if (!block.ours.join('\n').includes('for _, test := range requests') || !block.theirs.join('\n').includes('for _, test := range requests')) fail('Unsupported bot route test conflict')
  const source = block.theirs.map((line) => line.trim())
  for (const line of block.ours.map((line) => line.trim()).filter((line) => line.startsWith('require.') || line.startsWith('{method:'))) {
    if (!source.includes(line)) fail('Source bot route tests would remove an existing assertion')
  }
  return block.theirs
}

function composeProperties(block) {
  if (block.base.some((line) => line.trim())) fail('Only additive form properties can be composed')
  const types = new Map(), output = []
  for (const line of [...block.ours, ...block.theirs]) {
    if (!line.trim()) continue
    const match = line.match(/^\s*([A-Za-z_]\w*):\s*([^;{}]+);\s*$/)
    if (!match) fail('Unsupported form property conflict')
    const type = match[2].replaceAll(/\s/g, '')
    if (types.has(match[1]) && types.get(match[1]) !== type) fail('Conflicting form property type: ' + match[1])
    if (!types.has(match[1])) { types.set(match[1], type); output.push(line) }
  }
  if (![...types.keys()].every((name) => ['home_hero_image', 'bot_checkin_required_tokens', 'bot_checkin_required_amount'].includes(name))) fail('Unexpected shared form property')
  return output
}

function composeIgnoreAdditions(block) {
  const nonempty = (lines) => lines.filter((line) => line.trim())
  const expected = [
    '.worktrees/',
    '# Reviewed standalone QQ bot plugin regression tests',
    '!integrations/qqbot/tests/',
    '!integrations/qqbot/tests/**',
    '/integrations/qqbot/**/__pycache__/',
    '/integrations/qqbot/**/*.py[cod]',
    '/integrations/qqbot/**/.pytest_cache/',
  ]
  if (JSON.stringify(nonempty(block.base)) !== JSON.stringify(['.worktrees/'])
    || JSON.stringify(nonempty(block.ours)) !== JSON.stringify(['!docs/bot-personal-info.md'])
    || JSON.stringify(nonempty(block.theirs)) !== JSON.stringify(expected)) {
    fail('Unsupported .gitignore conflict: only reviewed bot additions may be composed')
  }
  return [...block.ours, ...block.theirs]
}

export function composeSharedConflicts(file, merged, context) {
  const lines = merged.split('\n'), output = []
  let index = 0, needsRouter = false
  while (index < lines.length) {
    if (!lines[index].startsWith('<<<<<<< ')) { output.push(lines[index++]); continue }
    const block = { ours: [], base: [], theirs: [] }; index++
    for (const [part, delimiter] of [['ours', '||||||| '], ['base', '======='], ['theirs', '>>>>>>> ']]) {
      while (index < lines.length && !lines[index].startsWith(delimiter)) block[part].push(lines[index++])
      if (index >= lines.length) fail('Malformed shared merge conflict in ' + file)
      index++
    }
    let resolved
    if (file === '.gitignore') resolved = composeIgnoreAdditions(block)
    else if (file === 'backend/cmd/server/wire_gen.go') resolved = composeGeneratedWire(block, context)
    else if (file === 'backend/internal/handler/bot_handler.go') resolved = composeBotFields(block, context)
    else if (file === 'backend/internal/repository/wire.go') {
      if (block.base.some((line) => line.trim())) fail('Only additive repository providers can be composed')
      const entries = [...block.ours, ...block.theirs].filter((line) => line.trim())
      if (entries.some((line) => !/^\s*(?:NewBalanceNotifyQQRepository|NewBotLotteryRepository|NewBotRechargeRepository),\s*$/.test(line))) fail('Unsupported repository provider conflict')
      resolved = [...new Set(entries)]
    } else if (file === 'backend/internal/server/router.go') {
      if (block.ours.some((line) => line.trim()) || block.base.filter((line) => line.trim()).length !== 1 || !block.base[0].includes('routes.RegisterBotRoutes(') || block.theirs.filter((line) => line.trim()).length !== 3 || !block.theirs[1].includes('routes.RegisterBotLotteryRoutes(') || !block.theirs[2].includes('routes.RegisterBotRechargeRoutes(')) fail('Unsupported moved bot router conflict')
      resolved = []; needsRouter = true
    } else if (file === 'backend/internal/server/routes/bot_test.go') resolved = composeTestSuperset(block)
    else if (file === 'frontend/src/views/admin/SettingsView.vue') resolved = composeProperties(block)
    else fail('Three-way merge conflict in ' + file)
    output.push(...resolved)
  }
  let result = output.join('\n')
  if (file === 'backend/internal/handler/bot_handler.go') {
    const setter = context.ours.match(/func \(h \*BotHandler\) SetBalanceNotifyQQRepository\(repo service\.BalanceNotifyQQRepository\) \{\s*h\.balanceNotifyQQRepo = repo\s*}/)?.[0]
    if (setter && !result.includes('func (h *BotHandler) SetBalanceNotifyQQRepository(')) result = result.replace(/(type BotHandler struct \{[\s\S]*?\n})/, '$1\n\n' + setter)
  }
  if (file === 'backend/internal/repository/wire.go') {
    let seen = false
    result = result.split('\n').filter((line) => { if (!/^\s*NewBalanceNotifyQQRepository,\s*$/.test(line)) return true; if (seen) return false; seen = true; return true }).join('\n')
  }
  if (needsRouter) {
    const original = result.match(/^\troutes\.RegisterBotRoutes\([^\n]+\)$/gm)
    if (original?.length !== 1) fail('Expected one maintained bot router registration')
    const newLines = ['\troutes.RegisterBotLotteryRoutes(v1, h.BotLottery, adminAuth, botAuth, panelRateLimiter)', '\troutes.RegisterBotRechargeRoutes(v1, h.BotRecharge, adminAuth, botAuth, settingService, panelRateLimiter)']
    const missing = newLines.filter((line) => !result.includes(line))
    if (missing.length > 0) result = result.replace(original[0], original[0] + '\n' + missing.join('\n'))
  }
  return result
}

function composeMaintainedFields(file, data) {
  if (data === null) return data
  if (file === 'backend/internal/server/routes/bot.go') {
    const registrations = new Map()
    const result = text(data, file).split('\n').filter((line) => {
      const match = line.match(/^\s*bot\.(GET|POST)\("([^"]+)",\s*([^\n]+)\)\s*$/)
      if (!match) return true
      const key = match[1] + ' ' + match[2], args = match[3].replaceAll(/\s/g, '')
      if (!registrations.has(key)) { registrations.set(key, args); return true }
      if (!['GET /balance-alerts', 'POST /balance-alerts/:id/ack', 'GET /personal-info', 'POST /check-in'].includes(key) || registrations.get(key) !== args) fail('Different or unsupported duplicate bot endpoint: ' + key)
      return false
    }).join('\n')
    return Buffer.from(result, 'utf8')
  }
  if (file !== 'backend/internal/service/balance_notify_service.go') return data
  const original = text(data, file)
  const updated = original.replace(/type BalanceNotifyService struct \{[\s\S]*?\n}/, (block) => {
    let seen = false
    return block.split('\n').filter((line) => {
      if (!/^\s*qqNotificationRepo\s/.test(line)) return true
      if (!/^\s*qqNotificationRepo\s+BalanceNotifyQQRepository\s*$/.test(line)) fail('Maintained QQ notification field has a different type')
      if (seen) return false
      seen = true; return true
    }).join('\n')
  })
  return Buffer.from(updated, 'utf8')
}

export function migrateBotRoutePaths(file, value) {
  if (value === null) return value
  if (!/^(?:backend\/internal\/(?:server\/(?:routes\/bot(?:_lottery|_recharge)?(?:_test)?|middleware\/bot_auth_test)|handler\/bot(?:_handler|_personal_info)(?:_test)?)\.go|docs\/bot-(?:balance-alerts|personal-info)\.md)$/.test(file)) return value
  const source = Buffer.isBuffer(value) ? text(value, file) : value
  const migrated = source.replaceAll('/api/v1/bot/', '/api/v1/admin/bot/')
    .replaceAll('/api/v1/bot-bindings/redeem', '/api/v1/admin/bot-bindings/redeem')
    .replaceAll('"/bot/', '"/admin/bot/')
    .replaceAll('Group("/bot"', 'Group("/admin/bot"')
    .replaceAll('"/bot-bindings/redeem"', '"/admin/bot-bindings/redeem"')
  return Buffer.isBuffer(value) ? Buffer.from(migrated, 'utf8') : migrated
}

function mergeText(root, file, ours, base, theirs) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'qqbot-website-overlay-'))
  try {
    const files = ['generated', 'base', 'source'].map((name) => path.join(temp, name))
    for (const [index, value] of [ours, base, theirs].entries()) writeFileSync(files[index], normalized(value), 'utf8')
    const result = git(root, ['merge-file', '-p', '--diff3', '-L', 'generated', '-L', 'manifest-base', '-L', 'QQbot', ...files], { accept: Array.from({ length: 128 }, (_, index) => index) })
    let merged = text(result.stdout, file)
    if (result.status !== 0) merged = composeSharedConflicts(file, merged, { ours: normalized(ours), base: normalized(base), theirs: normalized(theirs) })
    if (/^(?:<<<<<<< |\|\|\|\|\|\|\| |=======\s*$|>>>>>>> )/m.test(merged)) fail('Unresolved merge markers in ' + file)
    if (ours.includes('\r\n') && !ours.replaceAll('\r\n', '').includes('\n')) merged = merged.replaceAll('\n', '\r\n')
    return Buffer.from(merged, 'utf8')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function mergedFile(root, file, ours, base, theirs) {
  if (equalBytes(ours, theirs) || equalBytes(base, theirs)) return ours
  if (ours !== null && theirs !== null) {
    const left = decodedText(ours, file), right = decodedText(theirs, file)
    if (left !== null && right !== null && normalized(left) === normalized(right)) return ours
  }
  if (base === null) {
    if (ours !== null) fail('New source file collides with an existing generated file: ' + file)
    return theirs
  }
  if (theirs === null) {
    if (ours === null || equalBytes(ours, base)) return null
    fail('Source deletion would remove generated changes: ' + file)
  }
  if (ours === null) fail('Generated tree removed a modified source file: ' + file)
  const sourceTexts = [ours, base, theirs].map((value) => decodedText(value, file))
  if (sourceTexts.some((value) => value === null)) {
    if (equalBytes(ours, base)) return theirs
    fail('Binary source would replace generated changes: ' + file)
  }
  return mergeText(root, file, ...sourceTexts)
}

function stripComments(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '')
}

function requireMarker(value, expression, label) {
  if (!expression.test(stripComments(value))) fail('Required integration or security anchor is missing: ' + label)
}

export function verifyRequiredAnchors(read) {
  for (const file of ['bot.go', 'bot_lottery.go', 'bot_recharge.go']) {
    const routes = stripComments(read('backend/internal/server/routes/' + file))
    requireMarker(routes, /bot\s*:=\s*v1\.Group\(\s*"\/admin\/bot"\s*\)/, 'administrator bot namespace in ' + file)
    const admin = routes.search(/bot\.Use\(\s*gin\.HandlerFunc\(\s*adminAuth\s*\)/)
    const binding = routes.indexOf('gin.HandlerFunc(botAuth)')
    const limit = routes.indexOf('panelRateLimiter.Global()')
    const endpoint = routes.search(/bot\.(?:GET|POST|PUT|DELETE)\(/)
    if (admin < 0 || binding < admin || limit < binding || endpoint < limit) fail('Required integration or security anchor is missing: ordered dual authentication in ' + file)
  }
  const routes = read('backend/internal/server/routes/bot.go')
  for (const endpoint of ['check-in', 'balance-alerts', 'personal-info']) requireMarker(routes, new RegExp('bot\\.(?:GET|POST)\\(\\s*"/' + endpoint + '"'), 'existing bot ' + endpoint + ' endpoint')
  requireMarker(routes, /bot\.GET\(\s*"\/personal-info"\s*,\s*panelRateLimiter\.Heavy\(\)/, 'personal-info heavy rate limit')
  requireMarker(routes, /v1\.POST\(\s*"\/admin\/bot-bindings\/redeem"\s*,\s*gin\.HandlerFunc\(\s*adminAuth\s*\)/, 'binding redemption administrator authentication')
  const provider = read('backend/internal/handler/wire.go')
  for (const setter of ['SetCheckInService', 'SetBalanceNotifyQQRepository', 'SetConcurrencyReader']) requireMarker(provider, new RegExp('h\\.' + setter + '\\('), 'existing ' + setter)
  for (const [file, markers] of [
    ['backend/internal/server/router.go', ['RegisterBotRoutes', 'RegisterBotLotteryRoutes', 'RegisterBotRechargeRoutes']],
    ['backend/internal/handler/handler.go', ['BotLottery', 'BotRecharge']],
    ['backend/internal/handler/wire.go', ['NewBotLotteryHandler', 'NewBotRechargeHandler']],
    ['backend/internal/repository/wire.go', ['NewBotLotteryRepository', 'NewBotRechargeRepository']],
    ['backend/internal/service/wire.go', ['ProvideBotLotteryService', 'NewBotRechargeService']],
    ['backend/cmd/server/wire_gen.go', ['ProvideBotLotteryService', 'NewBotRechargeService', 'BotLotteryService']],
  ]) {
    const value = read(file)
    for (const marker of markers) requireMarker(value, new RegExp('\\b' + marker + '\\b'), marker + ' in ' + file)
  }
  requireMarker(read('backend/internal/server/routes/bot_recharge.go'), /BackendModeUserGuard\(\s*settingService\s*\)/, 'recharge backend-mode guard')
  for (const file of ['backend/cmd/server/wire.go', 'backend/cmd/server/wire_gen.go']) requireMarker(read(file), /botLottery\.Stop\(\)/, 'lottery worker cleanup in ' + file)
}

export function applyQQbotWebsite({ root, ref = 'origin/QQbot', check = false }) {
  root = realpathSync(path.resolve(root))
  if (typeof ref !== 'string' || ref.startsWith('-') || /[\x00-\x20]/.test(ref)) fail('Invalid source ref')
  const source = text(git(root, ['rev-parse', '--verify', ref + '^{commit}']).stdout, 'source ref').trim()
  const manifestBlob = blob(root, source, MANIFEST_PATH, { required: true })
  let manifest
  try { manifest = JSON.parse(text(manifestBlob.data, MANIFEST_PATH)) } catch { fail('Invalid QQbot website manifest') }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(manifest.base_sha || '') || !Array.isArray(manifest.paths) || manifest.paths.length === 0 || manifest.paths.length > 2000) fail('Manifest requires a full base_sha and reviewed nonempty paths')
  const paths = new Set()
  for (const file of manifest.paths) { assertApplicationPath(file); if (paths.has(file)) fail('Duplicate manifest path: ' + file); paths.add(file) }
  if (git(root, ['merge-base', '--is-ancestor', manifest.base_sha, source], { accept: [0, 1] }).status !== 0) fail('Manifest base is not an ancestor of the QQbot source')
  const changed = text(git(root, ['diff', '--name-only', '-z', manifest.base_sha, source]).stdout, 'changed path list').split('\0').filter(Boolean)
  for (const file of changed) {
    try { assertApplicationPath(file) } catch { continue }
    if (!paths.has(file)) fail('Reviewed manifest omits a changed website file: ' + file)
  }

  const carriedBase = manifest.carried_base_sha
  if (carriedBase !== undefined) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(carriedBase) || carriedBase === manifest.base_sha || carriedBase === source
      || git(root, ['merge-base', '--is-ancestor', manifest.base_sha, carriedBase], { accept: [0, 1] }).status !== 0
      || git(root, ['merge-base', '--is-ancestor', carriedBase, source], { accept: [0, 1] }).status !== 0) fail('Reviewed carried_base_sha must be a source ancestor after the fixed manifest base')
  }

  const planned = new Map()
  for (const file of paths) {
    const base = blob(root, manifest.base_sha, file)
    const theirs = blob(root, source, file)
    const ours = readTarget(root, file)
    if (theirs) assertNoEmbeddedSecret(theirs.data, file)
    // Only files absent from the fixed base may use a reviewed earlier QQbot
    // snapshot. Fresh upstream files still install from the full feature delta.
    const carried = base === null && ours !== null && theirs !== null && carriedBase ? blob(root, carriedBase, file) : null
    const inputs = [ours, base?.data ?? carried?.data ?? null, theirs?.data ?? null].map((value) => migrateBotRoutePaths(file, value))
    const merged = composeMaintainedFields(file, mergedFile(root, file, ...inputs))
    planned.set(file, { data: merged, mode: theirs?.mode ?? base?.mode ?? 0o644, original: ours })
  }
  for (const file of HELPER_FILES) {
    const theirs = file === MANIFEST_PATH ? manifestBlob : blob(root, source, file, { required: true })
    assertNoEmbeddedSecret(theirs.data, file)
    planned.set(file, { data: theirs.data, mode: theirs.mode, original: readTarget(root, file) })
  }
  const read = (file) => {
    const data = planned.has(file) ? planned.get(file).data : readTarget(root, file)
    if (data === null) fail('Required generated integration file is missing: ' + file)
    return text(data, file)
  }
  verifyRequiredAnchors(read)
  const changes = [...planned].filter(([, value]) => !equalBytes(value.data, value.original))
  if (check) {
    if (changes.length > 0) fail('QQbot website overlay is not current: ' + changes.map(([file]) => file).join(', '))
    return { changed: false, source, files: [] }
  }
  // Validate the whole batch and all mandatory anchors before the first target write.
  for (const [file] of changes) safeTarget(root, file)
  for (const [file, value] of changes) {
    const target = safeTarget(root, file)
    if (value.data === null) { rmSync(target); continue }
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, value.data)
    if (value.original === null) chmodSync(target, value.mode)
  }
  return { changed: changes.length > 0, source, files: changes.map(([file]) => file) }
}

function main() {
  const argv = process.argv.slice(2)
  const value = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback }
  const check = argv.includes('--check')
  const result = applyQQbotWebsite({ root: value('--root', '.'), ref: value('--ref', 'origin/QQbot'), check })
  console.log((check ? 'Verified' : result.changed ? 'Applied' : 'Preserved') + ' QQbot website overlay from ' + result.source + '.')
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error('apply-qqbot-website: ' + error.message); process.exitCode = 1 }
}
