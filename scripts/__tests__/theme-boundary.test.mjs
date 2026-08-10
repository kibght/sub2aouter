import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')

test('theme overlay never targets backend implementation files', async () => {
  const manifest = JSON.parse(await read('theme/apophis/manifest.json'))
  const targets = [
    ...(manifest.additions || []).map((entry) => entry.target),
    ...(manifest.files || []).map((entry) => entry.target),
    ...(manifest.patches || []).map((entry) => entry.target),
  ]
  assert.deepEqual([...new Set(targets.filter((target) => target === 'backend' || target.startsWith('backend/')))], ['backend/internal/service/update_service.go'])
})

test('shipped theme contains no target-site brand, domain, or account credentials', async () => {
  const manifest = JSON.parse(await read('theme/apophis/manifest.json'))
  const sources = [
    ...(manifest.additions || []).map((entry) => `theme/apophis/${entry.source}`),
    ...(manifest.files || []).map((entry) => `theme/apophis/${entry.source}`),
    ...(manifest.patches || []).filter((entry) => entry.source).map((entry) => `theme/apophis/${entry.source}`),
  ]
  const content = (await Promise.all(sources.map((source) => read(source)))).join('\n')
  assert.doesNotMatch(content, /www\.apophis\.uk|ApophisCode/i)
})

test('site branding remains driven by system settings across public and authenticated shells', async () => {
  const [home, auth, sidebar] = await Promise.all([
    read('frontend/src/components/apophis/ApophisHomeView.vue'),
    read('frontend/src/components/layout/AuthLayout.vue'),
    read('frontend/src/components/layout/AppSidebar.vue'),
  ])
  assert.match(home, /cachedPublicSettings\?\.site_name/)
  assert.match(home, /cachedPublicSettings\?\.site_logo/)
  assert.match(home, /\{\{ siteName \}\}/)
  assert.match(home, /:src="siteLogo \|\| '\/logo\.svg'"/)
  assert.match(home, /© \{\{ currentYear \}\} \{\{ siteName \}\}/)
  assert.match(auth, /\{\{ siteName \}\}/)
  assert.match(auth, /:src="siteLogo \|\| '\/logo\.svg'"/)
  assert.match(sidebar, /\{\{ siteName \}\}/)
  assert.match(sidebar, /:src="siteLogo \|\| '\/logo\.svg'"/)
})

test('generated releases carry upstream test compatibility fixes required by the full suite', async () => {
  const manifest = JSON.parse(await read('theme/apophis/manifest.json'))
  const targets = new Set((manifest.files || []).map((entry) => entry.target))
  for (const target of [
    'frontend/src/api/__tests__/admin.system.rollback.spec.ts',
    'frontend/src/views/admin/__tests__/GroupsView.columnSettings.spec.ts',
    'frontend/src/views/admin/__tests__/GroupsView.duplicate.spec.ts',
  ]) {
    assert.ok(targets.has(target), `${target} must survive upstream generation`)
  }
})

test('panel updater and binary release workflow use the custom repository', async () => {
  const [service, workflow, manifestText] = await Promise.all([
    read('backend/internal/service/update_service.go'),
    read('.github/workflows/theme-binary-release.yml'),
    read('theme/apophis/manifest.json'),
  ])
  assert.match(service, /githubRepo\s+= "kibght\/sub2aouter"/)
  assert.match(workflow, /workflow_call:/)
  assert.doesNotMatch(workflow, /workflow_run:/)
  assert.match(workflow, /gh release create/)
  assert.match(workflow, /checksums\.txt/)
  const manifest = JSON.parse(manifestText)
  assert.ok((manifest.patches || []).some(
    (entry) => entry.source === 'patches/update-repository.txt' &&
      entry.target === 'backend/internal/service/update_service.go',
  ))
  assert.ok((manifest.patches || []).every((entry) => entry.sentinel !== 'func isThemedReleaseVersion'))
  assert.ok((manifest.additions || []).some((entry) => entry.target === '.github/workflows/theme-binary-release.yml'))
})

test('the unified upstream round runs hourly and skips unchanged revisions', async () => {
  const workflow = await read('.github/workflows/upstream-theme-sync.yml')
  const coordinator = await read('.github/workflows/infinite-canvas-upstream-sync.yml')
  assert.match(coordinator, /cron:\s*'7 \* \* \* \*'/)
  assert.doesNotMatch(workflow, /schedule:/)
  assert.match(workflow, /scheduled_round:/)
  assert.match(workflow, /SCHEDULED_ROUND/)
  assert.match(workflow, /github\.event_name[^\n]+schedule.*SCHEDULED_ROUND/)
  assert.match(workflow, /\.apophis-upstream-sha/)
  assert.match(workflow, /SHOULD_PUBLISH/)
})

