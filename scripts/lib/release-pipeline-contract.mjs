import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const RELEASE_PIPELINE_FILES = Object.freeze([
  '.github/workflows/upstream-theme-sync.yml',
  '.github/workflows/infinite-canvas-upstream-sync.yml',
  '.github/workflows/theme-binary-release.yml',
  '.github/workflows/backend-ci.yml',
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
  check('sync.coordinated_round', syncPath, !sync.includes('  schedule:') && sync.includes('scheduled_round:') && sync.includes('SCHEDULED_ROUND'), 'Theme sync must be dispatched by the single hourly coordinator.')
  check('sync.upstream', syncPath, sync.includes('https://github.com/Wei-Shaw/sub2api.git'), 'Sync must fetch the canonical upstream repository.')
  const upstreamReleaseQueries = sync.match(/repos\/Wei-Shaw\/sub2api\/releases\/latest/g) || []
  check('sync.upstream_release_metadata', syncPath, upstreamReleaseQueries.length === 1 && sync.includes('UPSTREAM_RELEASE_TAG') && sync.includes('UPSTREAM_RELEASE_ID'), 'Scheduled Sub2API syncs must read one immutable latest-release descriptor before fetching source.')
  check('sync.release_fail_closed', syncPath, sync.includes('UPSTREAM_RELEASE_ERROR_FILE') && sync.includes("grep -Eiq '404|not found'") && !/releases\/latest[^\n]*\|\| true/.test(sync), 'Sub2API release discovery must fall back only on an explicit not-found response and fail on other API errors.')
  check('sync.upstream_release_ref', syncPath, sync.includes('refs/apophis/upstream-release') && !sync.includes(':refs/tags/${UPSTREAM_RELEASE_TAG}'), 'Upstream release tags must use a private ref and never collide with themed release tags.')
  check('sync.upstream_monotonic', syncPath, sync.includes('merge-base --is-ancestor "$PREVIOUS_UPSTREAM_SHA" "$UPSTREAM_SHA"'), 'Scheduled Sub2API synchronization must reject downgrades and unrelated release history.')
  check('sync.upstream_release_identity', syncPath, sync.includes('UPSTREAM_RELEASE_ID') && sync.includes('PREVIOUS_UPSTREAM_RELEASE_ID') && sync.includes('PREVIOUS_UPSTREAM_RELEASE_TAG') && sync.includes('.apophis-upstream-release-id') && sync.includes('UPSTREAM_IDENTITY_AND_SHA_MATCH') && sync.includes('"$PREVIOUS_UPSTREAM_SHA" == "$UPSTREAM_SHA"'), 'Scheduled Sub2API syncs must deduplicate only when Release identity and source SHA match.')
  check('sync.skip_unchanged', syncPath, sync.includes('SCHEDULED_ROUND') && hasPattern(sync, /PREVIOUS_UPSTREAM_SHA[^\n]+UPSTREAM_SHA/), 'Coordinated hourly runs must skip unchanged upstream revisions.')
  check('sync.theme_overlay', syncPath, sync.includes('node scripts/apply-theme.mjs --root .'), 'Sync must apply the Apophis overlay to fetched upstream source.')
  check('sync.metadata', syncPath, sync.includes('.apophis-upstream-sha') && sync.includes('.apophis-repository-sha') && sync.includes('.apophis-canvas-sha') && sync.includes('.apophis-release-notes.md'), 'Sync must persist upstream, repository, Canvas, and release notes metadata.')
  check('sync.repository_recovery', syncPath, sync.includes('repository_release:') && sync.includes('CURRENT_REPOSITORY_SHA') && sync.includes('PREVIOUS_CANVAS_SHA') && sync.includes('UPSTREAM_ALREADY_SYNCHRONIZED'), 'Scheduled and dispatched syncs must recover repository or Canvas drift even when upstream is unchanged.')
  check('sync.canvas_freshness', syncPath, sync.includes('name: Verify Infinite Canvas dependency is current') && sync.includes('LATEST_CANVAS_SHA') && sync.includes('infinite-canvas/releases/latest'), 'Theme publication must stop when main is behind the latest published Infinite Canvas release.')
  check('sync.release_notes_encoding', syncPath, sync.includes('cat "$GENERATED_DIR/.apophis-upstream-release-notes.md"') && !/\?{4,}/.test(sync), 'Release notes must preserve readable text instead of emitting literal question-mark placeholders.')
  check('sync.repository_source', syncPath, sync.includes('git worktree add --detach "$GENERATED_DIR" origin/themed-release') && sync.includes('RELEASE_KIND="repository"') && hasPattern(sync, /github\.event_name[^\n]+push/), 'Push releases must reuse themed-release without fetching upstream.')
  check('sync.repository_notes', syncPath, sync.includes('## \u4ed3\u5e93\u4fee\u590d') && sync.includes('Capture repository release notes'), 'Push releases must publish repository fix notes.')
  check('sync.release_version', syncPath, sync.includes('PREVIOUS_RELEASE_VERSION') && sync.includes('node scripts/next-release-version.mjs \"$PREVIOUS_RELEASE_VERSION\"'), 'Sync must migrate the next release to v0.1.200 and increment the persisted version.')
  check('sync.publish_order', syncPath, hasOrderedMarkers(sync, [
    'name: Push immutable themed image',
    'name: Update generated release branch',
    'name: Publish latest image after release branch succeeds',
  ]), 'Immutable image, release branch, and latest image must publish in safe order.')
  check('sync.latest_image', syncPath, sync.includes('docker push "${IMAGE}:latest"'), 'Sync must publish the Docker latest tag.')
  check('sync.binary_recovery', syncPath, sync.includes('NEEDS_BINARY_RELEASE') && sync.includes('gh release view "$PREVIOUS_RELEASE_TAG"') && sync.includes('targetCommitish') && sync.includes("env.SHOULD_PUBLISH == 'true' || env.NEEDS_BINARY_RELEASE == 'true'"), 'Sync must recover a missing, incomplete, draft, prerelease, or mis-targeted binary release without minting another version.')
  check('sync.binary_dispatch_repository', syncPath, hasPattern(sync, /gh workflow run theme-binary-release\.yml[^\n]*\n\s+--repo "\$GITHUB_REPOSITORY"/), 'Binary workflow dispatch must explicitly target the current repository instead of allowing gh to infer the upstream remote.')

  const ciPath = '.github/workflows/backend-ci.yml'
  const ci = files.get(ciPath) || ''
  const reusableCheckoutRefs = ci.match(/ref: \$\{\{ inputs\.ref \|\| github\.sha \}\}/g) || []
  check('ci.reusable_ref', ciPath, hasPattern(ci, /\n  workflow_call:\n/) && ci.includes('description: Commit, branch, or tag to verify') && ci.includes('type: string') && reusableCheckoutRefs.length === 5, 'CI must be reusable and every checkout must verify the requested immutable ref.')

  const canvasSyncPath = '.github/workflows/infinite-canvas-upstream-sync.yml'
  const canvasSync = files.get(canvasSyncPath) || ''
  check('canvas_sync.schedule', canvasSyncPath, hasPattern(canvasSync, /cron:\s*'7 \* \* \* \*'/), 'The unified upstream coordinator must run hourly off the load boundary.')
  check('canvas_sync.release_metadata', canvasSyncPath, canvasSync.includes('repos/${CANVAS_REPOSITORY}/releases/latest') && canvasSync.includes('INFINITE_CANVAS_RELEASE_TAG'), 'Infinite Canvas sync must inspect published release metadata before syncing.')
  check('canvas_sync.release_fail_closed', canvasSyncPath, canvasSync.includes('INFINITE_CANVAS_RELEASE_ERROR_FILE') && canvasSync.includes("grep -Eiq '404|not found'") && !/releases\/latest[^\n]*\|\| true/.test(canvasSync) && canvasSync.includes('RELEASE_TAG: ${{ steps.canvas_release.outputs.tag }}') && !canvasSync.includes('RELEASE_TAG="${{ steps.canvas_release.outputs.tag }}"') && canvasSync.includes('merge-base --is-ancestor "$CURRENT_SHA" "$LATEST_SHA"'), 'Infinite Canvas discovery must fail closed, pass external tags through env, and reject downgrades.')
  check('canvas_sync.adapter_gate', canvasSyncPath, canvasSync.includes('apply-infinite-canvas-patches.mjs') && canvasSync.includes('bun run typecheck') && canvasSync.includes('bun run build'), 'Infinite Canvas sync must gate the submodule update on adapter checks and a production build.')
  check('canvas_sync.full_ci_gate', canvasSyncPath,
    canvasSync.includes('uses: ./.github/workflows/backend-ci.yml') &&
    canvasSync.includes('ref: ${{ needs.update.outputs.update_sha }}') &&
    canvasSync.includes('needs: [update, full-ci]') &&
    hasOrderedMarkers(canvasSync, ['uses: ./.github/workflows/backend-ci.yml', 'gh pr merge']) &&
    canvasSync.includes("needs.full-ci.result == 'success'") &&
    canvasSync.includes("needs.merge.result == 'success'"),
    'Canvas updates must run the complete CI workflow at the pushed update SHA before merge and release dispatch.')
  check('canvas_sync.merge_identity', canvasSyncPath, canvasSync.includes('UPDATE_SHA: ${{ needs.update.outputs.update_sha }}') && canvasSync.includes('--json headRefOid') && canvasSync.includes('[[ "$PR_HEAD_SHA" == "$UPDATE_SHA" ]]') && canvasSync.includes('--match-head-commit "$UPDATE_SHA"'), 'Canvas merge must bind the pull request head to the exact SHA that passed full CI.')
  check('canvas_sync.repository_selection', canvasSyncPath,
    hasPattern(canvasSync, /gh pr list --repo "\$GITHUB_REPOSITORY"/) &&
    hasPattern(canvasSync, /gh pr create[^\n]*\n\s+--repo "\$GITHUB_REPOSITORY"/) &&
    hasPattern(canvasSync, /gh pr merge[^\n]*--repo "\$GITHUB_REPOSITORY"/) &&
    hasPattern(canvasSync, /gh pr view[^\n]*--repo "\$GITHUB_REPOSITORY"/) &&
    hasPattern(canvasSync, /gh workflow run upstream-theme-sync\.yml[^\n]*\n\s+--repo "\$GITHUB_REPOSITORY"/),
    'Canvas automation must explicitly target the current repository for PR and workflow commands.')
  check('canvas_sync.release_dispatch', canvasSyncPath, canvasSync.includes('actions: write') && canvasSync.includes('gh workflow run upstream-theme-sync.yml') && canvasSync.includes('repository_release=false') && canvasSync.includes('scheduled_round=true') && canvasSync.includes('needs.update.outputs.changed') && canvasSync.includes('always()'), 'The coordinator must dispatch one combined Canvas and Sub2API release round after every successful check.')
  check('sync.canvas_push_guard', syncPath, sync.includes("github.event_name != 'push'") && sync.includes("head_commit.message, 'Infinite Canvas'"), 'Automated Canvas merge pushes must not create a second repository-only release.')

  const binaryPath = '.github/workflows/theme-binary-release.yml'
  const binary = files.get(binaryPath) || ''
  check('binary.workflow_run', binaryPath, hasPattern(binary, /workflow_run:[\s\S]*workflows:[\s\S]*Sync Upstream With Apophis Theme[\s\S]*types:[\s\S]*completed/), 'Binary release must trigger after the sync workflow completes.')
  check('binary.success_guard', binaryPath, binary.includes("github.event.workflow_run.conclusion == 'success'"), 'Binary release must require a successful sync conclusion.')
  check('binary.source_guard', binaryPath, binary.includes('name: Verify themed release matches main repository and canvas') && binary.includes('RELEASE_REPOSITORY_SHA') && binary.includes('MAIN_REPOSITORY_SHA') && binary.includes('MAIN_CANVAS_SHA') && binary.includes('RELEASE_CANVAS_SHA'), 'Binary release must reject a themed snapshot that does not match main repository and Canvas revisions.')
  check('binary.canvas_freshness', binaryPath, binary.includes('LATEST_CANVAS_SHA') && binary.includes('infinite-canvas/releases/latest'), 'Binary publication must stop when the themed Canvas is behind the latest published upstream release.')
  check('binary.checkout', binaryPath, hasPattern(binary, /ref:\s*themed-release/), 'Binary release must build the generated themed-release branch.')
  check('binary.version', binaryPath, binary.includes('cat backend/cmd/server/VERSION'), 'Binary release must reuse the generated version.')
  check('binary.publish', binaryPath, binary.includes('gh release create') && binary.includes('--target themed-release') && binary.includes('--latest'), 'Binary release must publish the themed branch as the latest GitHub Release.')
  check('binary.notes', binaryPath, binary.includes('.apophis-release-title') && binary.includes('.apophis-release-notes.md') && binary.includes('--notes-file'), 'Binary release must include the generated repository or upstream notes file.')
  check('binary.artifacts', binaryPath, binary.includes('name: Verify GoReleaser artifacts') && binary.includes('linux_amd64.tar.gz') && binary.includes('linux_arm64.tar.gz') && binary.includes('windows_amd64.zip') && binary.includes('darwin_amd64.tar.gz') && binary.includes('darwin_arm64.tar.gz') && binary.includes('dist/checksums.txt'), 'Binary release must verify Linux, Windows, macOS, and checksum artifacts before publishing.')
  check('binary.release_recovery', binaryPath, binary.includes('RELEASE_EXISTS') && binary.includes('gh release upload "$RELEASE_TAG"') && binary.includes('--clobber') && binary.includes('gh release edit "$RELEASE_TAG"') && binary.includes('name: Verify published GitHub release') && binary.includes('Missing published release asset'), 'Binary publication must repair incomplete releases and verify the final GitHub Release state.')

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
