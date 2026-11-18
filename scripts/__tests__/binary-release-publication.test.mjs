import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { verifyReleaseAssets } from '../verify-release-assets.mjs'

const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'D:/Program Files/Git/bin/bash.exe' : 'bash')
const root = path.resolve('.')
const workflow = await readFile('.github/workflows/theme-binary-release.yml', 'utf8')

function runStep(name) {
  const lines = workflow.split(/\r?\n/)
  const start = lines.findIndex((line) => line === `      - name: ${name}`)
  assert.ok(start >= 0, `Missing workflow step: ${name}`)
  const body = []
  let running = false
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('      - ')) break
    if (running) body.push(line.slice(10))
    if (line === '        run: |') running = true
  }
  assert.ok(running)
  return body.join('\n')
}

async function fixture(t) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'release-publication-'))
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }))
  const dist = path.join(temporaryRoot, 'dist')
  await mkdir(dist)
  const version = '1.2.3'
  const release = { tag_name: `v${version}`, draft: true, assets: [] }
  const checksumLines = []
  for (const platform of ['linux_amd64.tar.gz', 'linux_arm64.tar.gz', 'windows_amd64.zip', 'darwin_amd64.tar.gz', 'darwin_arm64.tar.gz']) {
    const name = `sub2api_${version}_${platform}`
    const contents = Buffer.from(`verified ${name}`)
    const hash = createHash('sha256').update(contents).digest('hex')
    await writeFile(path.join(dist, name), contents)
    checksumLines.push(`${hash}  ${name}`)
    release.assets.push({ name, state: 'uploaded', size: contents.length, digest: `sha256:${hash}` })
  }
  const checksums = Buffer.from(checksumLines.join('\n') + '\n')
  await writeFile(path.join(dist, 'checksums.txt'), checksums)
  release.assets.push({ name: 'checksums.txt', state: 'uploaded', size: checksums.length, digest: `sha256:${createHash('sha256').update(checksums).digest('hex')}` })
  return { temporaryRoot, dist, version, release }
}

test('staged publication verifies every uploaded asset against the build and checksums', async (t) => {
  const data = await fixture(t)
  await verifyReleaseAssets(data)
  for (const name of data.release.assets.map((asset) => asset.name)) {
    const release = structuredClone(data.release)
    release.assets.find((asset) => asset.name === name).digest = `sha256:${'0'.repeat(64)}`
    await assert.rejects(verifyReleaseAssets({ ...data, release }), /does not match the verified build/)
  }
})

test('staging rejects partial uploads, duplicate assets, and public releases', async (t) => {
  const data = await fixture(t)
  for (const assets of [data.release.assets.slice(1), [...data.release.assets, data.release.assets[0]]]) {
    await assert.rejects(verifyReleaseAssets({ ...data, release: { ...data.release, assets } }), /does not match the verified build/)
  }
  await assert.rejects(verifyReleaseAssets({ ...data, release: { ...data.release, draft: false } }), /expected draft/)
  await writeFile(path.join(data.dist, data.release.assets[0].name), 'corrupted local archive')
  await assert.rejects(verifyReleaseAssets(data), /Local release checksum mismatch/)
  await assert.rejects(verifyReleaseAssets({ version: data.version, dist: data.dist }), /Local release checksum mismatch/)
})

async function publish(t, { exists = true, uploadFailure = false, corruptDigest = false } = {}) {
  const data = await fixture(t)
  await mkdir(path.join(data.temporaryRoot, 'scripts/ci'), { recursive: true })
  await writeFile(path.join(data.temporaryRoot, 'scripts/ci/retry.sh'), 'retry_with_backoff() { shift 2; "$@"; }\n')
  await copyFile(path.join(root, 'scripts/verify-release-assets.mjs'), path.join(data.temporaryRoot, 'scripts/verify-release-assets.mjs'))
  await writeFile(path.join(data.temporaryRoot, '.apophis-release-title'), 'Release fixture\n')
  await writeFile(path.join(data.temporaryRoot, '.apophis-release-notes.md'), 'Release fixture notes\n')
  if (corruptDigest) data.release.assets[2].digest = `sha256:${'0'.repeat(64)}`
  await writeFile(path.join(data.temporaryRoot, 'remote.json'), JSON.stringify(data.release))
  const mock = `
gh() {
  printf 'gh %s\\n' "$*" >> commands.log
  if [[ "$1 $2" == "release upload" && "$MOCK_UPLOAD_FAILURE" == true ]]; then return 1; fi
  if [[ "$1 $2" == "release view" ]]; then printf '%s\\n' 'https://api.github.test/repos/test/repo/releases/1'; fi
  if [[ "$1" == api ]]; then cat remote.json; fi
}
git() { printf 'git %s\\n' "$*" >> commands.log; }
`
  const result = spawnSync(bash, ['-c', mock + '\n' + runStep('Publish GitHub binary release')], {
    cwd: data.temporaryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      RELEASE_EXISTS: String(exists),
      RELEASE_TAG: `v${data.version}`,
      RELEASE_VERSION: data.version,
      GITHUB_REPOSITORY: 'test/repo',
      RUNNER_TEMP: data.temporaryRoot.replaceAll('\\', '/'),
      MOCK_UPLOAD_FAILURE: String(uploadFailure),
    },
  })
  return { result, commands: await readFile(path.join(data.temporaryRoot, 'commands.log'), 'utf8') }
}

