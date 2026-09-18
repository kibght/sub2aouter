#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { applySourceOverlay } from './lib/source-overlay.mjs'

const manifest = JSON.parse(await readFile(new URL('./lib/billing-overdraft-patches.json', import.meta.url), 'utf8'))
export const BILLING_OVERDRAFT_PATCHES = Object.freeze(manifest.patches)
export const BILLING_OVERDRAFT_COPY_FILES = Object.freeze(manifest.files)
const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

export async function applyBillingOverdraft({ root, sourceRoot = repositoryRoot, check = false }) {
  const resolvedRoot = path.resolve(root)
  const writes = new Map()
  for (const entry of BILLING_OVERDRAFT_PATCHES) {
    const target = path.join(resolvedRoot, entry.target)
    const original = await readFile(target, 'utf8')
    const normalized = original.replaceAll('\r\n', '\n')
    const result = applySourceOverlay(normalized, entry)
    if (result !== normalized) {
      if (check) throw new Error(`Billing overdraft patch drift detected in ${entry.target}`)
      writes.set(target, original.includes('\r\n') ? result.replaceAll('\n', '\r\n') : result)
    }
  }
  for (const relative of BILLING_OVERDRAFT_COPY_FILES) {
    const source = await readFile(path.join(sourceRoot, relative))
    const target = path.join(resolvedRoot, relative)
    let existing = null
    try { existing = await readFile(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (existing && existing.equals(source)) continue
    if (check) throw new Error(`Billing overdraft copied file drift detected in ${relative}`)
    writes.set(target, source)
  }
  // Validate every target before changing any file, including on an upstream drift.
  for (const [target, content] of writes) {
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return { changed: writes.size > 0 }
}

async function main() {
  const args = process.argv.slice(2)
  const rootIndex = args.indexOf('--root')
  const sourceIndex = args.indexOf('--source')
  const root = rootIndex >= 0 ? args[rootIndex + 1] : args[0]
  const sourceRoot = sourceIndex >= 0 ? args[sourceIndex + 1] : repositoryRoot
  if (!root) throw new Error('Usage: node scripts/apply-billing-overdraft.mjs --root <path> [--source <path>] [--check]')
  const result = await applyBillingOverdraft({ root, sourceRoot, check: args.includes('--check') })
  console.log(result.changed ? 'Applied billing overdraft policy.' : 'Billing overdraft policy already current.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
