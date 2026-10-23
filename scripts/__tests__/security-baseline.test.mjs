import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

function goVersion(goMod) {
  const match = goMod.match(/^go (\d+\.\d+\.\d+)$/m)
  assert.ok(match, 'backend/go.mod must declare a full Go version')
  return match[1]
}

test('Go toolchain baseline stays aligned with upstream instead of pinning a stale migration', async () => {
  const [goMod, rootDockerfile, backendDockerfile, deployDockerfile, release, security, manifestText] = await Promise.all([
    readFile('backend/go.mod', 'utf8'),
    readFile('Dockerfile', 'utf8'),
    readFile('backend/Dockerfile', 'utf8'),
    readFile('deploy/Dockerfile', 'utf8'),
    readFile('.github/workflows/release.yml', 'utf8'),
    readFile('.github/workflows/security-scan.yml', 'utf8'),
    readFile('theme/apophis/manifest.json', 'utf8'),
  ])

  const version = goVersion(goMod)
  for (const dockerfile of [rootDockerfile, backendDockerfile, deployDockerfile]) {
    assert.match(dockerfile, new RegExp(`golang:${version.replaceAll('.', '\\.')}\\-alpine`))
  }

  const manifest = JSON.parse(manifestText)
  const staleTargets = new Set(['backend/go.mod', 'backend/Dockerfile', 'Dockerfile', 'deploy/Dockerfile'])
  const stalePatches = (manifest.patches || []).filter((entry) =>
    staleTargets.has(entry.target) && /go-version|dockerfile-go/i.test(entry.source || '')
  )
  assert.deepEqual(stalePatches, [])

  for (const workflow of [release, security]) {
    assert.match(workflow, /GO_VERSION="\$\(awk '\$1 == "go" \{ print \$2; exit \}' backend\/go\.mod\)"/)
    assert.match(workflow, /test "\$\(go env GOVERSION\)" = "go\$\{GO_VERSION\}"/)
  }
})
