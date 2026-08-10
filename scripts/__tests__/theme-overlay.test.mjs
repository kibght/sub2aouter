import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

test('migrates AppLayout patches from the existing themed release', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-legacy-app-layout-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-legacy-app-layout-overlay-'))
  const target = 'frontend/src/components/layout/AppLayout.vue'
  await mkdir(path.join(root, 'frontend/src/components/layout'), { recursive: true })
  await mkdir(path.join(overlay, 'patches'), { recursive: true })
  await writeFile(path.join(root, target), [
    '<template>',
    `<div class="app-shell min-h-screen bg-gray-50 dark:bg-dark-950" :class="fullHeight ? 'app-shell--full-height' : ''">`,
    '    <div',
    '      class="app-main relative min-h-screen transition-all duration-300"',
    `      :class="[sidebarCollapsed ? 'lg:ml-[72px]' : 'lg:ml-64', fullHeight ? 'app-main--full-height' : '']"`,
    '    >',
    `      <main class="app-content p-4 md:p-6 lg:p-8" :class="fullHeight ? 'app-content--full-height' : ''">`,
    '        <slot />',
    '      </main>',
    '    </div>',
    '  </div>',
    '</template>',
    '',
    '<script setup lang="ts">',
    'const appStore = useAppStore()',
    'const authStore = useAuthStore()',
    'const layoutProps = withDefaults(defineProps<{ fullHeight?: boolean }>(), { fullHeight: false })',
    'const fullHeight = computed(() => layoutProps.fullHeight)',
    'const sidebarCollapsed = computed(() => appStore.sidebarCollapsed)',
    '</script>',
    '',
  ].join('\n'))

  const manifest = JSON.parse(await readFile('theme/apophis/manifest.json', 'utf8'))
  const layoutPatches = manifest.patches.filter((entry) => entry.target === target)
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
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)
})

test('check mode rejects drift when the primary marker remains with a sentinel', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-primary-marker-drift-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-primary-marker-drift-overlay-'))
  await mkdir(path.join(root, 'frontend'), { recursive: true })
  await mkdir(path.join(overlay, 'patches'), { recursive: true })
  await writeFile(
    path.join(root, 'frontend/theme.js'),
    'const theme = {\n  primary: "teal",\n  accent: "blue",\n}\n// primary: "neutral"\n',
  )
  await writeFile(
    path.join(overlay, 'patches/theme.txt'),
    'const theme = {\n  primary: "neutral",\n  accent: "gray",\n}',
  )
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

  await assert.rejects(
    checkTheme({ root, overlay }),
    /Theme patch drift.*frontend\/theme\.js/,
  )
})

test('additions are idempotent but refuse to overwrite an unrelated upstream file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-addition-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-addition-overlay-'))
  await mkdir(path.join(overlay, 'components'), { recursive: true })
  await writeFile(path.join(overlay, 'components/ApophisPanel.vue'), '<template>theme</template>\n')
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    additions: [
      { source: 'components/ApophisPanel.vue', target: 'frontend/src/components/apophis/ApophisPanel.vue' },
    ],
  }))

  const first = await applyTheme({ root, overlay })
  const second = await applyTheme({ root, overlay })
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)

  await writeFile(path.join(root, 'frontend/src/components/apophis/ApophisPanel.vue'), '<template>upstream</template>\n')
  await assert.rejects(
    () => applyTheme({ root, overlay }),
    /Refusing to overwrite existing addition target/,
  )
})

test('replacement overlays fail closed when the upstream baseline hash drifts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-baseline-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-baseline-overlay-'))
  await mkdir(path.join(root, 'frontend/src/views'), { recursive: true })
  await mkdir(path.join(overlay, 'files'), { recursive: true })
  const upstream = 'upstream-home\n'
  const expectedUpstreamSha256 = createHash('sha256').update(upstream).digest('hex')
  await writeFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'changed-upstream-home\n')
  await writeFile(path.join(overlay, 'files/HomeView.vue'), 'themed-home\n')
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    files: [{
      source: 'files/HomeView.vue',
      target: 'frontend/src/views/HomeView.vue',
      expectedUpstreamSha256,
    }],
  }))

  await assert.rejects(
    () => applyTheme({ root, overlay }),
    /Upstream baseline drift.*frontend\/src\/views\/HomeView\.vue.*expected.*actual/s,
  )
  assert.equal(await readFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'utf8'), 'changed-upstream-home\n')
})

