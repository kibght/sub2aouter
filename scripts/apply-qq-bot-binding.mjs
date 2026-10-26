#!/usr/bin/env node

// Apply the unified QQ bot delta after the legacy bot-binding overlay.
// The source branch is a single commit on top of the original binding source,
// so its parent is a stable patch base and the generated upstream tree keeps
// all unrelated upstream changes.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

function fail(message) {
  console.error('apply-qq-bot-binding: ' + message)
  process.exit(1)
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
  console.log('Verified QQ bot binding overlay from ' + ref + ' (base ' + baseRef + ').')
  process.exit(0)
}

if (existsSync(path.join(root, marker))) {
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
    'backend/internal/server/router.go',
  ])
  if (conflicts.length === 0 || conflicts.some((file) => !expected.has(file))) {
    fail('cannot apply QQ bot delta: ' + (error.stderr?.toString() || error.message))
  }

  // The generated wire/router files already contain the legacy binding
  // overlay. Their unified-branch versions include the same base plus the
  // QQ-specific wiring, so use those complete files only for these known
  // generated-file conflicts and keep all other upstream files untouched.
  try {
    git(['checkout', '--theirs', '--', ...conflicts])
    git(['add', '--', ...conflicts])
  } catch (resolveError) {
    fail('cannot resolve QQ bot generated-file conflicts: ' + (resolveError.stderr?.toString() || resolveError.message))
  }
}

if (!existsSync(path.join(root, marker))) {
  fail('QQ balance-alert integration is still missing after applying the delta')
}

console.log('Applied QQ bot balance-alert delta from ' + ref + ' (base ' + baseRef + ').')
