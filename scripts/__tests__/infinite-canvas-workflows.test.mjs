import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Sub2 upstream releases carry and verify the Infinite Canvas integration', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  assert.match(workflow, /git rev-parse HEAD:integrations\/infinite-canvas/)
  assert.match(workflow, /apply-sub2-infinite-canvas-integration\.mjs --root "\$GENERATED_DIR"/)
  assert.match(workflow, /apply-sub2-infinite-canvas-integration\.mjs --root \. --check/)
  assert.match(workflow, /submodule update --init --depth=1/)
  assert.match(workflow, /cp \.github\/workflows\/infinite-canvas-upstream-sync\.yml/)
  assert.match(workflow, /cp \.github\/workflows\/backend-ci\.yml/)
  assert.match(workflow, /apply-infinite-canvas-patches\.mjs --root \"\$GENERATED_DIR\/integrations\/infinite-canvas\"/)
})

test('Infinite Canvas upstream updates are gated by adapter checks and pull requests', async () => {
  const workflow = await readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8')
  assert.match(workflow, /schedule:/)
  assert.match(workflow, /apply-infinite-canvas-patches\.mjs/)
  assert.match(workflow, /bun run typecheck/)
  assert.match(workflow, /bun run build/)
  assert.match(workflow, /pushd integrations\/infinite-canvas\/web/)
  assert.match(workflow, /popd/)
  assert.doesNotMatch(workflow, /cd \.\.\/\.\./)
  assert.match(workflow, /gh pr create/)
  assert.match(workflow, /actions:\s*write/)
  assert.match(workflow, /PR_HEAD_SHA=.*headRefOid/)
  assert.match(workflow, /\[\[ "\$PR_HEAD_SHA" == "\$UPDATE_SHA" \]\]/)
  assert.match(workflow, /gh pr merge "\$PR_NUMBER"[^\n]*--match-head-commit "\$UPDATE_SHA"/)
  assert.match(workflow, /gh workflow run upstream-theme-sync\.yml/)
  assert.match(workflow, /repository_release=false/)
  assert.match(workflow, /scheduled_round=true/)
  assert.match(workflow, /needs\.update\.outputs\.changed/)
  const patchScript = await readFile('scripts/apply-infinite-canvas-patches.mjs', 'utf8')
  const integrationScript = await readFile('scripts/apply-sub2-infinite-canvas-integration.mjs', 'utf8')
  assert.match(integrationScript, /reconcileInfiniteCanvasLocaleBlock/)
  assert.match(patchScript, /web\/src\/pages\/home\/index\.tsx/)
  assert.match(patchScript, /navigate\(\"\/image\"\)/)
})


test('both upstream workflows inspect published release metadata before syncing', async () => {
  const sub2Workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const canvasWorkflow = await readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8')

  assert.match(sub2Workflow, /node scripts\/resolve-github-release\.mjs[\s\S]*--repository Wei-Shaw\/sub2api/)
  assert.match(sub2Workflow, /UPSTREAM_RELEASE_TAG/)
  assert.match(canvasWorkflow, /CANVAS_REPOSITORY: basketikun\/infinite-canvas/)
  assert.match(canvasWorkflow, /node scripts\/resolve-github-release\.mjs[\s\S]*--repository "\$CANVAS_REPOSITORY"/)
  assert.match(canvasWorkflow, /INFINITE_CANVAS_RELEASE_TAG/)
})

test('repository and canvas drift are recovered before release publication', async () => {
  const syncWorkflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const binaryWorkflow = await readFile('.github/workflows/theme-binary-release.yml', 'utf8')

  assert.match(syncWorkflow, /repository_release:/)
  assert.match(syncWorkflow, /CURRENT_REPOSITORY_SHA/)
  assert.match(syncWorkflow, /PREVIOUS_CANVAS_SHA/)
  assert.match(syncWorkflow, /PREVIOUS_REPOSITORY_SHA.*PREVIOUS_CANVAS_SHA/)
  assert.match(syncWorkflow, /\.apophis-canvas-sha/)
  assert.match(syncWorkflow, /name: Verify Infinite Canvas dependency is current/)
  assert.match(syncWorkflow, /LATEST_CANVAS_SHA/)
  assert.match(binaryWorkflow, /name: Verify themed release matches main repository and canvas/)
  assert.match(binaryWorkflow, /RELEASE_REPOSITORY_SHA/)
  assert.match(binaryWorkflow, /MAIN_CANVAS_SHA/)
  assert.match(binaryWorkflow, /RELEASE_CANVAS_SHA/)
  assert.match(binaryWorkflow, /LATEST_CANVAS_SHA/)
})

test('the themed binary release verifies all requested platform artifacts before publishing', async () => {
  const workflow = await readFile('.github/workflows/theme-binary-release.yml', 'utf8')
  const goreleaser = await readFile('.goreleaser.theme.yaml', 'utf8')

  assert.match(goreleaser, /goos: \[linux, windows, darwin\]/)
  assert.match(goreleaser, /goarch: \[amd64, arm64\]/)
  assert.match(workflow, /name: Verify GoReleaser artifacts/)
  assert.match(workflow, /linux.*amd64/)
  assert.match(workflow, /windows.*amd64/)
  assert.match(workflow, /darwin.*arm64/)
  assert.match(workflow, /dist\/checksums\.txt/)
})


test('theme sync awaits one reusable binary publication before promoting latest', async () => {
  const [syncWorkflow, binaryWorkflow] = await Promise.all([
    readFile('.github/workflows/upstream-theme-sync.yml', 'utf8'),
    readFile('.github/workflows/theme-binary-release.yml', 'utf8'),
  ])

  assert.match(syncWorkflow, /outputs:[\s\S]*run_binary:[\s\S]*should_promote_latest:[\s\S]*release_ref:[\s\S]*release_version:/)
  assert.match(syncWorkflow, /binary-release:\n\s+needs: sync-build-publish/)
  assert.match(syncWorkflow, /uses: \.\/\.github\/workflows\/theme-binary-release\.yml/)
  assert.match(syncWorkflow, /release_ref: \$\{\{ needs\.sync-build-publish\.outputs\.release_ref \}\}/)
  assert.doesNotMatch(syncWorkflow, /gh workflow run theme-binary-release\.yml/)
  assert.match(syncWorkflow, /promote-latest:\n\s+needs: \[sync-build-publish, binary-release\]/)
  assert.match(syncWorkflow, /needs\.binary-release\.result == 'success'/)
  assert.match(syncWorkflow, /docker pull "\$\{IMAGE\}:\$\{RELEASE_VERSION\}"/)
  assert.match(syncWorkflow, /docker push "\$\{IMAGE\}:latest"/)

  assert.match(binaryWorkflow, /workflow_call:[\s\S]*release_ref:/)
  assert.match(binaryWorkflow, /workflow_dispatch:[\s\S]*release_ref:/)
  assert.doesNotMatch(binaryWorkflow, /workflow_run:/)
  assert.match(binaryWorkflow, /ref: \$\{\{ inputs\.release_ref \|\| 'themed-release' \}\}/)
  assert.match(binaryWorkflow, /group: themed-binary-release-\$\{\{ inputs\.release_ref \|\| github\.run_id \}\}/)
})


test('hourly sync recovers missing or incomplete binary releases without minting another version', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')

  assert.match(workflow, /NEEDS_BINARY_RELEASE/)
  assert.match(workflow, /gh release view "\$PREVIOUS_RELEASE_TAG"/)
  assert.match(workflow, /targetCommitish/)
  assert.match(workflow, /\.assets\[\]\.name/)
  assert.match(workflow, /sub2api_\$\{PREVIOUS_RELEASE_VERSION\}_linux_amd64\.tar\.gz/)
  assert.match(workflow, /run_binary=\$RUN_BINARY/)
  assert.match(workflow, /effective_version=\$EFFECTIVE_VERSION/)
})

test('binary release repairs incomplete assets and verifies the published result', async () => {
  const workflow = await readFile('.github/workflows/theme-binary-release.yml', 'utf8')

  assert.match(workflow, /RELEASE_EXISTS/)
  assert.match(workflow, /gh release upload "\$RELEASE_TAG"[\s\S]*--clobber/)
  assert.match(workflow, /gh release edit "\$RELEASE_TAG"/)
  assert.match(workflow, /name: Verify published GitHub release/)
  assert.match(workflow, /Missing published release asset/)
  assert.match(workflow, /grep -Fqx/)
})

test('new upstream releases are not mistaken for binary-only repairs', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')

  const identityIndex = workflow.indexOf('UPSTREAM_IDENTITY_AND_SHA_MATCH=false')
  const repairIndex = workflow.indexOf('Upstream source is synchronized, but its binary release needs repair.')
  const nextVersionIndex = workflow.indexOf('node scripts/next-release-version.mjs')
  assert.ok(identityIndex >= 0)
  assert.ok(repairIndex > identityIndex)
  assert.ok(nextVersionIndex > repairIndex)
  assert.match(workflow, /\$UPSTREAM_ALREADY_SYNCHRONIZED" == "true"/)
})

test('the Canvas workflow is the single hourly upstream coordinator', async () => {
  const sub2Workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const canvasWorkflow = await readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8')

  assert.match(canvasWorkflow, /cron:\s*'17 \* \* \* \*'/)
  assert.doesNotMatch(sub2Workflow, /schedule:/)
  assert.match(canvasWorkflow, /needs\.update\.outputs\.changed/)
  assert.match(canvasWorkflow, /gh workflow run upstream-theme-sync\.yml[\s\S]*repository_release=false/)
  assert.doesNotMatch(canvasWorkflow, /repository_release=true/)
  assert.match(sub2Workflow, /workflow_dispatch:/)
  assert.match(sub2Workflow, /github\.event_name != 'push' \|\| !contains\(github\.event\.head_commit\.message, 'Infinite Canvas'\)/)
})

test('Infinite Canvas merge waits for reusable full CI at the update commit', async () => {
  const [workflow, ciWorkflow] = await Promise.all([
    readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8'),
    readFile('.github/workflows/backend-ci.yml', 'utf8'),
  ])

  assert.match(ciWorkflow, /workflow_call:/)
  assert.match(ciWorkflow, /ref:\n\s+description: Commit, branch, or tag to verify/)
  assert.equal(
    (ciWorkflow.match(/ref: \$\{\{ inputs\.ref \|\| github\.sha \}\}/g) || []).length,
    5,
  )
  assert.match(workflow, /full-ci:\n[\s\S]*uses: \.\/\.github\/workflows\/backend-ci\.yml/)
  assert.match(workflow, /ref: \$\{\{ needs\.update\.outputs\.update_sha \}\}/)
  assert.match(workflow, /merge:\n[\s\S]*needs: \[update, full-ci\]/)
  assert.match(workflow, /gh pr merge[^\n]*--repo "\$GITHUB_REPOSITORY"/)
  assert.match(workflow, /gh workflow run upstream-theme-sync\.yml[^\n]*\n\s+--repo "\$GITHUB_REPOSITORY"/)

  const reusableGate = workflow.indexOf('uses: ./.github/workflows/backend-ci.yml')
  const merge = workflow.indexOf('gh pr merge')
  assert.ok(reusableGate >= 0 && merge > reusableGate)
})

test('Infinite Canvas documentation describes the reusable CI merge gate', async () => {
  const docs = await Promise.all([
    readFile('docs/infinite-canvas.md', 'utf8'),
    readFile('scripts/infinite-canvas-integration/sub2-files/docs/infinite-canvas.md', 'utf8'),
  ])

  for (const document of docs) {
    assert.match(document, /backend-ci\.yml/)
    assert.doesNotMatch(document, /auto-merge/)
  }
})


test('release discovery fails closed and keeps external tags out of run templates', async () => {
  const [sub2Workflow, canvasWorkflow] = await Promise.all([
    readFile('.github/workflows/upstream-theme-sync.yml', 'utf8'),
    readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8'),
  ])

  assert.match(sub2Workflow, /node scripts\/resolve-github-release\.mjs[\s\S]*--repository Wei-Shaw\/sub2api/)
  assert.match(sub2Workflow, /steps\.upstream_release\.outputs\.found/)
  assert.doesNotMatch(sub2Workflow, /releases\/latest[^\n]*\|\| true/)
  assert.match(sub2Workflow, /refs\/apophis\/upstream-release/)
  assert.doesNotMatch(sub2Workflow, /:refs\/tags\/\$\{UPSTREAM_RELEASE_TAG\}/)
  assert.match(
    sub2Workflow,
    /merge-base --is-ancestor "\$PREVIOUS_UPSTREAM_SHA" "\$UPSTREAM_SHA"/,
  )
  assert.match(
    sub2Workflow,
    /PREVIOUS_UPSTREAM_RELEASE_ID[\s\S]*UPSTREAM_RELEASE_ID[\s\S]*PREVIOUS_UPSTREAM_SHA[\s\S]*UPSTREAM_SHA/,
  )

  assert.match(canvasWorkflow, /node scripts\/resolve-github-release\.mjs[\s\S]*--repository "\$CANVAS_REPOSITORY"/)
  assert.doesNotMatch(canvasWorkflow, /releases\/latest[^\n]*\|\| true/)
  assert.match(canvasWorkflow, /RELEASE_FOUND: \$\{\{ steps\.canvas_release\.outputs\.found \}\}/)
  assert.match(canvasWorkflow, /RELEASE_TAG: \$\{\{ steps\.canvas_release\.outputs\.tag \}\}/)
  assert.doesNotMatch(canvasWorkflow, /RELEASE_TAG="\$\{\{ steps\.canvas_release\.outputs\.tag \}\}"/)
  assert.match(
    canvasWorkflow,
    /git -C integrations\/infinite-canvas merge-base --is-ancestor "\$CURRENT_SHA" "\$LATEST_SHA"/,
  )
})

test('Canvas merge is bound to the exact SHA that passed full CI', async () => {
  const workflow = await readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8')

  assert.match(workflow, /UPDATE_SHA: \$\{\{ needs\.update\.outputs\.update_sha \}\}/)
  assert.match(workflow, /--json headRefOid --jq '\.headRefOid'/)
  assert.match(workflow, /\[\[ "\$PR_HEAD_SHA" == "\$UPDATE_SHA" \]\]/)
  assert.match(workflow, /--match-head-commit "\$UPDATE_SHA"/)
})

test('synchronization workflows use reusable incident alerts', async () => {
  const canvas = await readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8')
  const sync = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const alert = await readFile('.github/workflows/automation-alert.yml', 'utf8')

  assert.match(canvas, /uses: \.\/\.github\/workflows\/automation-alert\.yml/)
  assert.match(sync, /uses: \.\/\.github\/workflows\/automation-alert\.yml/)
  assert.match(alert, /workflow_call:/)
  assert.match(alert, /gh issue (create|comment)/)
  assert.match(alert, /TELEGRAM_BOT_TOKEN/)
})

test('the watchdog detects stale synchronization and dispatches only the coordinator', async () => {
  const watchdog = await readFile('.github/workflows/sync-watchdog.yml', 'utf8')

  assert.match(watchdog, /cron:\s*'41 \* \* \* \*'/)
  assert.match(watchdog, /node scripts\/check-sync-health\.mjs/)
  assert.match(watchdog, /gh workflow run infinite-canvas-upstream-sync\.yml/)
  assert.doesNotMatch(watchdog, /gh workflow run upstream-theme-sync\.yml/)
  assert.match(watchdog, /actions\/upload-artifact@/)
  assert.match(watchdog, /uses: \.\/\.github\/workflows\/automation-alert\.yml/)
  assert.match(watchdog, /steps\.health\.outputs\.state == 'healthy'/)
})

test('network-facing synchronization steps source the bounded retry helper', async () => {
  const canvas = await readFile('.github/workflows/infinite-canvas-upstream-sync.yml', 'utf8')
  const sync = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const retry = await readFile('scripts/ci/retry.sh', 'utf8')

  assert.match(retry, /retry_with_backoff\(\)/)
  assert.match(retry, /MAX_ATTEMPTS/)
  assert.match(canvas, /source scripts\/ci\/retry\.sh/)
  assert.match(sync, /source scripts\/ci\/retry\.sh/)
  assert.match(canvas, /retry_with_backoff .*git .*fetch/)
  assert.match(sync, /retry_with_backoff .*git .*fetch/)
})
