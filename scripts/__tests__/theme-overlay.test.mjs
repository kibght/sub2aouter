import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { applyTheme, checkTheme } from '../lib/theme-overlay.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-overlay-'))
  await mkdir(path.join(root, 'frontend/src/views'), { recursive: true })
  await mkdir(path.join(root, 'frontend/src/styles'), { recursive: true })
  await mkdir(path.join(overlay, 'files/frontend/src/views'), { recursive: true })
  await mkdir(path.join(overlay, 'patches'), { recursive: true })
  await writeFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'upstream-home\n')
  await writeFile(path.join(root, 'frontend/src/style.css'), '@tailwind base;\n')
  await writeFile(path.join(overlay, 'files/frontend/src/views/HomeView.vue'), 'themed-home\n')
  await writeFile(path.join(overlay, 'patches/style-import.txt'), "@import './styles/apophis-theme.css';\n\n")
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    files: [
      { source: 'files/frontend/src/views/HomeView.vue', target: 'frontend/src/views/HomeView.vue' },
    ],
    patches: [
      {
        target: 'frontend/src/style.css',
        marker: '@tailwind base;\n',
        position: 'before',
        source: 'patches/style-import.txt',
        sentinel: "@import './styles/apophis-theme.css';",
      },
    ],
  }))
  return { root, overlay }
}

test('applies file overlays and patches idempotently', async () => {
  const { root, overlay } = await fixture()

  const first = await applyTheme({ root, overlay })
  const second = await applyTheme({ root, overlay })

  assert.equal(await readFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'utf8'), 'themed-home\n')
  const stylesheet = await readFile(path.join(root, 'frontend/src/style.css'), 'utf8')
  assert.equal(stylesheet.match(/apophis-theme\.css/g)?.length, 1)
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)
})

test('check mode reports drift without mutating files', async () => {
  const { root, overlay } = await fixture()

  const result = await checkTheme({ root, overlay })

  assert.equal(result.ok, false)
  assert.deepEqual(result.drift.sort(), [
    'frontend/src/style.css',
    'frontend/src/views/HomeView.vue',
  ])
  assert.equal(await readFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'utf8'), 'upstream-home\n')
})
test('supports exact replacement patches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-replace-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-replace-overlay-'))
  await mkdir(path.join(root, 'deploy'), { recursive: true })
  await mkdir(path.join(overlay, 'patches'), { recursive: true })
  await writeFile(path.join(root, 'deploy/docker-compose.yml'), 'services:\n  app:\n    image: old/image:latest\n')
  await writeFile(path.join(overlay, 'patches/image.txt'), '    image: new/image:latest')
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    patches: [
      {
        target: 'deploy/docker-compose.yml',
        operation: 'replace',
        marker: '    image: old/image:latest',
        source: 'patches/image.txt',
        sentinel: '    image: new/image:latest',
      },
    ],
  }))

  const first = await applyTheme({ root, overlay })
  const second = await applyTheme({ root, overlay })

  assert.equal(await readFile(path.join(root, 'deploy/docker-compose.yml'), 'utf8'), 'services:\n  app:\n    image: new/image:latest\n')
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)
})

test('repository pointer patches preserve the official update flow', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-update-pointer-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-update-pointer-overlay-'))
  await mkdir(path.join(root, 'frontend/src/components/common'), { recursive: true })
  await mkdir(path.join(root, 'backend/internal/service'), { recursive: true })
  await mkdir(path.join(overlay, 'patches'), { recursive: true })

  const officialBadge = [
    "const GITHUB_REPO = 'Wei-Shaw/sub2api'",
    '// Docker Hub image published by CI (tags carry no "v" prefix, e.g. weishaw/sub2api:0.1.146)',
    "const DOCKER_IMAGE = 'weishaw/sub2api'",
    "const rollbackError = ref('')",
    '',
    'const { copied, copyToClipboard } = useClipboard()',
    "const isReleaseBuild = computed(() => buildType.value === 'release')",
    "onMounted(() => {",
    '  if (isAdmin.value) {',
    '    // Use cached version if available, otherwise fetch',
    '    appStore.fetchVersion(false)',
    "  }",
    "  document.addEventListener('click', handleClickOutside)",
    '})',
    '',
    'onBeforeUnmount(() => {',
    "  document.removeEventListener('click', handleClickOutside)",
    '})',
    '',
  ].join('\n')
  await writeFile(path.join(root, 'frontend/src/components/common/VersionBadge.vue'), officialBadge)
  await writeFile(
    path.join(root, 'backend/internal/service/update_service.go'),
    'githubRepo     = "Wei-Shaw/sub2api"\n',
  )

  const manifest = JSON.parse(await readFile('theme/apophis/manifest.json', 'utf8'))
  const pointerPatches = manifest.patches.filter(
    (entry) => entry.source === 'patches/update-repository.txt' ||
      entry.source === 'patches/version-badge-repository.txt' ||
      entry.source === 'patches/version-badge-remove-refresh.txt' ||
      entry.source === 'patches/version-badge-official-state.txt' ||
      entry.source === 'patches/version-badge-official-lifecycle.txt',
  )
  assert.equal(pointerPatches.length, 5)
  for (const patch of pointerPatches) {
    await writeFile(
      path.join(overlay, patch.source),
      await readFile(path.join('theme/apophis', patch.source), 'utf8'),
    )
  }
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({ patches: pointerPatches }))

  await applyTheme({ root, overlay })
  const badge = await readFile(path.join(root, 'frontend/src/components/common/VersionBadge.vue'), 'utf8')
  const service = await readFile(path.join(root, 'backend/internal/service/update_service.go'), 'utf8')
  assert.match(badge, /const GITHUB_REPO = 'kibght\/sub2aouter'/)
  assert.match(badge, /const DOCKER_IMAGE = 'ghcr\.io\/kibght\/sub2aouter'/)
  assert.match(badge, /const isReleaseBuild = computed\(\(\) => buildType\.value === 'release'\)/)
  assert.match(service, /githubRepo     = "kibght\/sub2aouter"/)

  const staleRoot = await mkdtemp(path.join(os.tmpdir(), 'sub2api-stale-update-root-'))
  await mkdir(path.join(staleRoot, 'frontend/src/components/common'), { recursive: true })
  await mkdir(path.join(staleRoot, 'backend/internal/service'), { recursive: true })
  const refreshMigration = pointerPatches.find(
    (entry) => entry.source === 'patches/version-badge-remove-refresh.txt',
  )
  const stateMigration = pointerPatches.find(
    (entry) => entry.source === 'patches/version-badge-official-state.txt',
  )
  const lifecycleMigration = pointerPatches.find(
    (entry) => entry.source === 'patches/version-badge-official-lifecycle.txt',
  )
  const staleBadge = [
    "const GITHUB_REPO = 'kibght/sub2aouter'",
    "const DOCKER_IMAGE = 'ghcr.io/kibght/sub2aouter'",
    refreshMigration.marker,
    'const { copied, copyToClipboard } = useClipboard()',
    stateMigration.marker,
    lifecycleMigration.marker,
    '',
  ].join('\n')
  await writeFile(path.join(staleRoot, 'frontend/src/components/common/VersionBadge.vue'), staleBadge)
  await writeFile(
    path.join(staleRoot, 'backend/internal/service/update_service.go'),
    'githubRepo     = "kibght/sub2aouter"\n',
  )
  await applyTheme({ root: staleRoot, overlay })
  const migratedBadge = await readFile(
    path.join(staleRoot, 'frontend/src/components/common/VersionBadge.vue'),
    'utf8',
  )
  assert.doesNotMatch(migratedBadge, /VERSION_REFRESH_INTERVAL_MS/)
  assert.doesNotMatch(migratedBadge, /release' \|\| buildType\.value === 'docker'/)
  assert.match(migratedBadge, /const isReleaseBuild = computed\(\(\) => buildType\.value === 'release'\)/)
  assert.match(migratedBadge, /appStore\.fetchVersion\(false\)/)
})


