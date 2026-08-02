import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const RELEASE_PIPELINE_FILES = Object.freeze([
  '.github/workflows/upstream-theme-sync.yml',
  '.github/workflows/theme-binary-release.yml',
  'backend/internal/service/update_service.go',
  'Dockerfile',
  'frontend/src/components/common/VersionBadge.vue',
  'frontend/src/views/HomeView.vue',
  'README.md',
  'scripts/lib/release-version.mjs',
  'scripts/next-release-version.mjs',
  'theme/apophis/files/frontend/src/views/HomeView.vue',
  'theme/apophis/files/README.md',
  'theme/apophis/files/.github/workflows/theme-binary-release.yml',
  'theme/apophis/manifest.json',
])

function violation(code, path, message) {
  return { code, path, message }
}

function hasPattern(text, pattern) {
  return pattern.test(text)
}

function hasOrderedMarkers(text, markers) {
  let cursor = -1
  for (const marker of markers) {
    const index = text.indexOf(marker, cursor + 1)
    if (index < 0 || index <= cursor) {
      return false
    }
    cursor = index
  }
  return true
}

function manifestHasPatch(manifest, target, sentinel) {
  return (manifest.patches || []).some(
    (entry) => entry.target === target && entry.sentinel === sentinel,
  )
}

function manifestHasFile(manifest, target) {
  return (manifest.files || []).some((entry) => entry.target === target)
}

