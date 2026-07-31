import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')

test('theme overlay never targets backend implementation files', async () => {
  const manifest = JSON.parse(await read('theme/apophis/manifest.json'))
  const targets = [
    ...(manifest.files || []).map((entry) => entry.target),
    ...(manifest.patches || []).map((entry) => entry.target),
  ]
  assert.deepEqual(targets.filter((target) => target === 'backend' || target.startsWith('backend/')), ['backend/internal/service/update_service.go'])
})

test('shipped theme contains no target-site brand, domain, or account credentials', async () => {
  const manifest = JSON.parse(await read('theme/apophis/manifest.json'))
  const sources = [
    ...(manifest.files || []).map((entry) => `theme/apophis/${entry.source}`),
    ...(manifest.patches || []).map((entry) => `theme/apophis/${entry.source}`),
  ]
  const content = (await Promise.all(sources.map((source) => read(source)))).join('\n')
  assert.doesNotMatch(content, /www\.apophis\.uk|ApophisCode/i)
})

test('site branding remains driven by system settings across public and authenticated shells', async () => {
  const [home, auth, sidebar] = await Promise.all([
    read('frontend/src/views/HomeView.vue'),
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
  assert.match(workflow, /workflow_run:/)
  assert.match(workflow, /gh release create/)
  assert.match(workflow, /checksums\.txt/)
  const manifest = JSON.parse(manifestText)
  assert.ok((manifest.patches || []).some((entry) => entry.target === 'backend/internal/service/update_service.go'))
  assert.ok((manifest.files || []).some((entry) => entry.target === '.github/workflows/theme-binary-release.yml'))
})

test('scheduled upstream sync runs every 30 minutes and skips unchanged revisions', async () => {
  const workflow = await read('.github/workflows/upstream-theme-sync.yml')
  assert.match(workflow, /cron:\s*'\*\/30 \* \* \* \*'/)
  assert.match(workflow, /\.apophis-upstream-sha/)
  assert.match(workflow, /github\.event_name[^\n]+schedule/)
  assert.match(workflow, /SHOULD_PUBLISH/)
})

test('Docker images and binary releases share one generated release version', async () => {
  const [syncWorkflow, binaryWorkflow] = await Promise.all([
    read('.github/workflows/upstream-theme-sync.yml'),
    read('.github/workflows/theme-binary-release.yml'),
  ])
  assert.match(syncWorkflow, /GITHUB_RUN_NUMBER/)
  assert.match(syncWorkflow, /backend\/cmd\/server\/VERSION/)
  assert.match(syncWorkflow, /\$\{IMAGE\}:\$\{RELEASE_VERSION\}/)
  assert.match(binaryWorkflow, /cat backend\/cmd\/server\/VERSION/)
  assert.match(binaryWorkflow, /gh release view/)
  assert.doesNotMatch(binaryWorkflow, /date -u/)
})

test('version badge checks the custom repository every 30 minutes', async () => {
  const [badge, manifestText] = await Promise.all([
    read('frontend/src/components/common/VersionBadge.vue'),
    read('theme/apophis/manifest.json'),
  ])
  assert.match(badge, /const GITHUB_REPO = 'kibght\/sub2aouter'/)
  assert.match(badge, /const DOCKER_IMAGE = 'ghcr\.io\/kibght\/sub2aouter'/)
  assert.match(badge, /VERSION_REFRESH_INTERVAL_MS = 30 \* 60 \* 1000/)
  assert.match(badge, /setInterval\([\s\S]*fetchVersion\(true\)/)
  assert.match(badge, /clearInterval\(versionRefreshInterval\)/)

  const manifest = JSON.parse(manifestText)
  const versionBadgePatches = (manifest.patches || []).filter(
    (entry) => entry.target === 'frontend/src/components/common/VersionBadge.vue',
  )
  assert.ok(versionBadgePatches.length >= 3, 'version reminder patches must survive upstream generation')
})


test('Docker deployments expose reminder-only updates with the themed image', async () => {
  const [dockerfile, badge, manifestText] = await Promise.all([
    read('Dockerfile'),
    read('frontend/src/components/common/VersionBadge.vue'),
    read('theme/apophis/manifest.json'),
  ])
  assert.match(dockerfile, /-X main\.BuildType=docker/)
  assert.match(badge, /const isDockerBuild = computed/)
  assert.match(badge, /docker compose pull sub2api/)
  assert.match(badge, /hasUpdate && isDockerBuild/)
  assert.match(badge, /v-if="!isDockerBuild"/)

  const manifest = JSON.parse(manifestText)
  assert.ok((manifest.patches || []).some(
    (entry) => entry.target === 'Dockerfile' && entry.sentinel === '-X main.BuildType=docker',
  ))
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

test('themed binary releases publish inherited upstream notes from a notes file', async () => {
  const [workflow, overlayWorkflow] = await Promise.all([
    read('.github/workflows/theme-binary-release.yml'),
    read('theme/apophis/files/.github/workflows/theme-binary-release.yml'),
  ])
  assert.match(workflow, /\.apophis-upstream-release-tag/)
  assert.match(workflow, /\.apophis-upstream-release-notes\.md/)
  assert.match(workflow, /--notes-file/)
  assert.match(workflow, /UPSTREAM_RELEASE_TAG/)
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