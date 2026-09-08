import assert from 'node:assert/strict'
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

test('current frontend theme and Sub2 Canvas integration match their persistent sources', async () => {
  const theme = await checkTheme({ root: '.', overlay: 'theme/apophis' })
  assert.deepEqual(theme, { ok: true, drift: [] })
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