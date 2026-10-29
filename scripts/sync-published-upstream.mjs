#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const ROOT = path.resolve(process.argv[2] || '.')
const UPSTREAM_REPOSITORY = process.env.UPSTREAM_REPOSITORY || 'https://github.com/Wei-Shaw/sub2api.git'
const PUSH_REMOTE = process.env.SYNC_PUSH_REMOTE || 'origin'
const TARGET_BRANCH = process.env.SYNC_TARGET_BRANCH || 'main'
const UPSTREAM_TAG = process.env.UPSTREAM_RELEASE_TAG || ''
const EXPECTED_UPSTREAM_SHA = process.env.UPSTREAM_SHA || ''
const INITIAL_UPSTREAM_TAG = process.env.INITIAL_UPSTREAM_RELEASE_TAG || ''
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const RELEASE_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+$/

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
  runGit(['checkout', '-B', 'automation/upstream-release-sync', `refs/remotes/${PUSH_REMOTE}/${TARGET_BRANCH}`])

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
  ], { quiet: true }).stdout
  if (patch.length > 0) {
    runGit(['apply', '--3way', '--index'], { input: patch })
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
