#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const ROOT = path.resolve(process.argv[2] || '.')
const UPSTREAM_REPOSITORY = process.env.UPSTREAM_REPOSITORY || 'https://github.com/Wei-Shaw/sub2api.git'
const PUSH_REMOTE = process.env.SYNC_PUSH_REMOTE || 'origin'
const TARGET_BRANCH = process.env.SYNC_TARGET_BRANCH || 'main'
const SYNC_WORK_BRANCH = process.env.SYNC_WORK_BRANCH || 'automation/upstream-release-sync'
const UPSTREAM_TAG = process.env.UPSTREAM_RELEASE_TAG || ''
const EXPECTED_UPSTREAM_SHA = process.env.UPSTREAM_SHA || ''
const INITIAL_UPSTREAM_TAG = process.env.INITIAL_UPSTREAM_RELEASE_TAG || ''
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const RELEASE_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+$/
const THEME_OWNED_SOURCE_PATHS = new Set([
  '.github/workflows/release.yml',
  '.gitignore',
  'README.md',
])
// Repository workflows are maintained by this project. Upstream workflow
// changes cannot be pushed by the GitHub App token and would overwrite the
// synchronization pipeline, so keep the whole directory out of the release
// delta.
const UPSTREAM_EXCLUDED_SOURCE_PATHS = ['.github/workflows/**']
const MERGED_SOURCE_PATHS = [
  'backend/cmd/server/wire_gen.go',
  'backend/internal/repository/wire.go',
  'backend/internal/service/wire.go',
]

function runGit(args, { input, quiet = false, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    input,
    encoding: null,
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })

  if (result.error) throw result.error
  if (!quiet && result.stdout?.length) process.stdout.write(result.stdout)
  if (result.status !== 0 && !allowFailure) {
    if (result.stderr?.length) process.stderr.write(result.stderr)
    throw new Error(`git ${args.join(' ')} failed with exit code ${result.status}`)
  }
  return result
}

function gitText(args) {
  return runGit(args, { quiet: true }).stdout.toString('utf8').trim()
}

function gitBlob(ref, file) {
  return runGit(['show', `${ref}:${file}`], { quiet: true }).stdout.toString('utf8')
}

function resolveConflictBlocks(text, resolver) {
  const lines = text.split(/\r?\n/)
  const output = []
  let index = 0
  while (index < lines.length) {
    if (!lines[index].startsWith('<<<<<<< ')) {
      output.push(lines[index])
      index += 1
      continue
    }

    const ours = []
    const base = []
    const theirs = []
    index += 1
    while (index < lines.length && !lines[index].startsWith('||||||| ') && !lines[index].startsWith('=======')) {
      ours.push(lines[index])
      index += 1
    }
    if (index < lines.length && lines[index].startsWith('||||||| ')) {
      index += 1
      while (index < lines.length && !lines[index].startsWith('=======')) {
        base.push(lines[index])
        index += 1
      }
    }
    if (index >= lines.length || !lines[index].startsWith('=======')) {
      throw new Error('Malformed merge conflict while synchronizing upstream source.')
    }
    index += 1
    while (index < lines.length && !lines[index].startsWith('>>>>>>> ')) {
      theirs.push(lines[index])
      index += 1
    }
    if (index >= lines.length) {
      throw new Error('Malformed merge conflict while synchronizing upstream source.')
    }
    index += 1
    output.push(...resolver({ ours, base, theirs }))
  }
  return output.join('\n')
}

function resolveWireConflict(file, merged) {
  return resolveConflictBlocks(merged, ({ ours, theirs }) => {
    if (file.endsWith('wire_gen.go')) {
      const upstreamLine = theirs.find((line) => line.includes('handlers := handler.ProvideHandlers('))
      const localLine = ours.find((line) => line.includes('handlers := handler.ProvideHandlers('))
      if (!upstreamLine || !localLine) {
        throw new Error(`Could not combine handler wiring in ${file}.`)
      }
      const combined = upstreamLine.replace(
        'batchImageHandler, idempotencyCoordinator',
        'batchImageHandler, botHandler, idempotencyCoordinator',
      )
      if (!combined.includes('botHandler')) {
        throw new Error(`Upstream handler wiring has no bot insertion point in ${file}.`)
      }
      return [combined]
    }

    const union = [...ours, ...theirs]
    const seen = new Set()
    return union.filter((line) => {
      if (!line.trim() || seen.has(line)) return false
      seen.add(line)
      return true
    })
  })
}

