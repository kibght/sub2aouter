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

async function writeFiles(root, files) {
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, file)
    if (contents === null) await rm(target, { force: true })
    else {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, contents)
    }
  }
}

async function fixture(t, { conflict = false, repositoryVersion = '1.0.0', initialTag = '', baseFiles = {}, localFiles = {}, upstreamFiles = {} } = {}) {
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
  await mkdir(path.join(upstream, '.github/workflows'), { recursive: true })
  await writeFile(path.join(upstream, '.github/workflows/upstream-ci.yml'), 'name: upstream\n')
  await writeFiles(upstream, baseFiles)
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
  await writeFiles(repository, localFiles)
  git(repository, ['add', '--all'])
  git(repository, ['commit', '-m', 'repository customization'])
  git(repository, ['push', 'origin', 'main'])

  await writeFile(path.join(upstream, 'backend/cmd/server/VERSION'), '1.0.1\n')
  await writeFile(path.join(upstream, 'upstream-only.txt'), 'release 1.0.1\n')
  await writeFile(path.join(upstream, 'shared.txt'), conflict ? 'upstream edit\n' : 'upstream base\n')
  await writeFile(path.join(upstream, '.github/workflows/upstream-ci.yml'), 'name: changed-upstream\n')
  await writeFiles(upstream, upstreamFiles)
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
  assert.equal(git(data.root, [main, 'show', 'refs/heads/main:.github/workflows/upstream-ci.yml']), 'name: upstream')

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

const serviceWire = 'backend/internal/service/wire.go'
const generatedWire = 'backend/cmd/server/wire_gen.go'

test('sync rejects a conflicting provider function without advancing main or markers', async (t) => {
  const data = await fixture(t, {
    initialTag: 'v1.0.0',
    baseFiles: { [serviceWire]: 'package service\nfunc ProvideThing() int { return 0 }\n' },
    localFiles: { [serviceWire]: 'package service\nfunc ProvideThing() int { return 1 }\n' },
    upstreamFiles: { [serviceWire]: 'package service\nfunc ProvideThing() int { return 2 }\n' },
  })
  const before = git(data.root, [`--git-dir=${data.origin}`, 'rev-parse', 'main'])
  const result = sync(data)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /provider-set entries|manual resolution/)
  assert.equal(git(data.root, [`--git-dir=${data.origin}`, 'rev-parse', 'main']), before)
  assert.equal(spawnSync('git', [`--git-dir=${data.origin}`, 'show', 'main:.apophis-repository-upstream-tag']).status, 128)
})

test('sync combines additive provider entries while preserving local providers', async (t) => {
  const base = 'package service\nvar ProviderSet = wire.NewSet(\n\tNewUser,\n\tNewAPIKey,\n)\n'
  const data = await fixture(t, {
    initialTag: 'v1.0.0',
    baseFiles: { [serviceWire]: base },
    localFiles: { [serviceWire]: base.replace('\tNewAPIKey,', '\tNewBotBinding,\n\tNewBotCheckIn,\n\tNewAPIKey,') },
    upstreamFiles: { [serviceWire]: base.replace('\tNewAPIKey,', '\tNewMCPOAuth,\n\tNewAPIKey,') },
  })
  const result = sync(data)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(git(data.root, [`--git-dir=${data.origin}`, 'show', `main:${serviceWire}`]),
    base.replace('\tNewAPIKey,', '\tNewBotBinding,\n\tNewBotCheckIn,\n\tNewMCPOAuth,\n\tNewAPIKey,').trim())
})

test('sync resolves multiple independent provider conflicts in one Wire file', async (t) => {
  const anchors = Array.from({ length: 12 }, (_, index) => `\tNewMiddle${index},`).join('\n')
  const base = `package service\nvar ProviderSet = wire.NewSet(\n\tNewFirst,\n${anchors}\n\tNewLast,\n)\n`
  const data = await fixture(t, {
    initialTag: 'v1.0.0',
    baseFiles: { [serviceWire]: base },
    localFiles: { [serviceWire]: base.replace('\tNewFirst,', '\tNewFirst,\n\tNewBot,').replace('\tNewLast,', '\tNewCheckIn,\n\tNewLast,') },
    upstreamFiles: { [serviceWire]: base.replace('\tNewFirst,', '\tNewFirst,\n\tNewMCP,').replace('\tNewLast,', '\tNewOAuth,\n\tNewLast,') },
  })
  const result = sync(data)
  assert.equal(result.status, 0, result.stderr)
  const output = git(data.root, [`--git-dir=${data.origin}`, 'show', `main:${serviceWire}`])
  for (const entry of ['NewBot', 'NewCheckIn', 'NewMCP', 'NewOAuth']) {
    assert.equal(output.split(entry + ',').length - 1, 1)
  }
})

