import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { applySub2InfiniteCanvasIntegration } from '../apply-sub2-infinite-canvas-integration.mjs'
import { checkTheme } from '../lib/theme-overlay.mjs'

const criticalThemeFiles = [
  'frontend/src/views/HomeView.vue',
  'frontend/src/styles/apophis-theme.css',
  'frontend/src/components/common/AnnouncementBell.vue',
  'frontend/src/components/common/AnnouncementPopup.vue',
]

const criticalThemePatchTargets = [
  'frontend/src/components/layout/AppLayout.vue',
  'frontend/src/components/layout/AppHeader.vue',
  'frontend/src/components/layout/AuthLayout.vue',
  'frontend/src/components/common/DataTable.vue',
  'frontend/src/components/common/VersionBadge.vue',
  'frontend/src/views/user/RedeemView.vue',
  'frontend/src/views/admin/SettingsView.vue',
  'frontend/src/views/KeyUsageView.vue',
  'frontend/src/style.css',
  'frontend/tailwind.config.js',
]

const criticalCanvasTemplates = [
  'backend/internal/web/canvas_routing.go',
  'backend/internal/web/canvas_routing_test.go',
  'frontend/src/features/infiniteCanvas/bridge.ts',
  'frontend/src/features/infiniteCanvas/__tests__/bridge.spec.ts',
  'frontend/src/views/user/InfiniteCanvasView.vue',
  'frontend/src/views/user/__tests__/InfiniteCanvasView.spec.ts',
]

test('current frontend theme, reviewed QQ homepage and Sub2 Canvas integration match their persistent sources', async () => {
  const theme = await checkTheme({ root: '.', overlay: 'theme/apophis' })
  if (theme.drift.length > 0) {
    const source = execFileSync('git', ['rev-parse', '--verify', 'origin/QQbot^{commit}'], { encoding: 'utf8', windowsHide: true }).trim()
    const sourceFile = (target) => execFileSync('git', ['show', `${source}:${target}`], { windowsHide: true })
    const manifestPath = '.qqbot-website-overlay.json'
    const manifest = JSON.parse(sourceFile(manifestPath).toString('utf8'))
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), manifest)
    const reviewedHomepageTargets = new Set([
      'frontend/src/views/HomeView.vue',
      'frontend/src/views/__tests__/HomeView.spec.ts',
      'frontend/src/views/__tests__/HomeView.compact.spec.ts',
    ])
    for (const target of theme.drift) {
      assert.ok(reviewedHomepageTargets.has(target), `unreviewed theme override: ${target}`)
      assert.ok(manifest.paths.includes(target), `QQ homepage override must be reviewed: ${target}`)
      assert.deepEqual(await readFile(target), sourceFile(target), `QQ homepage must match its persistent source: ${target}`)
    }
  } else {
    assert.deepEqual(theme, { ok: true, drift: [] })
  }
  await applySub2InfiniteCanvasIntegration({ root: '.', check: true })
})

test('persistence authorities cover all critical frontend and Canvas surfaces', async () => {
  const manifest = JSON.parse(await readFile('theme/apophis/manifest.json', 'utf8'))
  const fullTargets = new Set((manifest.files || []).map((entry) => entry.target))
  const patchTargets = new Set((manifest.patches || []).map((entry) => entry.target))

  for (const target of criticalThemeFiles) assert.ok(fullTargets.has(target), target)
  for (const target of criticalThemePatchTargets) assert.ok(patchTargets.has(target), target)

  for (const target of criticalCanvasTemplates) {
    const template = await readFile(`scripts/infinite-canvas-integration/sub2-files/${target}`, 'utf8')
    const active = await readFile(target, 'utf8')
    assert.equal(active, template, target)
  }

  const canvasPatch = await readFile('scripts/apply-infinite-canvas-patches.mjs', 'utf8')
  for (const marker of [
    'nonce="__CSP_NONCE_VALUE__"',
    'basename: routerBasename',
    'installSub2Bridge',
    'const embedded = typeof window !== "undefined" && window.parent !== window;',
    'navigate("/image")',
    'typeof working.detail === "string"',
    'node.metadata?.images',
  ]) {
    assert.ok(canvasPatch.includes(marker), marker)
  }

  const bridge = await readFile('scripts/infinite-canvas-integration/canvas-files/web/src/lib/sub2-bridge.ts', 'utf8')
  assert.match(bridge, /sub2/i)
})
