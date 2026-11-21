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

function mergeText(root, file, ours, base, theirs) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'qqbot-website-overlay-'))
  try {
    const files = ['generated', 'base', 'source'].map((name) => path.join(temp, name))
    for (const [index, value] of [ours, base, theirs].entries()) writeFileSync(files[index], normalized(value), 'utf8')
    const result = git(root, ['merge-file', '-p', '--diff3', '-L', 'generated', '-L', 'manifest-base', '-L', 'QQbot', ...files], { accept: Array.from({ length: 128 }, (_, index) => index) })
    if (result.status !== 0) fail('Three-way merge conflict in ' + file)
    let merged = text(result.stdout, file)
    if (/^(?:<<<<<<< |\|\|\|\|\|\|\| |=======\s*$|>>>>>>> )/m.test(merged)) fail('Unresolved merge markers in ' + file)
    if (ours.includes('\r\n') && !ours.replaceAll('\r\n', '').includes('\n')) merged = merged.replaceAll('\n', '\r\n')
    return Buffer.from(merged, 'utf8')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function mergedFile(root, file, ours, base, theirs) {
  if (equalBytes(ours, theirs) || equalBytes(base, theirs)) return ours
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
    const admin = routes.search(/bot\.Use\(\s*gin\.HandlerFunc\(\s*adminAuth\s*\)/)
    const binding = routes.indexOf('gin.HandlerFunc(botAuth)')
    const limit = routes.indexOf('panelRateLimiter.Global()')
    const endpoint = routes.search(/bot\.(?:GET|POST|PUT|DELETE)\(/)
    if (admin < 0 || binding < admin || limit < binding || endpoint < limit) fail('Required integration or security anchor is missing: ordered dual authentication in ' + file)
  }
  const routes = read('backend/internal/server/routes/bot.go')
  for (const endpoint of ['check-in', 'balance-alerts', 'personal-info']) requireMarker(routes, new RegExp('bot\\.(?:GET|POST)\\(\\s*"/' + endpoint + '"'), 'existing bot ' + endpoint + ' endpoint')
  requireMarker(routes, /bot\.GET\(\s*"\/personal-info"\s*,\s*panelRateLimiter\.Heavy\(\)/, 'personal-info heavy rate limit')
  requireMarker(routes, /v1\.POST\(\s*"\/bot-bindings\/redeem"\s*,\s*gin\.HandlerFunc\(\s*adminAuth\s*\)/, 'binding redemption administrator authentication')
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

  const planned = new Map()
  for (const file of paths) {
    const base = blob(root, manifest.base_sha, file)
    const theirs = blob(root, source, file)
    const ours = readTarget(root, file)
    if (theirs) assertNoEmbeddedSecret(theirs.data, file)
    const merged = mergedFile(root, file, ours, base?.data ?? null, theirs?.data ?? null)
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