export async function verifyReleasePipelineContract(root = '.', options = {}) {
  const base = resolve(root)
  const readText = options.readText || ((path) => readFile(resolve(base, path), 'utf8'))
  const files = new Map()
  const violations = []

  for (const path of RELEASE_PIPELINE_FILES) {
    try {
      files.set(path, await readText(path))
    } catch (error) {
      violations.push(violation('file.missing', path, `Unable to read required file: ${error.message}`))
    }
  }

  const check = (code, path, condition, message) => {
    if (!condition) {
      violations.push(violation(code, path, message))
    }
  }

  const syncPath = '.github/workflows/upstream-theme-sync.yml'
  const sync = files.get(syncPath) || ''
  check('sync.push_main', syncPath, hasPattern(sync, /\n  push:\n    branches:\n      - main\n/), 'Sync must run for pushes to main.')
  check('sync.schedule', syncPath, hasPattern(sync, /cron:\s*'7,37 \* \* \* \*'/), 'Sync must poll upstream every 30 minutes off the hourly load boundary.')
  check('sync.upstream', syncPath, sync.includes('https://github.com/Wei-Shaw/sub2api.git'), 'Sync must fetch the canonical upstream repository.')
  check('sync.skip_unchanged', syncPath, hasPattern(sync, /github\.event_name[^\n]+schedule[^\n]+PREVIOUS_UPSTREAM_SHA[^\n]+UPSTREAM_SHA/), 'Scheduled runs must skip unchanged upstream revisions.')
  check('sync.theme_overlay', syncPath, sync.includes('node scripts/apply-theme.mjs --root .'), 'Sync must apply the Apophis overlay to fetched upstream source.')
  check('sync.metadata', syncPath, sync.includes('.apophis-upstream-sha') && sync.includes('.apophis-repository-sha') && sync.includes('.apophis-release-notes.md'), 'Sync must persist upstream, repository, and release notes metadata.')
  check('sync.release_notes_encoding', syncPath, sync.includes('cat "$GENERATED_DIR/.apophis-upstream-release-notes.md"') && !/\?{4,}/.test(sync), 'Release notes must preserve readable text instead of emitting literal question-mark placeholders.')
  check('sync.repository_source', syncPath, sync.includes('git worktree add --detach "$GENERATED_DIR" origin/themed-release') && sync.includes('RELEASE_KIND="repository"') && sync.includes('不重复获取上游'), 'Push releases must reuse themed-release without fetching upstream.')
  check('sync.repository_notes', syncPath, sync.includes('## \u4ed3\u5e93\u4fee\u590d') && sync.includes('Capture repository release notes'), 'Push releases must publish repository fix notes.')
  check('sync.release_version', syncPath, sync.includes('PREVIOUS_RELEASE_VERSION') && sync.includes('node scripts/next-release-version.mjs \"$PREVIOUS_RELEASE_VERSION\"'), 'Sync must migrate the next release to v0.1.200 and increment the persisted version.')
  check('sync.publish_order', syncPath, hasOrderedMarkers(sync, [
    'name: Push immutable themed image',
    'name: Update generated release branch',
    'name: Publish latest image after release branch succeeds',
  ]), 'Immutable image, release branch, and latest image must publish in safe order.')
  check('sync.latest_image', syncPath, sync.includes('docker push "${IMAGE}:latest"'), 'Sync must publish the Docker latest tag.')

  const binaryPath = '.github/workflows/theme-binary-release.yml'
  const binary = files.get(binaryPath) || ''
  check('binary.workflow_run', binaryPath, hasPattern(binary, /workflow_run:[\s\S]*workflows:[\s\S]*Sync Upstream With Apophis Theme[\s\S]*types:[\s\S]*completed/), 'Binary release must trigger after the sync workflow completes.')
  check('binary.success_guard', binaryPath, binary.includes("github.event.workflow_run.conclusion == 'success'"), 'Binary release must require a successful sync conclusion.')
  check('binary.checkout', binaryPath, hasPattern(binary, /ref:\s*themed-release/), 'Binary release must build the generated themed-release branch.')
  check('binary.version', binaryPath, binary.includes('cat backend/cmd/server/VERSION'), 'Binary release must reuse the generated version.')
  check('binary.publish', binaryPath, binary.includes('gh release create') && binary.includes('--target themed-release') && binary.includes('--latest'), 'Binary release must publish the themed branch as the latest GitHub Release.')
  check('binary.notes', binaryPath, binary.includes('.apophis-release-title') && binary.includes('.apophis-release-notes.md') && binary.includes('--notes-file'), 'Binary release must include the generated repository or upstream notes file.')

  const overlayBinaryPath = 'theme/apophis/files/.github/workflows/theme-binary-release.yml'
  check('binary.overlay_copy', overlayBinaryPath, files.get(overlayBinaryPath) === binary, 'The permanent theme copy of the binary workflow must match the active workflow.')

  const releaseVersionPath = 'scripts/lib/release-version.mjs'
  const releaseVersion = files.get(releaseVersionPath) || ''
  check('release_version.bootstrap', releaseVersionPath, releaseVersion.includes('FIRST_RELEASE_PATCH = 200'), 'Release version generation must bootstrap at v0.1.200.')

  const servicePath = 'backend/internal/service/update_service.go'
  const service = files.get(servicePath) || ''
  check('backend.repository', servicePath, hasPattern(service, /githubRepo\s+=\s+"kibght\/sub2aouter"/), 'Backend update checks must use themed Releases.')

  const dockerfilePath = 'Dockerfile'
  const dockerfile = files.get(dockerfilePath) || ''
  check('docker.build_type', dockerfilePath, dockerfile.includes('-X main.BuildType=release'), 'Docker builds must use the official release build type.')

  const badgePath = 'frontend/src/components/common/VersionBadge.vue'
  const badge = files.get(badgePath) || ''
  check('frontend.repository', badgePath, badge.includes("const GITHUB_REPO = 'kibght/sub2aouter'"), 'Frontend release links must use the themed repository.')
  check('frontend.image', badgePath, badge.includes("const DOCKER_IMAGE = 'ghcr.io/kibght/sub2aouter'"), 'Frontend Docker commands must use the themed image.')
  check('frontend.refresh', badgePath, badge.includes("const isReleaseBuild = computed(() => buildType.value === 'release')") && !badge.includes('VERSION_REFRESH_INTERVAL_MS') && !hasPattern(badge, /setInterval\([\s\S]*fetchVersion\(true\)/), 'Frontend update behavior must stay aligned with the official source.')
  check('frontend.docker_update', badgePath, badge.includes("const isReleaseBuild = computed(() => buildType.value === 'release')") && badge.includes('@click="handleUpdate"') && badge.includes('@click="toggleRollbackPanel"') && !badge.includes("buildType.value === 'release' || buildType.value === 'docker'") && !badge.includes('const isDockerBuild = computed') && !badge.includes('dockerUpdateCommand'), 'Docker builds must keep the official manual-update flow instead of in-place replacement.')

  const contributorPattern = /KKBK-233|<h[1-6][^>]*>\s*Contributors\s*<\/h[1-6]>|^\s*#{1,6}\s+Contributors\s*$/im
  for (const path of [
    'frontend/src/views/HomeView.vue',
    'README.md',
    'theme/apophis/files/frontend/src/views/HomeView.vue',
    'theme/apophis/files/README.md',
  ]) {
    check('template.contributors', path, !contributorPattern.test(files.get(path) || ''), 'The shipped template must not add an explicit contributor card or account.')
  }

  const manifestPath = 'theme/apophis/manifest.json'
  const manifestText = files.get(manifestPath) || ''
  try {
    const manifest = JSON.parse(manifestText)
    check('manifest.backend_repository', manifestPath, manifestHasPatch(manifest, servicePath, 'githubRepo     = "kibght/sub2aouter"'), 'Theme manifest must preserve the custom update repository.')
    check('manifest.frontend_repository', manifestPath, manifestHasPatch(manifest, badgePath, "const GITHUB_REPO = 'kibght/sub2aouter'"), 'Theme manifest must preserve frontend release discovery.')
    check('manifest.frontend_refresh', manifestPath, !manifestHasPatch(manifest, badgePath, 'const VERSION_REFRESH_INTERVAL_MS = 30 * 60 * 1000'), 'Theme manifest must not alter the official frontend refresh behavior.')
    check('manifest.frontend_direct_update', manifestPath, !manifestHasPatch(manifest, badgePath, "buildType.value === 'release' || buildType.value === 'docker'") && !manifestHasPatch(manifest, badgePath, 'dockerUpdateCommand'), 'Theme manifest must not replace the official Docker update flow.')
    const dockerBuildTypeMigration = (manifest.patches || []).find(
      (entry) => entry.target === dockerfilePath && entry.source === 'patches/dockerfile-build-type-migration.txt',
    )
    check('manifest.docker_build_type', manifestPath,
      !manifestHasPatch(manifest, dockerfilePath, '-X main.BuildType=release') &&
      !manifestHasPatch(manifest, dockerfilePath, '-X main.BuildType=docker') ||
      Boolean(dockerBuildTypeMigration &&
        dockerBuildTypeMigration.marker === '-X main.BuildType=docker' &&
        dockerBuildTypeMigration.sentinel === '-X main.BuildType=release'),
      'Theme manifest must keep the official Docker build type and may only migrate stale generated snapshots.')
    check('manifest.binary_workflow', manifestPath, manifestHasFile(manifest, binaryPath), 'Theme manifest must carry the binary release workflow into generated releases.')
  } catch (error) {
    violations.push(violation('manifest.invalid', manifestPath, `Theme manifest is invalid JSON: ${error.message}`))
  }

  return violations
}