test('mount-component replaces only script and template after validating the upstream hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-mount-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-mount-overlay-'))
  await mkdir(path.join(root, 'frontend/src/views'), { recursive: true })
  const upstream = `<script setup lang="ts">\nconst value = 1\n</script>\n\n<template>\n  <main>{{ value }}</main>\n</template>\n\n<style scoped>\nmain { color: red; }\n</style>\n`
  const expectedUpstreamSha256 = createHash('sha256').update(upstream).digest('hex')
  await writeFile(path.join(root, 'frontend/src/views/HomeView.vue'), upstream)
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    patches: [{
      target: 'frontend/src/views/HomeView.vue',
      operation: 'mount-component',
      componentName: 'ApophisHomeView',
      importPath: '@/components/apophis/ApophisHomeView.vue',
      expectedUpstreamSha256,
      sentinel: "import ApophisHomeView from '@/components/apophis/ApophisHomeView.vue'",
    }],
  }))

  const first = await applyTheme({ root, overlay })
  const second = await applyTheme({ root, overlay })
  const mounted = await readFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'utf8')
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)
  assert.match(mounted, /import ApophisHomeView from '@\/components\/apophis\/ApophisHomeView\.vue'/)
  assert.match(mounted, /<ApophisHomeView \/>/)
  assert.match(mounted, /main \{ color: red; \}/)
  assert.doesNotMatch(mounted, /const value = 1/)
})


test('mount-component accepts one exact legacy themed hash during migration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-legacy-mount-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-legacy-mount-overlay-'))
  await mkdir(path.join(root, 'frontend/src/views'), { recursive: true })
  const upstream = `<script setup lang="ts">\nconst upstream = true\n</script>\n<template><main>upstream</main></template>\n`
  const legacy = `<script setup lang="ts">\nconst legacy = true\n</script>\n<template><main>legacy theme</main></template>\n`
  const expectedUpstreamSha256 = createHash('sha256').update(upstream).digest('hex')
  const legacySha256 = createHash('sha256').update(legacy).digest('hex')
  await writeFile(path.join(root, 'frontend/src/views/HomeView.vue'), legacy)
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    patches: [{
      target: 'frontend/src/views/HomeView.vue',
      operation: 'mount-component',
      componentName: 'ApophisHomeView',
      importPath: '@/components/apophis/ApophisHomeView.vue',
      expectedUpstreamSha256,
      legacySha256: [legacySha256],
      sentinel: "import ApophisHomeView from '@/components/apophis/ApophisHomeView.vue'",
    }],
  }))

  await applyTheme({ root, overlay })
  const mounted = await readFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'utf8')
  assert.match(mounted, /<ApophisHomeView \/>/)
})


test('mount-default-component preserves upstream custom and compact branches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-default-mount-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-default-mount-overlay-'))
  await mkdir(path.join(root, 'frontend/src/views'), { recursive: true })
  const upstream = `<script setup lang="ts">\nimport { computed } from 'vue'\nconst custom = computed(() => false)\nconst compact = computed(() => false)\n</script>\n<template>\n  <section v-if="custom">custom</section>\n  <section v-else-if="compact" data-testid="compact-home">compact</section>\n  <main v-else class="terminal-container">default</main>\n</template>\n<style scoped>.terminal-container { color: red; }</style>\n`
  const expectedUpstreamSha256 = createHash('sha256').update(upstream).digest('hex')
  await writeFile(path.join(root, 'frontend/src/views/HomeView.vue'), upstream)
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    patches: [{
      target: 'frontend/src/views/HomeView.vue',
      operation: 'mount-default-component',
      componentName: 'ApophisHomeView',
      importPath: '@/components/apophis/ApophisHomeView.vue',
      expectedUpstreamSha256,
      sentinel: "import ApophisHomeView from '@/components/apophis/ApophisHomeView.vue'",
    }],
  }))

  await applyTheme({ root, overlay })
  const mounted = await readFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'utf8')
  assert.match(mounted, /const custom = computed/)
  assert.match(mounted, /v-if="custom"/)
  assert.match(mounted, /data-testid="compact-home"/)
  assert.match(mounted, /<ApophisHomeView v-else \/>/)
  assert.doesNotMatch(mounted, /class="terminal-container">default/)
  assert.match(mounted, /\.terminal-container \{ color: red; \}/)
})

test('mount-component can explicitly re-emit child component events', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-event-mount-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-event-mount-overlay-'))
  await mkdir(path.join(root, 'frontend/src/components'), { recursive: true })
  const upstream = `<script setup lang="ts">\nconst old = true\n</script>\n<template><div>old</div></template>\n`
  const expectedUpstreamSha256 = createHash('sha256').update(upstream).digest('hex')
  await writeFile(path.join(root, 'frontend/src/components/Popup.vue'), upstream)
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    patches: [{
      target: 'frontend/src/components/Popup.vue',
      operation: 'mount-component',
      componentName: 'ApophisPopup',
      importPath: '@/components/apophis/ApophisPopup.vue',
      forwardEvents: ['close'],
      expectedUpstreamSha256,
      sentinel: "import ApophisPopup from '@/components/apophis/ApophisPopup.vue'",
    }],
  }))

  await applyTheme({ root, overlay })
  const mounted = await readFile(path.join(root, 'frontend/src/components/Popup.vue'), 'utf8')
  assert.match(mounted, /const emit = defineEmits\(\['close'\]\)/)
  assert.match(mounted, /<ApophisPopup @close="emit\('close'\)" \/>/)
})