test('check mode rejects partial replacement drift when the sentinel remains', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-partial-drift-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-partial-drift-overlay-'))
  await mkdir(path.join(root, 'frontend'), { recursive: true })
  await mkdir(path.join(overlay, 'patches'), { recursive: true })
  await writeFile(path.join(root, 'frontend/theme.js'), 'const theme = {\n  primary: "teal",\n  accent: "blue",\n}\n')
  await writeFile(path.join(overlay, 'patches/theme.txt'), 'const theme = {\n  primary: "neutral",\n  accent: "gray",\n}')
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    patches: [
      {
        target: 'frontend/theme.js',
        operation: 'replace',
        marker: 'const theme = {\n  primary: "teal",\n  accent: "blue",\n}',
        source: 'patches/theme.txt',
        sentinel: 'primary: "neutral"',
      },
    ],
  }))

  await applyTheme({ root, overlay })
  await writeFile(path.join(root, 'frontend/theme.js'), 'const theme = {\n  primary: "neutral",\n  accent: "broken",\n}\n')

  await assert.rejects(
    checkTheme({ root, overlay }),
    /Theme patch drift.*frontend\/theme\.js/,
  )
})

test('applies AppLayout migration patches to a fresh upstream layout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-app-layout-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-app-layout-overlay-'))
  const target = 'frontend/src/components/layout/AppLayout.vue'
  await mkdir(path.join(root, 'frontend/src/components/layout'), { recursive: true })
  await mkdir(path.join(overlay, 'patches'), { recursive: true })
  await writeFile(path.join(root, target), [
    '<template>',
    '  <div class="min-h-screen bg-gray-50 dark:bg-dark-950">',
    '    <div',
    '      class="relative min-h-screen transition-all duration-300"',
    "      :class=\"[sidebarCollapsed ? 'lg:ml-[72px]' : 'lg:ml-64']\"",
    '    >',
    '      <main class="p-4 md:p-6 lg:p-8">',
    '        <slot />',
    '      </main>',
    '    </div>',
    '  </div>',
    '</template>',
    '',
    '<script setup lang="ts">',
    'const appStore = useAppStore()',
    'const authStore = useAuthStore()',
    'const sidebarCollapsed = computed(() => appStore.sidebarCollapsed)',
    '</script>',
    '',
  ].join('\n'))

  const manifest = JSON.parse(await readFile('theme/apophis/manifest.json', 'utf8'))
  const layoutPatches = manifest.patches.filter((entry) => entry.target === target)
  assert.equal(layoutPatches.length, 7)
  for (const patch of layoutPatches) {
    await writeFile(
      path.join(overlay, patch.source),
      await readFile(path.join('theme/apophis', patch.source), 'utf8'),
    )
  }
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({ patches: layoutPatches }))

  const first = await applyTheme({ root, overlay })
  const second = await applyTheme({ root, overlay })
  const layout = await readFile(path.join(root, target), 'utf8')

  assert.match(layout, /^  <div class="app-shell .*app-shell--full-height/m)
  assert.match(layout, /class="app-main relative min-h-screen transition-all duration-300"/)
  assert.match(layout, /fullHeight \? 'app-main--full-height'/)
  assert.match(layout, /class="app-content .*app-content--full-height/)
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)
})
