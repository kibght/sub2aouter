#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TextDecoder } from 'node:util'

export const DEFAULT_REF = 'origin/fix/balance-notification-reliability'
export const MANIFEST_PATH = fileURLToPath(new URL('./balance-notification-overlay.json', import.meta.url))
const utf8 = new TextDecoder('utf-8', { fatal: true })
const normalize = (value) => value.replaceAll('\r\n', '\n')
const same = (left, right) => left === null ? right === null : right !== null && normalize(left) === normalize(right)
const fail = (message) => { throw new Error(message) }

function git(root, args, accepted = [0]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: null, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (result.error || !accepted.includes(result.status)) fail('Git operation failed: ' + args[0])
  return result
}

function decode(data, label) {
  try { return utf8.decode(data) } catch { fail('Invalid UTF-8 in ' + label) }
}

function targetPath(root, file) {
  if (typeof file !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(file) || file.startsWith('/') || file.split('/').some((part) => !part || part === '.' || part === '..')) fail('Unsafe notification path')
  let current = root
  const parts = file.split('/')
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    let info
    try { info = lstatSync(current) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) fail('Target contains a link or non-file path: ' + file)
  }
  return current
}

function sourceText(root, ref, file) {
  const entry = decode(git(root, ['ls-tree', ref, '--', file]).stdout, 'source tree').trim()
  if (!entry) return null
  if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(entry)) fail('Source is not a regular file: ' + file)
  return decode(git(root, ['show', ref + ':' + file]).stdout, file)
}

function currentText(root, file) {
  const target = targetPath(root, file)
  return existsSync(target) ? decode(readFileSync(target), file) : null
}

function mergeText(root, file, ours, base, theirs) {
  if (same(ours, theirs) || same(base, theirs)) return ours
  if (base === null) {
    if (ours !== null) fail('New notification file collides with generated source: ' + file)
    return theirs
  }
  if (ours === null || theirs === null) fail('Notification overlay cannot remove existing source: ' + file)
  if (same(ours, base)) return ours.includes('\r\n') ? normalize(theirs).replaceAll('\n', '\r\n') : theirs
  const temp = mkdtempSync(path.join(os.tmpdir(), 'balance-notification-merge-'))
  try {
    const paths = ['generated', 'base', 'notification'].map((name) => path.join(temp, name))
    for (const [index, value] of [ours, base, theirs].entries()) writeFileSync(paths[index], normalize(value), 'utf8')
    const result = git(root, ['merge-file', '-p', '--diff3', ...paths], Array.from({ length: 128 }, (_, index) => index))
    if (result.status !== 0) fail('Three-way notification merge conflict: ' + file)
    let merged = decode(result.stdout, file)
    if (/^(?:<<<<<<< |\|\|\|\|\|\|\| |=======\s*$|>>>>>>> )/m.test(merged)) fail('Unresolved notification merge marker: ' + file)
    if (ours.includes('\r\n') && !ours.replaceAll('\r\n', '').includes('\n')) merged = merged.replaceAll('\n', '\r\n')
    return merged
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

export async function applyBalanceNotificationReliability({ root, ref = DEFAULT_REF, check = false, manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')), verify }) {
  root = realpathSync(path.resolve(root))
  if (typeof ref !== 'string' || ref.startsWith('-') || /[\x00-\x20]/.test(ref)) fail('Invalid notification source ref')
  if (!/^[a-f0-9]{40}$/.test(manifest.base_sha || '') || !Array.isArray(manifest.paths) || manifest.paths.length === 0 || manifest.paths.length > 40 || new Set(manifest.paths).size !== manifest.paths.length) fail('Invalid reviewed notification manifest')
  for (const file of manifest.paths) {
    if (!/^backend\/(?:cmd\/server\/|internal\/(?:service|repository)\/|migrations\/)[A-Za-z0-9_/-]+\.(?:go|sql)$/.test(file)) fail('Path is outside the reviewed notification scope')
    targetPath(root, file)
  }
  const source = decode(git(root, ['rev-parse', '--verify', ref + '^{commit}']).stdout, 'source revision').trim()
  git(root, ['merge-base', '--is-ancestor', manifest.base_sha, source])
  const changed = decode(git(root, ['diff', '--name-only', '-z', manifest.base_sha, source]).stdout, 'changed paths').split('\0').filter(Boolean)
  if (changed.length === 0 || changed.some((file) => !manifest.paths.includes(file))) fail('Notification source contains unreviewed or no changes')
  const planned = new Map()
  for (const file of manifest.paths) {
    const base = sourceText(root, manifest.base_sha, file), theirs = sourceText(root, source, file), ours = currentText(root, file)
    if (theirs === null) fail('Required notification source file is missing: ' + file)
    const merged = mergeText(root, file, ours, base, theirs)
    planned.set(file, { ours, merged })
  }
  const read = (file) => {
    const value = planned.has(file) ? planned.get(file).merged : currentText(root, file)
    if (value === null) fail('Required integration file is missing: ' + file)
    return value
  }
  if (verify) await verify(read)
  const changes = [...planned].filter(([, value]) => !same(value.ours, value.merged))
  if (check) {
    if (changes.length) fail('Notification overlay is not current: ' + changes.map(([file]) => file).join(', '))
  } else {
    for (const [file] of changes) targetPath(root, file)
    for (const [file, value] of changes) {
      const target = targetPath(root, file)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, value.merged, 'utf8')
    }
  }
  return { source, changed: changes.length > 0, files: changes.map(([file]) => file) }
}

async function main() {
  const args = process.argv.slice(2)
  const value = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback }
  const root = path.resolve(value('--root', '.'))
  // Verify only the QQ capability anchors after composing the notification delta;
  // replaying the earlier whole QQ overlay could conflict with shared service edits.
  const { verifyRequiredAnchors } = await import(pathToFileURL(path.join(root, 'scripts/apply-qqbot-website.mjs')).href)
  const check = args.includes('--check')
  const result = await applyBalanceNotificationReliability({ root, ref: value('--ref', DEFAULT_REF), check, verify: verifyRequiredAnchors })
  console.log((check ? 'Verified' : result.changed ? 'Applied' : 'Preserved') + ' balance notification reliability overlay from ' + result.source + '.')
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try { await main() } catch (error) { console.error('apply-balance-notification-reliability: ' + error.message); process.exitCode = 1 }
}