test('supports idempotent removal patches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-remove-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-remove-overlay-'))
  await mkdir(path.join(root, 'frontend/src/views'), { recursive: true })
  await writeFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'keep\nremove me\nkeep too\n')
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    patches: [{
      target: 'frontend/src/views/HomeView.vue',
      operation: 'remove',
      marker: 'remove me\n',
    }],
  }))

  const first = await applyTheme({ root, overlay })
  const second = await applyTheme({ root, overlay })
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)
  assert.equal(await readFile(path.join(root, 'frontend/src/views/HomeView.vue'), 'utf8'), 'keep\nkeep too\n')
})


test('mount-component rejects a partially damaged themed wrapper', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-partial-mount-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-partial-mount-overlay-'))
  await mkdir(path.join(root, 'frontend/src/components'), { recursive: true })
  const upstream = `<script setup lang="ts">\nconst old = true\n</script>\n<template><div>old</div></template>\n`
  const expectedUpstreamSha256 = createHash('sha256').update(upstream).digest('hex')
  const target = path.join(root, 'frontend/src/components/Popup.vue')
  await writeFile(target, upstream)
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    patches: [{
      target: 'frontend/src/components/Popup.vue',
      operation: 'mount-component',
      componentName: 'ApophisPopup',
      importPath: '@/components/apophis/ApophisPopup.vue',
      forwardEvents: ['close'],
      expectedUpstreamSha256,
      sentinel: "import ApophisPopup from '@/components/apophis/ApophisPopup.vue'",
    }],
  }))

  await applyTheme({ root, overlay })
  const damaged = (await readFile(target, 'utf8')).replace(` @close="emit('close')"`, '')
  await writeFile(target, damaged)

  await assert.rejects(
    () => checkTheme({ root, overlay }),
    /Upstream baseline drift.*frontend\/src\/components\/Popup\.vue/s,
  )
})

test('mount-default-component handles nested template elements in a valid SFC', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-nested-default-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-nested-default-overlay-'))
  await mkdir(path.join(root, 'frontend/src/views'), { recursive: true })
  const upstream = `<script setup lang="ts">\nconst items = [1, 2]\nconst compact = false\n</script>\n<template>\n  <section v-if="compact">compact</section>\n  <div v-else-if="items.length">\n    <template v-for="item in items" :key="item">\n      <span>{{ item }}</span>\n    </template>\n  </div>\n  <main v-else>default</main>\n</template>\n<style scoped>main { display: block; }</style>\n`
  const expectedUpstreamSha256 = createHash('sha256').update(upstream).digest('hex')
  const target = path.join(root, 'frontend/src/views/HomeView.vue')
  await writeFile(target, upstream)
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    patches: [{
      target: 'frontend/src/views/HomeView.vue',
      operation: 'mount-default-component',
      componentName: 'ApophisHomeView',
      importPath: '@/components/apophis/ApophisHomeView.vue',
      expectedUpstreamSha256,
      sentinel: "import ApophisHomeView from '@/components/apophis/ApophisHomeView.vue'",
    }],
  }))

  await applyTheme({ root, overlay })
  const mounted = await readFile(target, 'utf8')
  assert.match(mounted, /<template v-for="item in items"/)
  assert.match(mounted, /<ApophisHomeView v-else \/>/)
  assert.equal((mounted.match(/<\/template>/g) || []).length, 2)
})

test('mount-component replaces the complete outer template when nested templates exist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-nested-mount-root-'))
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'sub2api-theme-nested-mount-overlay-'))
  await mkdir(path.join(root, 'frontend/src/components'), { recursive: true })
  const upstream = `<script setup lang="ts">\nconst items = [1]\n</script>\n<template>\n  <div>\n    <template v-for="item in items" :key="item"><span>{{ item }}</span></template>\n  </div>\n</template>\n<style scoped>span { color: red; }</style>\n`
  const expectedUpstreamSha256 = createHash('sha256').update(upstream).digest('hex')
  const target = path.join(root, 'frontend/src/components/Popup.vue')
  await writeFile(target, upstream)
  await writeFile(path.join(overlay, 'manifest.json'), JSON.stringify({
    patches: [{
      target: 'frontend/src/components/Popup.vue',
      operation: 'mount-component',
      componentName: 'ApophisPopup',
      importPath: '@/components/apophis/ApophisPopup.vue',
      expectedUpstreamSha256,
      sentinel: "import ApophisPopup from '@/components/apophis/ApophisPopup.vue'",
    }],
  }))

  await applyTheme({ root, overlay })
  const mounted = await readFile(target, 'utf8')
  assert.equal((mounted.match(/<\/template>/g) || []).length, 1)
  assert.doesNotMatch(mounted, /v-for="item in items"/)
  assert.match(mounted, /span \{ color: red; \}/)
})