test('an upload failure leaves the existing release in draft without moving its remote tag', async (t) => {
  const { result, commands } = await publish(t, { uploadFailure: true })
  assert.notEqual(result.status, 0)
  assert.ok(commands.indexOf('--draft=true') < commands.indexOf('release upload'))
  assert.doesNotMatch(commands, /git push|--draft=false/)
})

test('a partial or corrupt staged upload cannot update the tag or become public', async (t) => {
  const { result, commands } = await publish(t, { corruptDigest: true })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not match the verified build/)
  assert.doesNotMatch(commands, /git push|--draft=false/)
})

test('existing and new releases become public only after all staged digests match', async (t) => {
  for (const exists of [true, false]) {
    const { result, commands } = await publish(t, { exists })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(commands.indexOf('gh api') < commands.indexOf('git push'))
    assert.ok(commands.indexOf('git push') < commands.indexOf('--draft=false'))
    assert.match(commands, exists ? /release edit v1\.2\.3 .*--draft=true/ : /release create v1\.2\.3 .*--draft\n/)
  }
})

test('build preparation only changes the local tag and binary publishers share a lock', () => {
  assert.match(runStep('Align verified release tag'), /git tag -f/)
  assert.doesNotMatch(runStep('Align verified release tag'), /git push/)
  assert.match(workflow, /group: themed-binary-release\r?\n/)
  assert.ok(workflow.indexOf('name: Verify GoReleaser artifacts') < workflow.indexOf('git push --force'))
})

async function decidePublication(t, { sameTree, kind }) {
  const data = await fixture(t)
  await mkdir(path.join(data.temporaryRoot, 'backend/cmd/server'), { recursive: true })
  await mkdir(path.join(data.temporaryRoot, 'scripts/ci'), { recursive: true })
  await writeFile(path.join(data.temporaryRoot, 'scripts/ci/retry.sh'), 'retry_with_backoff() { shift 2; "$@"; }\n')
  for (const [file, contents] of Object.entries({
    'backend/cmd/server/VERSION': data.version,
    '.apophis-release-kind': kind,
    '.apophis-upstream-sha': 'a'.repeat(40),
    '.apophis-upstream-release-tag': 'v9.8.7',
    '.apophis-repository-sha': 'b'.repeat(40),
    '.apophis-canvas-sha': 'c'.repeat(40),
  })) await writeFile(path.join(data.temporaryRoot, file), contents + '\n')
  const mock = `
gh() { printf '{}\\n'; }
jq() {
  case "$2" in
    .isDraft|.isPrerelease) printf 'false\\n';;
    .targetCommitish) printf 'themed-release\\n';;
    '.assets[].name') printf '%s\\n' "$MOCK_ASSETS";;
    *) return 1;;
  esac
}
git() {
  case "$*" in
    'fetch '*) return 0;;
    'show refs/apophis/existing-release:.apophis-upstream-sha') cat .apophis-upstream-sha;;
    'show refs/apophis/existing-release:.apophis-upstream-release-tag') cat .apophis-upstream-release-tag;;
    'show refs/apophis/existing-release:.apophis-repository-sha') cat .apophis-repository-sha;;
    'rev-parse refs/apophis/existing-release:integrations/infinite-canvas') cat .apophis-canvas-sha;;
    'rev-parse refs/apophis/existing-release^{tree}') printf '%s\\n' "$MOCK_EXISTING_TREE";;
    'rev-parse HEAD^{tree}') printf 'current-tree\\n';;
    *) return 1;;
  esac
}
`
  const result = spawnSync(bash, ['-c', mock + '\n' + runStep('Read release version and skip duplicates')], {
    cwd: data.temporaryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_REPUBLISH: 'false',
      GITHUB_REPOSITORY: 'test/repo',
      GITHUB_ENV: path.join(data.temporaryRoot, 'github.env').replaceAll('\\', '/'),
      MOCK_ASSETS: data.release.assets.map((asset) => asset.name).join('\n'),
      MOCK_EXISTING_TREE: sameTree ? 'current-tree' : 'previous-tree',
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return readFile(path.join(data.temporaryRoot, 'github.env'), 'utf8')
}

test('matching source metadata cannot skip a replacement with a different generated tree', async (t) => {
  for (const kind of ['upstream', 'repository']) {
    assert.match(await decidePublication(t, { sameTree: false, kind }), /SHOULD_PUBLISH=true/)
  }
})

test('a complete release with matching source metadata and tree still skips duplicate publication', async (t) => {
  for (const kind of ['upstream', 'repository']) {
    assert.match(await decidePublication(t, { sameTree: true, kind }), /SHOULD_PUBLISH=false/)
  }
})
