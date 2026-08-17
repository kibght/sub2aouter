import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Go security baseline uses 1.26.6 across modules, images, and workflows', async () => {
  const [goMod, rootDockerfile, backendDockerfile, deployDockerfile, release, security] = await Promise.all([
    readFile('backend/go.mod', 'utf8'),
    readFile('Dockerfile', 'utf8'),
    readFile('backend/Dockerfile', 'utf8'),
    readFile('deploy/Dockerfile', 'utf8'),
    readFile('.github/workflows/release.yml', 'utf8'),
    readFile('.github/workflows/security-scan.yml', 'utf8'),
  ])

  assert.match(goMod, /^go 1\.26\.6$/m)
  for (const dockerfile of [rootDockerfile, backendDockerfile, deployDockerfile]) {
    assert.match(dockerfile, /golang:1\.26\.6-alpine/)
    assert.doesNotMatch(dockerfile, /1\.26\.5/)
  }
  for (const workflow of [release, security]) {
    assert.match(workflow, /GO_VERSION="\$\(awk '\$1 == "go" \{ print \$2; exit \}' backend\/go\.mod\)"/)
    assert.match(workflow, /test "\$\(go env GOVERSION\)" = "go\$\{GO_VERSION\}"/)
    assert.doesNotMatch(workflow, /go1\.26\.5/)
  }
})
