import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'D:/Program Files/Git/bin/bash.exe' : 'bash')
const root = path.resolve('.')
const digest = `sha256:${'a'.repeat(64)}`
const oldDigest = `sha256:${'b'.repeat(64)}`
const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')

function runStep(name) {
  const lines = workflow.split(/\r?\n/)
  const start = lines.findIndex((line) => line === `      - name: ${name}`)
  assert.ok(start >= 0)
  const body = []
  let running = false
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith(running ? '          ' : '        ')) break
    if (running) body.push(line.slice(10))
    if (line === '        run: |') running = true
  }
  assert.ok(running)
  return body.join('\n')
}

async function execute(t, { alias = 'old', expected = digest, pullFailure = false, corruptPush = false, sourcePush = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-image-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(path.join(directory, 'scripts/ci'), { recursive: true })
  for (const file of ['image-digest.sh', 'align-release-image.sh']) {
    await copyFile(path.join(root, 'scripts/ci', file), path.join(directory, 'scripts/ci', file))
  }
  await writeFile(path.join(directory, 'scripts/ci/retry.sh'), 'retry_with_backoff() { shift 2; "$@"; }\n')
  await writeFile(path.join(directory, 'commands.log'), '')
  await writeFile(path.join(directory, 'environment.txt'), '')
  const mocks = `
docker() {
  printf 'docker %s\\n' "$*" >> commands.log
  case "$1 $2 \${3:-}" in
    'buildx imagetools inspect')
      if [[ "$4" == *:upstream-source ]]; then
        printf '%s\\n' "$MOCK_DIGEST"
      elif [[ -f alias-updated ]]; then
        if [[ "$MOCK_CORRUPT_PUSH" == true ]]; then printf '%s\\n' "$MOCK_OLD_DIGEST"
        else printf '%s\\n' "$MOCK_DIGEST"; fi
      else
        case "$MOCK_ALIAS" in
          same) printf '%s\\n' "$MOCK_DIGEST" ;;
          old) printf '%s\\n' "$MOCK_OLD_DIGEST" ;;
          missing) echo 'manifest unknown' >&2; return 1 ;;
          unauthorized) echo 'unauthorized: authentication required' >&2; return 1 ;;
          *) return 98 ;;
        esac
      fi
      ;;
    *)
      case "$1" in
        pull)
          if [[ "$MOCK_PULL_FAILURE" == true ]]; then return 1; fi
          [[ "$2" == "ghcr.io/test/repo@$MOCK_DIGEST" ]] || return 99
          ;;
        tag) [[ "$2" == "ghcr.io/test/repo@$MOCK_DIGEST" ]] || return 99 ;;
        push) [[ "$2" != *:1.2.3 ]] || touch alias-updated ;;
        *) return 99 ;;
      esac
      ;;
  esac
}
`
  const body = sourcePush ? runStep('Push immutable themed image') : 'source scripts/ci/align-release-image.sh ghcr.io/test/repo 1.2.3 "$MOCK_EXPECTED"'
  await writeFile(path.join(directory, 'test.sh'), mocks + '\n' + body)
  const result = spawnSync(bash, ['./test.sh'], {
    cwd: directory, encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'test/repo',
      GITHUB_ENV: path.join(directory, 'environment.txt').replaceAll('\\', '/'),
      RELEASE_IMAGE_TAG: 'upstream-source', RELEASE_VERSION: '1.2.3',
      MOCK_ALIAS: alias, MOCK_EXPECTED: expected, MOCK_DIGEST: digest, MOCK_OLD_DIGEST: oldDigest,
      MOCK_PULL_FAILURE: String(pullFailure), MOCK_CORRUPT_PUSH: String(corruptPush),
    },
  })
  return {
    result,
    commands: await readFile(path.join(directory, 'commands.log'), 'utf8'),
    environment: await readFile(path.join(directory, 'environment.txt'), 'utf8'),
  }
}

test('source-image publication records a digest without touching the public version alias', async (t) => {
  const data = await execute(t, { sourcePush: true })
  assert.equal(data.result.status, 0, data.result.stderr)
  assert.match(data.commands, /docker push ghcr.io\/test\/repo:upstream-source/)
  assert.doesNotMatch(data.commands, /docker (?:push|tag|pull).*:1\.2\.3/)
  assert.match(data.environment, new RegExp(`RELEASE_IMAGE_DIGEST=${digest}`))
  const publish = workflow.indexOf('name: Update generated release branch')
  const record = workflow.indexOf('> .apophis-image-digest', publish)
  const push = workflow.indexOf('git push --no-thin', publish)
  const alias = workflow.indexOf('name: Align version image with recorded release candidate')
  assert.ok(publish < record && record < push && push < alias)
})

for (const alias of ['missing', 'old']) {
  test(`recorded digest restores a ${alias} version alias without trusting a mutable source tag`, async (t) => {
    const data = await execute(t, { alias })
    assert.equal(data.result.status, 0, data.result.stderr)
    assert.ok(data.commands.includes(`docker pull ghcr.io/test/repo@${digest}`))
    assert.match(data.commands, /docker push ghcr.io\/test\/repo:1\.2\.3/)
    assert.doesNotMatch(data.commands, /upstream-source/)
  })
}

test('an already aligned version alias requires no pull or push', async (t) => {
  const data = await execute(t, { alias: 'same' })
  assert.equal(data.result.status, 0, data.result.stderr)
  assert.doesNotMatch(data.commands, /docker (?:pull|tag|push)/)
})

test('an unavailable recorded image cannot alter a version alias', async (t) => {
  const data = await execute(t, { pullFailure: true })
  assert.notEqual(data.result.status, 0)
  assert.doesNotMatch(data.commands, /docker (?:tag|push)/)
})

test('registry authorization errors cannot be treated as an absent version alias', async (t) => {
  const data = await execute(t, { alias: 'unauthorized' })
  assert.notEqual(data.result.status, 0)
  assert.doesNotMatch(data.commands, /docker (?:pull|tag|push)/)
})

test('alias publication must preserve the recorded digest', async (t) => {
  const data = await execute(t, { corruptPush: true })
  assert.notEqual(data.result.status, 0)
})

test('legacy snapshots preserve their existing version image and never guess a replacement', async (t) => {
  const existing = await execute(t, { expected: '' })
  assert.equal(existing.result.status, 0, existing.result.stderr)
  assert.doesNotMatch(existing.commands, /docker (?:pull|tag|push)/)
  const missing = await execute(t, { expected: '', alias: 'missing' })
  assert.notEqual(missing.result.status, 0)
  assert.doesNotMatch(missing.commands, /docker (?:pull|tag|push)/)
})
