import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { changelogChanges, concreteSubjects, composeReleaseNotes, previousReleaseTag } from '../lib/release-notes.mjs'
import { nextReleaseVersion } from '../lib/release-version.mjs'

const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'D:/Program Files/Git/bin/bash.exe' : 'bash')
const root = path.resolve('.')
const helper = path.join(root, 'scripts/ci/release-identity.sh').replaceAll('\\', '/')
const sha = 'f2669c8cf62555cd92389b3f55920e9e6e7c6ff2'
const match = (...args) => spawnSync(bash, ['-c', 'source "$1"; shift; release_identity_matches "$@"', '_', helper, ...args]).status === 0

test('v0.2.2 missing tag does not republish the v0.2.1 Sub2API release', () => {
  assert.equal(match(sha, '', '407475669', sha, 'v0.2.15', '407475669'), true)
  assert.equal(match(sha, 'v0.2.15', '', sha, 'v0.2.15', '407475669'), true)
  assert.equal(match(sha, '', '', sha, 'v0.2.15', '407475669'), false)
  assert.equal(match(sha, 'v0.2.15', '407475669', 'a'.repeat(40), 'v0.2.16', '408000000'), false)
  assert.equal(match(sha, 'v0.2.15', '407475669', 'a'.repeat(40), 'v0.2.15', '407475669'), false)
  assert.equal(match(sha, 'v0.2.14', 'old', sha, 'v0.2.15', '407475669'), false)
  assert.equal(nextReleaseVersion('0.2.2'), '0.2.3')
})

test('republishing 0.2.2 compares changes against 0.2.1 and ignores the withdrawn 0.2.3', () => {
  const releases = ['v0.2.3', 'v0.2.2', 'v0.2.1', 'v0.2.0'].map((tag_name) => ({ tag_name }))
  assert.equal(previousReleaseTag(releases, '0.2.2'), 'v0.2.1')
  assert.equal(previousReleaseTag(releases.slice(1), '0.2.3'), 'v0.2.2')
  assert.equal(previousReleaseTag([{ tag_name: 'v0.2.2', draft: true }, { tag_name: 'v0.2.1' }], '0.2.3'), 'v0.2.1')
})

test('repository metadata is copied byte-for-byte from the generated source', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'release-metadata-'))
  try {
    const git = (...args) => execFileSync('git', ['-C', temp, ...args], { stdio: 'pipe' })
    git('init', '-q')
    git('config', 'core.autocrlf', 'false')
    const files = { tag: 'v0.2.15\n', id: '407475669\n', name: 'Sub2API 0.2.15\n', url: 'https://example.test/release\n', 'notes.md': readFileSync(path.join(root, 'README_CN.md')) }
    for (const [field, value] of Object.entries(files)) writeFileSync(path.join(temp, '.apophis-upstream-release-' + field), value)
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture')
    const output = path.join(temp, 'output')
    mkdirSync(output)
    execFileSync(bash, [path.join(root, 'scripts/ci/preserve-upstream-metadata.sh').replaceAll('\\', '/'), output.replaceAll('\\', '/'), 'HEAD'], {
      cwd: temp,
      env: { ...process.env, UPSTREAM_RELEASE_TAG: '', UPSTREAM_RELEASE_ID: '' },
    })
    for (const field of Object.keys(files)) assert.deepEqual(readFileSync(path.join(output, '.apophis-upstream-release-' + field)), readFileSync(path.join(temp, '.apophis-upstream-release-' + field)))
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('Canvas notes contain only newly added entries even under an Unreleased heading', () => {
  const previous = '# CHANGELOG\n\n## Unreleased\n\n+ Keep existing behavior.\n'
  const current = '# CHANGELOG\n\n## Unreleased\n\n+ Preserve unavailable model selections.\n+ Copy reference connections.\n\n## v0.19.0\n\n+ Keep existing behavior.\n'
  const changes = changelogChanges(previous, current)
  assert.equal(changes, '+ Preserve unavailable model selections.\n+ Copy reference connections.')
  const body = composeReleaseNotes({ canvas: changes, canvasTag: 'v0.20.0' })
  assert.match(body, /Copy reference connections/)
  assert.doesNotMatch(body, /Keep existing|[a-f0-9]{40}/)
})

test('synchronization commit subjects cannot substitute for actual changes', () => {
  const repository = concreteSubjects(['chore: update Infinite Canvas upstream to ' + sha + ' (#59)'])
  assert.equal(repository, '')
  assert.throws(() => composeReleaseNotes({ repository }), /Concrete release changes/)
  assert.throws(() => composeReleaseNotes({ upstream: '**Full Changelog**: https://example.test/compare/a...b' }), /Concrete release changes/)
  assert.throws(() => composeReleaseNotes({ canvas: '- broken \uFFFD' }), /encoding/)
})

test('upstream notes preserve actual changes without provenance and upstream install commands', () => {
  const notes = '> source metadata\n\n## Fixes\n\n- Preserve tools.\n\n---\n\n## Installation\n\ndocker pull upstream:latest'
  const body = composeReleaseNotes({ upstream: notes })
  assert.match(body, /- Preserve tools\./)
  assert.doesNotMatch(body, /source metadata|docker pull|Installation/)
})

test('release notes include concrete integration details', () => {
  const body = composeReleaseNotes({
    repository: '- ci: sync unified QQ bot branch',
    integrations: ['### QQ Bot Integration\n\n- QQ alerts are persisted until acknowledged.'],
  })
  assert.match(body, /QQ Bot Integration/)
  assert.match(body, /persisted until acknowledged/)
})