test('sync preserves both generated handler constructors and their arguments', async (t) => {
  const base = 'package main\nfunc initHandlers() {\n\thandlers := handler.ProvideHandlers(userHandler, batchImageHandler, idempotencyCoordinator)\n}\n'
  const data = await fixture(t, {
    initialTag: 'v1.0.0',
    baseFiles: { [generatedWire]: base },
    localFiles: { [generatedWire]: base.replace('\thandlers :=', '\tbotHandler := handler.ProvideBotHandler(botService)\n\thandlers :=').replace('batchImageHandler, idempotencyCoordinator', 'batchImageHandler, botHandler, idempotencyCoordinator') },
    upstreamFiles: { [generatedWire]: base.replace('\thandlers :=', '\tmcpHandler := handler.NewMCPOAuthHandler(mcpService)\n\thandlers :=').replace('userHandler, batchImageHandler', 'userHandler, mcpHandler, batchImageHandler') },
  })
  const result = sync(data)
  assert.equal(result.status, 0, result.stderr)
  const output = git(data.root, [`--git-dir=${data.origin}`, 'show', `main:${generatedWire}`])
  assert.match(output, /botHandler := handler\.ProvideBotHandler\(botService\)/)
  assert.match(output, /mcpHandler := handler\.NewMCPOAuthHandler\(mcpService\)/)
  assert.match(output, /ProvideHandlers\(userHandler, mcpHandler, batchImageHandler, botHandler, idempotencyCoordinator\)/)
})

for (const operation of ['add', 'delete']) {
  test(`sync explicitly applies an upstream Wire file ${operation}`, async (t) => {
    const contents = 'package service\nfunc ProvideThing() int { return 0 }\n'
    const data = await fixture(t, {
      initialTag: 'v1.0.0',
      baseFiles: operation === 'delete' ? { [serviceWire]: contents } : {},
      upstreamFiles: { [serviceWire]: operation === 'add' ? contents : null },
    })
    const result = sync(data)
    assert.equal(result.status, 0, result.stderr)
    const output = spawnSync('git', [`--git-dir=${data.origin}`, 'show', `main:${serviceWire}`], { encoding: 'utf8' })
    assert.equal(output.status, operation === 'add' ? 0 : 128)
    if (operation === 'add') assert.equal(output.stdout, contents)
  })
}

test('sync rejects deletion of a locally customized Wire file', async (t) => {
  const data = await fixture(t, {
    initialTag: 'v1.0.0',
    baseFiles: { [serviceWire]: 'package service\nfunc ProvideThing() int { return 0 }\n' },
    localFiles: { [serviceWire]: 'package service\nfunc ProvideThing() int { return 1 }\n' },
    upstreamFiles: { [serviceWire]: null },
  })
  const before = git(data.root, [`--git-dir=${data.origin}`, 'rev-parse', 'main'])
  const result = sync(data)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /addition or deletion requires manual resolution/)
  assert.equal(git(data.root, [`--git-dir=${data.origin}`, 'rev-parse', 'main']), before)
})

test('sync refuses to advance markers or push an uncompilable backend', async (t) => {
  const data = await fixture(t, {
    initialTag: 'v1.0.0',
    baseFiles: {
      'backend/go.mod': 'module example.invalid/syncfixture\n\ngo 1.23.0\n',
      'backend/cmd/server/main.go': 'package main\nfunc main() {}\n',
    },
    upstreamFiles: { 'backend/cmd/server/main.go': 'package main\nfunc main() { missingProvider() }\n' },
  })
  const before = git(data.root, [`--git-dir=${data.origin}`, 'rev-parse', 'main'])
  const result = sync(data)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not compile; refusing to push/)
  assert.equal(git(data.root, [`--git-dir=${data.origin}`, 'rev-parse', 'main']), before)
  await assert.rejects(readFile(path.join(data.repository, '.apophis-repository-upstream-tag')), { code: 'ENOENT' })
})

test('sync validates the final rebased backend before pushing', async (t) => {
  const data = await fixture(t, {
    initialTag: 'v1.0.0',
    baseFiles: {
      'backend/go.mod': 'module example.invalid/syncfixture\n\ngo 1.23.0\n',
      'backend/cmd/server/main.go': 'package main\nfunc main() {}\n',
    },
    upstreamFiles: { 'backend/cmd/server/main.go': 'package main\nfunc main() { println("updated") }\n' },
  })
  const concurrent = path.join(data.root, 'concurrent')
  git(data.root, ['clone', data.origin, concurrent])
  git(concurrent, ['config', 'user.name', 'Test'])
  git(concurrent, ['config', 'user.email', 'test@example.com'])
  await writeFiles(concurrent, { 'backend/cmd/server/broken.go': 'package main\nvar _ = missingAfterRebase\n' })
  git(concurrent, ['add', '--all'])
  git(concurrent, ['commit', '-m', 'concurrent update'])
  const concurrentSha = git(concurrent, ['rev-parse', 'HEAD'])
  git(concurrent, ['push', 'origin', 'HEAD:refs/heads/test-concurrent'])
  const hooks = path.join(data.root, 'hooks')
  await mkdir(hooks)
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(path.join(hooks, 'post-commit'), `#!/bin/sh\ngit --git-dir=${shellQuote(data.origin.replaceAll('\\', '/'))} update-ref refs/heads/main ${concurrentSha}\n`, { mode: 0o755 })
  git(data.repository, ['config', 'core.hooksPath', hooks])
  const result = sync(data)
  assert.notEqual(result.status, 0, result.stdout)
  assert.match(result.stderr, /missingAfterRebase/)
  assert.match(result.stderr, /does not compile; refusing to push/)
  assert.equal(git(data.root, [`--git-dir=${data.origin}`, 'rev-parse', 'main']), concurrentSha)
  assert.equal(spawnSync('git', [`--git-dir=${data.origin}`, 'show', 'main:.apophis-repository-upstream-tag']).status, 128)
})
