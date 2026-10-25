import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('../sync-published-upstream.mjs', import.meta.url))

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

async function fixture(t, { conflict = false, repositoryVersion = '1.0.0', initialTag = '' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-upstream-delta-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const upstream = path.join(root, 'upstream')
  const repository = path.join(root, 'repository')
  const origin = path.join(root, 'origin.git')
  await mkdir(path.join(upstream, 'backend/cmd/server'), { recursive: true })
  git(root, ['init', '--initial-branch=main', upstream])
  git(upstream, ['config', 'user.name', 'Test'])
  git(upstream, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(upstream, 'backend/cmd/server/VERSION'), '1.0.0\n')
  await writeFile(path.join(upstream, 'shared.txt'), 'upstream base\n')
  await writeFile(path.join(upstream, 'upstream-only.txt'), 'release 1.0.0\n')
  git(upstream, ['add', '--all'])
  git(upstream, ['commit', '-m', 'upstream 1.0.0'])
  git(upstream, ['tag', 'v1.0.0'])

  git(root, ['clone', '--bare', upstream, origin])
  git(root, ['clone', upstream, repository])
  git(repository, ['remote', 'set-url', 'origin', origin])
  git(repository, ['config', 'user.name', 'Test'])
  git(repository, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(repository, 'backend/cmd/server/VERSION'), `${repositoryVersion}\n`)
  await writeFile(path.join(repository, 'repository-only.txt'), 'keep this local\n')
  if (conflict) {
    await writeFile(path.join(repository, 'shared.txt'), 'repository edit\n')
  }
  git(repository, ['add', '--all'])
  git(repository, ['commit', '-m', 'repository customization'])
  git(repository, ['push', 'origin', 'main'])

  await writeFile(path.join(upstream, 'backend/cmd/server/VERSION'), '1.0.1\n')
  await writeFile(path.join(upstream, 'upstream-only.txt'), 'release 1.0.1\n')
  await writeFile(path.join(upstream, 'shared.txt'), conflict ? 'upstream edit\n' : 'upstream base\n')
  git(upstream, ['add', '--all'])
  git(upstream, ['commit', '-m', 'upstream 1.0.1'])
  git(upstream, ['tag', 'v1.0.1'])

  return {
    root,
    repository,
    origin,
    upstream,
    initialTag,
    upstreamSha: git(upstream, ['rev-parse', 'HEAD']),
  }
}

function sync(fixtureData) {
  return spawnSync(process.execPath, [scriptPath, fixtureData.repository], {
    encoding: 'utf8',
    env: {
      ...process.env,
      UPSTREAM_REPOSITORY: fixtureData.upstream,
      UPSTREAM_RELEASE_TAG: 'v1.0.1',
      UPSTREAM_SHA: fixtureData.upstreamSha,
      INITIAL_UPSTREAM_RELEASE_TAG: fixtureData.initialTag,
    },
  })
}

test('sync applies only the new upstream release delta and is idempotent', async (t) => {
  const data = await fixture(t, { repositoryVersion: '9.9.9', initialTag: 'v1.0.0' })

  const first = sync(data)
  assert.equal(first.status, 0, first.stderr)

  const main = `--git-dir=${data.origin}`
  assert.equal(git(data.root, [main, 'show', 'refs/heads/main:upstream-only.txt']), 'release 1.0.1')
  assert.equal(git(data.root, [main, 'show', 'refs/heads/main:repository-only.txt']), 'keep this local')
  assert.equal(git(data.root, [main, 'show', 'refs/heads/main:backend/cmd/server/VERSION']), '9.9.9')
  assert.equal(git(data.root, [main, 'show', 'refs/heads/main:.apophis-repository-upstream-tag']), 'v1.0.1')

  const pushedSha = git(data.root, [main, 'rev-parse', 'refs/heads/main'])
  const second = sync(data)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(git(data.root, [main, 'rev-parse', 'refs/heads/main']), pushedSha)
})

test('sync leaves main unchanged when the upstream delta conflicts with a repository edit', async (t) => {
  const data = await fixture(t, { conflict: true, initialTag: 'v1.0.0' })
  const before = git(data.root, [`--git-dir=${data.origin}`, 'rev-parse', 'refs/heads/main'])

  const result = sync(data)

  assert.notEqual(result.status, 0)
  assert.equal(git(data.root, [`--git-dir=${data.origin}`, 'rev-parse', 'refs/heads/main']), before)
  assert.equal(
    git(data.root, [`--git-dir=${data.origin}`, 'show', 'refs/heads/main:shared.txt']),
    'repository edit',
  )
})