async function mergeSourceFile(baseSha, upstreamSha, file) {
  const currentPath = path.join(ROOT, file)
  if (!existsSync(currentPath)) return
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'sub2api-upstream-merge-'))
  const basePath = path.join(temporaryRoot, 'base')
  const theirsPath = path.join(temporaryRoot, 'theirs')
  try {
    let baseText
    let theirsText
    try {
      baseText = gitBlob(baseSha, file)
      theirsText = gitBlob(upstreamSha, file)
    } catch {
      return
    }
    await writeFile(basePath, baseText, 'utf8')
    await writeFile(theirsPath, theirsText, 'utf8')
    const result = runGit([
      'merge-file', '-p', '--diff3', currentPath, basePath, theirsPath,
    ], { quiet: true, allowFailure: true })
    if (result.status > 1) {
      throw new Error(`Could not merge repository-owned source file ${file}.`)
    }
    let merged = result.stdout.toString('utf8')
    if (result.status === 1) {
      merged = resolveWireConflict(file, merged)
    }
    if (merged.includes('<<<<<<< ') || merged.includes('>>>>>>> ')) {
      throw new Error(`Unresolved merge conflict remains in ${file}.`)
    }
    await writeFile(currentPath, merged, 'utf8')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function preserveThemeOwnedSource() {
  const gitignorePath = path.join(ROOT, '.gitignore')
  if (!existsSync(gitignorePath)) return
  const gitignore = await readFile(gitignorePath, 'utf8')
  const marker = 'docs/*'
  const additions = [
    '!docs/agent-resource-safety.md',
    '!docs/moego-json-batching.md',
    '!docs/mcp.md',
  ]
  const missing = additions.filter((line) => !gitignore.split(/\r?\n/).includes(line))
  if (missing.length > 0) {
    const position = gitignore.indexOf(marker)
    if (position < 0) throw new Error('The themed .gitignore is missing its docs marker.')
    const end = position + marker.length
    await writeFile(gitignorePath, `${gitignore.slice(0, end)}\n${missing.join('\n')}${gitignore.slice(end)}`, 'utf8')
  }
}

async function retryGit(args, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return runGit(args)
    } catch (error) {
      if (attempt === attempts) throw error
      const delay = Math.min(5000 * (2 ** (attempt - 1)), 120000)
      process.stderr.write(`git ${args.join(' ')} failed; retrying in ${delay / 1000}s (${attempt}/${attempts}).\n`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

async function readOptional(file) {
  try {
    return (await readFile(path.join(ROOT, file), 'utf8')).trim()
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

function isAncestor(ancestor, descendant) {
  const result = runGit(['merge-base', '--is-ancestor', ancestor, descendant], {
    quiet: true,
    allowFailure: true,
  })
  if (result.status > 1) {
    if (result.stderr?.length) process.stderr.write(result.stderr)
    throw new Error(`Could not verify upstream ancestry: ${ancestor} -> ${descendant}`)
  }
  return result.status === 0
}

async function main() {
  if (!RELEASE_TAG_PATTERN.test(UPSTREAM_TAG)) {
    throw new Error(`Invalid upstream release tag: ${UPSTREAM_TAG || '(missing)'}`)
  }
  if (!SHA_PATTERN.test(EXPECTED_UPSTREAM_SHA)) {
    throw new Error(`Invalid upstream release SHA: ${EXPECTED_UPSTREAM_SHA || '(missing)'}`)
  }

  await retryGit(['fetch', PUSH_REMOTE, `+refs/heads/${TARGET_BRANCH}:refs/remotes/${PUSH_REMOTE}/${TARGET_BRANCH}`])
  runGit(['checkout', '-B', SYNC_WORK_BRANCH, `refs/remotes/${PUSH_REMOTE}/${TARGET_BRANCH}`])

  const existingUpstream = runGit(['remote', 'get-url', 'upstream'], { quiet: true, allowFailure: true })
  if (existingUpstream.status === 0) {
    runGit(['remote', 'set-url', 'upstream', UPSTREAM_REPOSITORY])
  } else {
    runGit(['remote', 'add', 'upstream', UPSTREAM_REPOSITORY])
  }

  const markerSha = await readOptional('.apophis-repository-upstream-sha')
  const markerTag = await readOptional('.apophis-repository-upstream-tag')
  if (Boolean(markerSha) !== Boolean(markerTag)) {
    throw new Error('The repository upstream sync markers are incomplete.')
  }

  let baseTag = markerTag || INITIAL_UPSTREAM_TAG
  let expectedBaseSha = markerSha
  if (!baseTag) {
    throw new Error('The first upstream sync requires INITIAL_UPSTREAM_RELEASE_TAG.')
  }
  if (!RELEASE_TAG_PATTERN.test(baseTag) || (expectedBaseSha && !SHA_PATTERN.test(expectedBaseSha))) {
    throw new Error('The repository upstream sync markers or initial release tag are invalid.')
  }

  const tags = new Set([baseTag, UPSTREAM_TAG])
  for (const tag of tags) {
    await retryGit([
      'fetch', '--depth=1000', '--force', 'upstream',
      `refs/tags/${tag}:refs/tags/${tag}`,
    ])
  }

  const baseSha = gitText(['rev-parse', `refs/tags/${baseTag}^{commit}`])
  const upstreamSha = gitText(['rev-parse', `refs/tags/${UPSTREAM_TAG}^{commit}`])
  if (expectedBaseSha && baseSha !== expectedBaseSha) {
    throw new Error(`Previous upstream tag ${baseTag} no longer resolves to the recorded SHA.`)
  }
  if (upstreamSha !== EXPECTED_UPSTREAM_SHA) {
    throw new Error(`Upstream tag ${UPSTREAM_TAG} resolved to ${upstreamSha}, expected ${EXPECTED_UPSTREAM_SHA}.`)
  }

  if (baseSha === upstreamSha) {
    process.stdout.write(`main already matches published Sub2API ${UPSTREAM_TAG}; no source changes to apply.\n`)
    return
  }
  if (isAncestor(upstreamSha, baseSha)) {
    process.stdout.write(`main already tracks a newer Sub2API source than ${UPSTREAM_TAG}; refusing to downgrade it.\n`)
    return
  }
  if (!isAncestor(baseSha, upstreamSha)) {
    throw new Error(`Upstream releases are not a verifiable forward update: ${baseTag} -> ${UPSTREAM_TAG}.`)
  }

  // The repository owns its release VERSION. Keep it independent from the
  // upstream source VERSION while applying the rest of the release delta.
  const patch = runGit([
    'diff', '--binary', '--no-ext-diff', baseSha, upstreamSha, '--', '.',
    ':(exclude)backend/cmd/server/VERSION',
    ...[...THEME_OWNED_SOURCE_PATHS].map((file) => `:(exclude)${file}`),
    ...UPSTREAM_EXCLUDED_SOURCE_PATHS.map((file) => `:(exclude)${file}`),
    ...MERGED_SOURCE_PATHS.map((file) => `:(exclude)${file}`),
  ], { quiet: true }).stdout
  if (patch.length > 0) {
    runGit(['apply', '--3way', '--index'], { input: patch })
  }

  await preserveThemeOwnedSource()
  for (const file of MERGED_SOURCE_PATHS) {
    await mergeSourceFile(baseSha, upstreamSha, file)
  }

  await writeFile(path.join(ROOT, '.apophis-repository-upstream-sha'), `${upstreamSha}\n`, 'utf8')
  await writeFile(path.join(ROOT, '.apophis-repository-upstream-tag'), `${UPSTREAM_TAG}\n`, 'utf8')
  runGit(['add', '--all'])

  const staged = runGit(['diff', '--cached', '--quiet'], { quiet: true, allowFailure: true })
  if (staged.status === 0) {
    process.stdout.write(`No file changes were needed for Sub2API ${UPSTREAM_TAG}.\n`)
    return
  }
  if (staged.status !== 1) {
    throw new Error('Could not inspect staged upstream changes.')
  }

  runGit(['config', 'user.name', 'github-actions[bot]'])
  runGit(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
  runGit(['commit', '-m', `chore(sync): apply Sub2API ${UPSTREAM_TAG} release delta`])

  await retryGit(['fetch', PUSH_REMOTE, `+refs/heads/${TARGET_BRANCH}:refs/remotes/${PUSH_REMOTE}/${TARGET_BRANCH}`])
  runGit(['rebase', `refs/remotes/${PUSH_REMOTE}/${TARGET_BRANCH}`])
  await retryGit(['push', PUSH_REMOTE, `HEAD:refs/heads/${TARGET_BRANCH}`])
  process.stdout.write(`Applied only the ${baseTag}..${UPSTREAM_TAG} Sub2API release delta to ${TARGET_BRANCH}.\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
