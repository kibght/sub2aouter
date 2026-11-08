import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'D:/Program Files/Git/bin/bash.exe' : 'bash')
const repositoryRoot = path.resolve('.')
const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
const versionDigest = `sha256:${'a'.repeat(64)}`
const oldDigest = `sha256:${'b'.repeat(64)}`

function runStep(name) {
  const lines = workflow.split(/\r?\n/)
  const start = lines.findIndex((line) => line === `      - name: ${name}`)
  assert.ok(start >= 0, `Missing workflow step: ${name}`)
  let running = false
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith(running ? '          ' : '        ')) break
    if (running) body.push(line.slice(10))
    if (line === '        run: |') running = true
  }
  assert.ok(running, `Missing run body: ${name}`)
  return body.join('\n')
}

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sync-orchestration-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function outputs(t, env) {
  const root = await temporaryRoot(t)
  const output = path.join(root, 'output.txt')
  const result = spawnSync(bash, ['-c', runStep('Export release orchestration outputs')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SHOULD_PUBLISH: 'false', NEEDS_BINARY_RELEASE: 'false',
      RELEASE_KIND: 'upstream', UPSTREAM_RELEASE_PUBLISHED: 'true',
      RELEASE_VERSION: '', BINARY_RELEASE_VERSION: '', BINARY_RELEASE_REF: '',
      RELEASE_COMMIT: '', LATEST_RELEASE_VERSION: '1.2.3',
      UPSTREAM_RELEASE_TAG: 'v0.2.20', UPSTREAM_SHA: 'c'.repeat(40),
      GITHUB_OUTPUT: output.replaceAll('\\', '/'),
      ...env,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return Object.fromEntries((await readFile(output, 'utf8')).trim().split('\n').map((line) => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
}

test('an unchanged release still permits latest-image reconciliation without rebuilding binaries', async (t) => {
  const result = await outputs(t, {})
  assert.equal(result.run_binary, 'false')
  assert.equal(result.should_promote_latest, 'true')
  assert.equal(result.release_version, '1.2.3')
  assert.equal(result.release_ref, '')
})

test('binary-only repair exports the pending candidate version and ref for latest promotion', async (t) => {
  const result = await outputs(t, {
    NEEDS_BINARY_RELEASE: 'true',
    BINARY_RELEASE_VERSION: '1.2.4', BINARY_RELEASE_REF: 'refs/apophis/pending-release',
  })
  assert.equal(result.run_binary, 'true')
  assert.equal(result.should_promote_latest, 'true')
  assert.equal(result.release_version, '1.2.4')
  assert.equal(result.release_ref, 'refs/apophis/pending-release')
  assert.equal(result.upstream_release_tag, 'v0.2.20')
  assert.equal(result.upstream_sha, 'c'.repeat(40))
})

test('normal publication exports the verified new commit and version', async (t) => {
  const result = await outputs(t, {
    SHOULD_PUBLISH: 'true', RELEASE_VERSION: '1.2.5', RELEASE_COMMIT: 'd'.repeat(40),
    BINARY_RELEASE_VERSION: '1.2.4', BINARY_RELEASE_REF: 'refs/apophis/pending-release',
  })
  assert.equal(result.run_binary, 'true')
  assert.equal(result.should_promote_latest, 'true')
  assert.equal(result.release_version, '1.2.5')
  assert.equal(result.release_ref, 'd'.repeat(40))
  assert.equal(result.repository_sync_release_tag, 'v0.2.20')
})

async function promote(t, { latest = 'same', releaseTag = 'v1.2.3', pullDigest = versionDigest, pushFailure = false } = {}) {
  const root = await temporaryRoot(t)
  await mkdir(path.join(root, 'scripts/ci'), { recursive: true })
  await writeFile(path.join(root, 'scripts/ci/retry.sh'), 'retry_with_backoff() { shift 2; "$@"; }\n')
  await copyFile(path.join(repositoryRoot, 'scripts/ci/image-digest.sh'), path.join(root, 'scripts/ci/image-digest.sh'))
  await writeFile(path.join(root, 'commands.log'), '')
  await writeFile(path.join(root, 'mock-jq.mjs'), `
import { readFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === '-r' && args[1] === '.tag_name') {
  console.log(JSON.parse(readFileSync(args[2], 'utf8')).tag_name)
} else if (args[0] === '-e' && args[1] === '--arg' && args[2] === 'expected') {
  process.exit(JSON.parse(readFileSync(0, 'utf8')).includes(args[3]) ? 0 : 1)
} else throw new Error('Unexpected jq invocation: ' + args.join(' '))
`)
  const mock = `
gh() {
  printf 'gh %s\\n' "$*" >> commands.log
  if [[ "$1" != api ]]; then return 97; fi
  printf '{"tag_name":"%s"}\\n' "$MOCK_RELEASE_TAG"
}
jq() { node mock-jq.mjs "$@"; }
docker() {
  printf 'docker %s\\n' "$*" >> commands.log
  case "$1 $2 \${3:-}" in
    'buildx imagetools inspect')
      if [[ "$4" == *:latest && ! -f pushed ]]; then
        case "$MOCK_LATEST" in
          same) printf '%s\\n' "$MOCK_VERSION_DIGEST" ;;
          old) printf '%s\\n' "$MOCK_OLD_DIGEST" ;;
          missing) echo 'manifest unknown' >&2; return 1 ;;
          unauthorized) echo 'unauthorized: authentication required' >&2; return 1 ;;
          *) return 98 ;;
        esac
      else printf '%s\\n' "$MOCK_VERSION_DIGEST"; fi
      ;;
    'image inspect '*) printf '["ghcr.io/test/repo@%s"]\\n' "$MOCK_PULL_DIGEST" ;;
    *)
      case "$1" in
        pull|tag) return 0 ;;
        push)
          if [[ "$MOCK_PUSH_FAILURE" == true ]]; then return 1; fi
          touch pushed
          ;;
        *) return 99 ;;
      esac
      ;;
  esac
}
`
  // Isolate the workflow's fixed temporary filename between test processes.
  const body = runStep('Promote verified themed image to latest')
    .replace('RELEASE_JSON=/tmp/promotion-release.json', 'RELEASE_JSON="$PROMOTION_RELEASE_JSON"')
  const result = spawnSync(bash, ['-c', mock + '\n' + body], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      RELEASE_VERSION: '1.2.3', GITHUB_REPOSITORY: 'test/repo',
      MOCK_LATEST: latest, MOCK_RELEASE_TAG: releaseTag,
      MOCK_VERSION_DIGEST: versionDigest, MOCK_OLD_DIGEST: oldDigest,
      MOCK_PULL_DIGEST: pullDigest, MOCK_PUSH_FAILURE: String(pushFailure),
      PROMOTION_RELEASE_JSON: path.join(root, 'promotion-release.json').replaceAll('\\', '/'),
    },
  })
  return { result, commands: await readFile(path.join(root, 'commands.log'), 'utf8') }
}

test('matching image digests do not pull, retag, or push an unchanged release', async (t) => {
  const { result, commands } = await promote(t)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /already matches verified release/)
  assert.doesNotMatch(commands, /docker (pull|tag|push) /)
})

for (const latest of ['missing', 'old']) {
  test(`latest promotion repairs a ${latest} latest image and verifies its final digest`, async (t) => {
    const { result, commands } = await promote(t, { latest })
    assert.equal(result.status, 0, result.stderr)
    assert.match(commands, /docker pull ghcr\.io\/test\/repo:1\.2\.3/)
    assert.match(commands, /docker tag ghcr\.io\/test\/repo:1\.2\.3 ghcr\.io\/test\/repo:latest/)
    assert.match(commands, /docker push ghcr\.io\/test\/repo:latest/)
    assert.ok(commands.lastIndexOf('imagetools inspect ghcr.io/test/repo:latest') > commands.indexOf('docker push'))
  })
}

test('promotion rejects a candidate that differs from the latest public binary release', async (t) => {
  const { result, commands } = await promote(t, { releaseTag: 'v1.2.2', latest: 'old' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not the latest published binary release/)
  assert.doesNotMatch(commands, /docker /)
})

test('registry authorization failure is not treated as a missing latest image', async (t) => {
  const { result, commands } = await promote(t, { latest: 'unauthorized' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unauthorized/)
  assert.doesNotMatch(commands, /docker (pull|tag|push) /)
})

test('a pulled version image with a mismatching digest cannot be promoted', async (t) => {
  const { result, commands } = await promote(t, { latest: 'old', pullDigest: oldDigest })
  assert.notEqual(result.status, 0)
  assert.match(commands, /docker pull /)
  assert.match(commands, /docker image inspect /)
  assert.doesNotMatch(commands, /docker (tag|push) /)
})

test('a failed latest push leaves promotion failed for the next recovery round', async (t) => {
  const { result, commands } = await promote(t, { latest: 'old', pushFailure: true })
  assert.notEqual(result.status, 0)
  assert.match(commands, /docker push /)
})

function environmentValues(text) {
  return Object.fromEntries(text.trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
}

async function decide(t, {
  generatedVersion = '0.2.10', publicVersion = '0.2.9',
  candidateKind = 'upstream', draft = true, staleRepository = false,
  candidateTreeChanged = false, newUpstream = false,
  latestStatus = 200, expectedExitCode = 0,
  releaseVersionOverride = '',
} = {}) {
  const root = await temporaryRoot(t)
  const git = (args, input) => execFileSync('git', args, {
    cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
  git(['init', '--initial-branch=main'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'user.email', 'test@example.test'])
  git(['config', 'core.autocrlf', 'false'])
  const commit = (files, parent = '', canvas = '') => {
    git(['read-tree', '--empty'])
    for (const [name, contents] of Object.entries(files)) {
      const blob = git(['hash-object', '-w', '--stdin'], contents + '\n')
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${name}`])
    }
    if (canvas) git(['update-index', '--add', '--cacheinfo', `160000,${canvas},integrations/infinite-canvas`])
    const tree = git(['write-tree'])
    return git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'fixture'])
  }
  const upstream19 = commit({ upstream: '19' })
  const upstream20 = commit({ upstream: '20' }, upstream19)
  const upstream21 = commit({ upstream: '21' }, upstream20)
  git(['update-ref', 'refs/tags/v0.2.20', upstream20])
  git(['update-ref', 'refs/tags/v0.2.21', upstream21])
  const oldMain = commit({ repository: 'old' }, '', upstream19)
  const main = commit({ repository: 'current' }, oldMain, upstream19)
  git(['update-ref', 'refs/heads/main', main])
  const metadata = (version, kind, upstreamSha, upstreamTag, upstreamId, content) => ({
    '.apophis-release-version': version,
    '.apophis-release-kind': kind,
    '.apophis-upstream-sha': upstreamSha,
    '.apophis-upstream-release-tag': upstreamTag,
    '.apophis-upstream-release-id': upstreamId,
    '.apophis-repository-upstream-sha': upstreamSha,
    '.apophis-repository-upstream-tag': upstreamTag,
    '.apophis-repository-sha': staleRepository ? oldMain : main,
    'fixture-content': content,
  })
  const candidateFiles = metadata(generatedVersion, candidateKind, upstream20, 'v0.2.20', 'release-20', 'candidate')
  const candidate = commit(candidateFiles, '', upstream19)
  const latestFiles = publicVersion === generatedVersion
    ? { ...candidateFiles, 'fixture-content': candidateTreeChanged ? 'previous-public-snapshot' : 'candidate' }
    : metadata(publicVersion, 'upstream', upstream19, 'v0.2.19', 'release-19', 'public')
  const latest = commit(latestFiles, '', upstream19)
  git(['update-ref', 'refs/remotes/origin/themed-release', candidate])
  if (latestStatus === 200) git(['update-ref', `refs/tags/v${publicVersion}`, latest])
  git(['remote', 'add', 'origin', '.'])
  git(['remote', 'add', 'upstream', '.'])
  await mkdir(path.join(root, 'scripts/ci'), { recursive: true })
  await mkdir(path.join(root, 'scripts/lib'), { recursive: true })
  await writeFile(path.join(root, 'scripts/ci/retry.sh'), 'retry_with_backoff() { shift 2; "$@"; }\n')
  for (const file of ['scripts/ci/release-identity.sh', 'scripts/next-release-version.mjs', 'scripts/lib/release-version.mjs']) {
    await copyFile(path.join(repositoryRoot, file), path.join(root, file))
  }
  await writeFile(path.join(root, 'latest.json'), JSON.stringify({ tag_name: `v${publicVersion}` }))
  await writeFile(path.join(root, 'binary.json'), JSON.stringify({
    isDraft: draft, isPrerelease: false, targetCommitish: 'themed-release',
    assets: [
      ...['linux_amd64.tar.gz', 'linux_arm64.tar.gz', 'windows_amd64.zip', 'darwin_amd64.tar.gz', 'darwin_arm64.tar.gz']
        .map((platform) => ({ name: `sub2api_${generatedVersion}_${platform}` })),
      { name: 'checksums.txt' },
    ],
  }))
  await writeFile(path.join(root, 'commands.log'), '')
  await writeFile(path.join(root, 'environment.txt'), '')
  await writeFile(path.join(root, 'mock-jq.mjs'), `
import { readFileSync } from 'node:fs'
const [flag, filter, filename] = process.argv.slice(2)
if (flag !== '-r') throw new Error('Unexpected jq flags')
const value = JSON.parse(readFileSync(filename, 'utf8'))
if (filter === '.assets[].name') console.log(value.assets.map((asset) => asset.name).join('\\n'))
else if (filter.startsWith('.tag_name')) console.log(value.tag_name || '')
else if (['.isDraft', '.isPrerelease', '.targetCommitish'].includes(filter)) console.log(value[filter.slice(1)])
else throw new Error('Unexpected jq filter: ' + filter)
`)
  const mocks = `
gh() {
  printf 'gh %s\\n' "$*" >> commands.log
  if [[ "$1" == api ]]; then
    if [[ "$MOCK_LATEST_STATUS" != 200 ]]; then
      echo "gh: Request failed (HTTP $MOCK_LATEST_STATUS)" >&2
      return 1
    fi
    cat latest.json
  elif [[ "$1 $2" == 'release view' ]]; then cat binary.json
  else return 97; fi
}
git() { printf 'git %s\\n' "$*" >> commands.log; command git "$@"; }
node() { printf 'node %s\\n' "$*" >> commands.log; command node "$@"; }
jq() { node mock-jq.mjs "$@"; }
`
  // Keep all fixed workflow scratch files inside this test's temporary root.
  const script = runStep('Decide whether a release is needed').replaceAll('/tmp/apophis-', './apophis-')
  await writeFile(path.join(root, 'decide.sh'), mocks + '\n' + script)
  const result = spawnSync(bash, ['./decide.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_ENV: path.join(root, 'environment.txt').replaceAll('\\', '/'),
      GITHUB_REPOSITORY: 'test/repo', GENERATED_DIR: root.replaceAll('\\', '/'),
      MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*',
      RELEASE_KIND: 'upstream', RELEASE_SOURCE_SHA: newUpstream ? upstream21 : upstream20,
      MOCK_LATEST_STATUS: String(latestStatus),
      RELEASE_VERSION_OVERRIDE: releaseVersionOverride, UPSTREAM_SHA: newUpstream ? upstream21 : upstream20,
      UPSTREAM_RELEASE_TAG: newUpstream ? 'v0.2.21' : 'v0.2.20',
      UPSTREAM_RELEASE_ID: newUpstream ? 'release-21' : 'release-20',
    },
  })
  assert.equal(result.status, expectedExitCode, result.stderr)
  return {
    result, candidate, main,
    env: environmentValues(await readFile(path.join(root, 'environment.txt'), 'utf8')),
    commands: await readFile(path.join(root, 'commands.log'), 'utf8'),
  }
}

test('a staged candidate newer than the public release is repaired without minting another version', async (t) => {
  const data = await decide(t)
  assert.equal(data.env.NEEDS_BINARY_RELEASE, 'true')
  assert.equal(data.env.SHOULD_PUBLISH, 'false')
  assert.equal(data.env.BINARY_RELEASE_VERSION, '0.2.10')
  assert.equal(data.env.BINARY_RELEASE_REF, data.candidate)
  assert.doesNotMatch(data.commands, /node scripts\/next-release-version\.mjs/)
})

test('an interrupted same-version republish repairs a different candidate tree despite matching public metadata', async (t) => {
  const data = await decide(t, { publicVersion: '0.2.10', draft: false, candidateTreeChanged: true })
  assert.equal(data.env.NEEDS_BINARY_RELEASE, 'true')
  assert.equal(data.env.SHOULD_PUBLISH, 'false')
  assert.equal(data.env.BINARY_RELEASE_VERSION, '0.2.10')
  assert.equal(data.env.BINARY_RELEASE_REF, data.candidate)
  assert.match(data.result.stdout, /snapshot has not been published/)
  assert.doesNotMatch(data.commands, /node scripts\/next-release-version\.mjs/)
})

test('repository candidate repair clears expected upstream identity in binary outputs', async (t) => {
  const data = await decide(t, { candidateKind: 'repository' })
  const result = await outputs(t, data.env)
  assert.equal(data.env.BINARY_RELEASE_KIND, 'repository')
  assert.equal(result.run_binary, 'true')
  assert.equal(result.release_ref, data.candidate)
  assert.equal(result.release_version, '0.2.10')
  assert.equal(result.upstream_release_tag, '')
  assert.equal(result.upstream_sha, '')
})

test('an incomplete candidate behind main is rebuilt at its existing version', async (t) => {
  const data = await decide(t, { staleRepository: true, candidateKind: 'repository' })
  assert.equal(data.env.SHOULD_PUBLISH, 'true')
  assert.equal(data.env.RELEASE_VERSION, '0.2.10')
  assert.equal(data.env.RELEASE_KIND, 'repository')
  assert.equal(data.env.RELEASE_SOURCE_SHA, data.main)
  assert.doesNotMatch(data.commands, /node scripts\/next-release-version\.mjs/)
})

test('healthy publication still skips ordinary main drift without publishing repository edits', async (t) => {
  const data = await decide(t, { publicVersion: '0.2.10', draft: false, staleRepository: true })
  assert.equal(data.env.NEEDS_BINARY_RELEASE, 'false')
  assert.equal(data.env.SHOULD_PUBLISH, 'false')
  assert.equal(data.env.RELEASE_VERSION, undefined)
  assert.match(data.result.stdout, /Repository source drift is intentionally not published/)
  assert.doesNotMatch(data.commands, /node scripts\/next-release-version\.mjs/)
})

test('a new upstream release preserves the normal next-version publication path', async (t) => {
  const data = await decide(t, { publicVersion: '0.2.10', draft: false, newUpstream: true })
  assert.equal(data.env.NEEDS_BINARY_RELEASE, 'false')
  assert.equal(data.env.SHOULD_PUBLISH, 'true')
  assert.equal(data.env.RELEASE_VERSION, '0.2.11')
  assert.match(data.commands, /node scripts\/next-release-version\.mjs 0\.2\.10/)
})

test('the only release can recover from draft even when latest returns 404 and its tag is absent', async (t) => {
  const data = await decide(t, { latestStatus: 404 })
  assert.equal(data.env.NEEDS_BINARY_RELEASE, 'true')
  assert.equal(data.env.SHOULD_PUBLISH, 'false')
  assert.equal(data.env.BINARY_RELEASE_VERSION, '0.2.10')
  assert.equal(data.env.BINARY_RELEASE_REF, data.candidate)
  assert.doesNotMatch(data.commands, /git fetch --force origin refs\/tags\/v0\.2\.10/)
  assert.doesNotMatch(data.commands, /node scripts\/next-release-version\.mjs/)
})

test('latest-release authorization errors cannot fall back to an unverified candidate', async (t) => {
  const data = await decide(t, { latestStatus: 403, expectedExitCode: 1 })
  assert.match(data.result.stderr, /HTTP 403/)
  assert.equal(data.env.SHOULD_PUBLISH, undefined)
  assert.doesNotMatch(data.commands, /gh release view/)
})

test('an explicit version remains authoritative when the synchronized binary release needs repair', async (t) => {
  const data = await decide(t, { publicVersion: '0.2.10', releaseVersionOverride: '0.2.11' })
  assert.equal(data.env.NEEDS_BINARY_RELEASE, 'true')
  assert.equal(data.env.SHOULD_PUBLISH, 'true')
  assert.equal(data.env.RELEASE_VERSION, '0.2.11')
  assert.doesNotMatch(data.commands, /node scripts\/next-release-version\.mjs/)
})