test('Docker images and binary releases share one generated release version', async () => {
  const [syncWorkflow, binaryWorkflow] = await Promise.all([
    read('.github/workflows/upstream-theme-sync.yml'),
    read('.github/workflows/theme-binary-release.yml'),
  ])
  assert.match(syncWorkflow, /PREVIOUS_RELEASE_VERSION/)
  assert.match(syncWorkflow, /node scripts\/next-release-version\.mjs/)
  assert.doesNotMatch(syncWorkflow, /GITHUB_RUN_NUMBER/)
  assert.match(syncWorkflow, /backend\/cmd\/server\/VERSION/)
  assert.match(syncWorkflow, /\$\{IMAGE\}:\$\{RELEASE_VERSION\}/)
  assert.match(binaryWorkflow, /backend\/cmd\/server\/VERSION/)
  assert.match(binaryWorkflow, /gh release view/)
  assert.doesNotMatch(binaryWorkflow, /date -u/)
})

test('version badge keeps the official update flow with custom repository pointers', async () => {
  const [badge, manifestText] = await Promise.all([
    read('frontend/src/components/common/VersionBadge.vue'),
    read('theme/apophis/manifest.json'),
  ])
  assert.match(badge, /const GITHUB_REPO = 'kibght\/sub2aouter'/)
  assert.match(badge, /const DOCKER_IMAGE = 'ghcr\.io\/kibght\/sub2aouter'/)
  assert.match(badge, /const isReleaseBuild = computed\(\(\) => buildType\.value === 'release'\)/)
  assert.doesNotMatch(badge, /VERSION_REFRESH_INTERVAL_MS/)
  assert.doesNotMatch(badge, /buildType\.value === 'release' \|\| buildType\.value === 'docker'/)
  assert.doesNotMatch(badge, /isDockerBuild|dockerUpdateCommand/)

  const manifest = JSON.parse(manifestText)
  const versionBadgePatches = (manifest.patches || []).filter(
    (entry) => entry.target === 'frontend/src/components/common/VersionBadge.vue',
  )
  assert.deepEqual(versionBadgePatches.map((entry) => entry.source), [
    'patches/version-badge-repository.txt',
    'patches/version-badge-remove-refresh.txt',
    'patches/version-badge-official-state.txt',
    'patches/version-badge-official-lifecycle.txt',
  ])
})


test('Docker builds use the official release update path', async () => {
  const [dockerfile, badge, manifestText] = await Promise.all([
    read('Dockerfile'),
    read('frontend/src/components/common/VersionBadge.vue'),
    read('theme/apophis/manifest.json'),
  ])
  assert.match(dockerfile, /-X main\.BuildType=release/)
  assert.match(badge, /v-else-if="hasUpdate && !isReleaseBuild"/)
  assert.match(badge, /v-else-if="hasUpdate && isReleaseBuild"/)
  assert.doesNotMatch(badge, /buildType\.value === 'release' \|\| buildType\.value === 'docker'/)
  assert.doesNotMatch(badge, /@click="handleUpdate"[\s\S]*buildType\.value === 'docker'/)

  const manifest = JSON.parse(manifestText)
  assert.equal((manifest.patches || []).some((entry) => entry.target === 'Dockerfile' && entry.source === 'patches/dockerfile-build-type.txt'), false)
  assert.ok((manifest.patches || []).some((entry) => entry.target === 'Dockerfile' && entry.sentinel === 'id=sub2api-pnpm-store-v2,target=/root/.local/share/pnpm/store,sharing=locked,uid=0,gid=0,mode=0755'))
})

test('upstream sync captures release notes only for a release contained in the fetched source', async () => {
  const workflow = await read('.github/workflows/upstream-theme-sync.yml')
  assert.match(workflow, /repos\/Wei-Shaw\/sub2api\/releases\/latest/)
  assert.match(workflow, /gh api[\s\S]*--jq/)
  assert.doesNotMatch(workflow, /\n\s+jq -r/)
  assert.match(workflow, /merge-base --is-ancestor/)
  assert.match(workflow, /\.apophis-upstream-release-tag/)
  assert.match(workflow, /\.apophis-upstream-release-name/)
  assert.match(workflow, /\.apophis-upstream-release-url/)
  assert.match(workflow, /\.apophis-upstream-release-notes\.md/)
  assert.match(workflow, /git -C "\$GENERATED_DIR" log/)
})

test('repository release notes describe fixes instead of listing bare commit hashes', async () => {
  const workflow = await read('.github/workflows/upstream-theme-sync.yml')
  assert.match(workflow, /git log --reverse --format='- %s \(`%h`\)\.'/)
  assert.match(workflow, /git log -1 --format='%s'/)
  assert.doesNotMatch(workflow, /git log --reverse --format='%h'/)
})

test('repository release notes use the current push boundary before the last published repository revision', async () => {
  const workflow = await read('.github/workflows/upstream-theme-sync.yml')
  const pushBoundary = workflow.indexOf('BASE_SHA="${{ github.event.before }}"')
  const publishedFallback = workflow.indexOf('BASE_SHA="$PREVIOUS_REPOSITORY_SHA"', pushBoundary)
  assert.ok(pushBoundary >= 0, 'repository notes must start from the current push boundary')
  assert.ok(publishedFallback > pushBoundary, 'last published revision must only be a fallback')
})

test('themed binary releases publish generated repository or upstream notes from a common notes file', async () => {
  const [workflow, overlayWorkflow] = await Promise.all([
    read('.github/workflows/theme-binary-release.yml'),
    read('theme/apophis/files/.github/workflows/theme-binary-release.yml'),
  ])
  assert.match(workflow, /\.apophis-release-title/)
  assert.match(workflow, /\.apophis-release-notes\.md/)
  assert.match(workflow, /--notes-file/)
  assert.match(workflow, /RELEASE_TITLE/)
  assert.doesNotMatch(workflow, /--notes\s+"/)
  assert.equal(workflow, overlayWorkflow)
})

test('generated release branch is pushed as a self-contained root snapshot', async () => {
  const workflow = await read('.github/workflows/upstream-theme-sync.yml')
  assert.match(workflow, /git commit-tree/)
  assert.match(workflow, /refs\/heads\/themed-release/)
  assert.match(workflow, /git push --no-thin/)
  assert.doesNotMatch(workflow, /git switch -C themed-release/)
})
test('generated snapshot keeps and verifies the freshly generated workflow directory', async () => {
  const workflow = await read('.github/workflows/upstream-theme-sync.yml')
  const updateStep = workflow.indexOf('name: Create immutable verified release bundle')
  const snapshotIndex = workflow.indexOf('VERIFIED_TREE="$(git write-tree)"', updateStep)
  const finalContractIndex = workflow.indexOf('node scripts/verify-release-pipeline.mjs --root .', updateStep)
  const archivedThemeCheck = workflow.indexOf('node "$GITHUB_WORKSPACE/scripts/apply-theme.mjs" --root "$GENERATED_DIR" --check')
  const workflowComparisons = [
    'cmp "$GITHUB_WORKSPACE/.github/workflows/upstream-theme-sync.yml" .github/workflows/upstream-theme-sync.yml',
    'cmp "$GITHUB_WORKSPACE/.github/workflows/infinite-canvas-upstream-sync.yml" .github/workflows/infinite-canvas-upstream-sync.yml',
    'cmp "$GITHUB_WORKSPACE/.github/workflows/backend-ci.yml" .github/workflows/backend-ci.yml',
    'cmp "$GITHUB_WORKSPACE/.github/workflows/theme-binary-release.yml" .github/workflows/theme-binary-release.yml',
  ]

  assert.doesNotMatch(workflow, /rm -rf "\$GENERATED_DIR\/\.github\/workflows"/)
  assert.doesNotMatch(workflow, /git checkout origin\/themed-release -- \.github\/workflows/)
  for (const comparison of workflowComparisons) {
    const comparisonIndex = workflow.indexOf(comparison, updateStep)
    assert.ok(comparisonIndex > updateStep, `${comparison} must run in the final snapshot step`)
    assert.ok(finalContractIndex > comparisonIndex, 'the final contract check must follow workflow comparison')
  }
  assert.ok(snapshotIndex > finalContractIndex, 'snapshot creation must follow final workflow verification')
  assert.ok(archivedThemeCheck > snapshotIndex, 'the archived commit must pass the trusted theme checker before publication')
})


test('production Vue files are mounted as hash-gated theme components instead of whole-file overlays', async () => {
  const manifest = JSON.parse(await read('theme/apophis/manifest.json'))
  const productionVueFiles = (manifest.files || []).filter(
    (entry) => entry.target.startsWith('frontend/src/') && entry.target.endsWith('.vue'),
  )
  assert.deepEqual(productionVueFiles, [])

  const migrations = new Map(
    (manifest.patches || [])
      .filter((entry) => entry.operation === 'mount-component' || entry.operation === 'mount-default-component')
      .map((entry) => [entry.target, entry]),
  )
  for (const target of [
    'frontend/src/views/HomeView.vue',
    'frontend/src/components/common/AnnouncementBell.vue',
    'frontend/src/components/common/AnnouncementPopup.vue',
  ]) {
    const migration = migrations.get(target)
    assert.ok(migration, `${target} must mount a theme component`)
    assert.match(migration.expectedUpstreamSha256 || '', /^[0-9a-f]{64}$/)
  }
})

test('theme additions use unique component and test paths while replacements carry upstream baselines', async () => {
  const manifest = JSON.parse(await read('theme/apophis/manifest.json'))
  const additionTargets = new Set((manifest.additions || []).map((entry) => entry.target))
  for (const target of [
    'frontend/src/components/apophis/ApophisHomeView.vue',
    'frontend/src/components/apophis/ApophisAnnouncementBell.vue',
    'frontend/src/components/apophis/ApophisAnnouncementPopup.vue',
    'frontend/src/views/__tests__/HomeView.apophis.spec.ts',
    'frontend/src/views/__tests__/HomeView.apophis.compact.spec.ts',
    'frontend/src/components/common/__tests__/AnnouncementBell.apophis.spec.ts',
    'frontend/src/components/common/__tests__/AnnouncementPopup.apophis.spec.ts',
  ]) {
    assert.ok(additionTargets.has(target), `${target} must be an additive theme file`)
  }

  for (const entry of manifest.files || []) {
    assert.match(entry.expectedUpstreamSha256 || '', /^[0-9a-f]{64}$/, `${entry.target} requires an immutable upstream baseline`)
  }
})
