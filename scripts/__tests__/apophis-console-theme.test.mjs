import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

async function read(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8')
}

test('authenticated console uses the Apophis shell hooks', async () => {
  const [layout, header] = await Promise.all([
    read('frontend/src/components/layout/AppLayout.vue'),
    read('frontend/src/components/layout/AppHeader.vue'),
  ])

  assert.match(layout, /class="app-shell /)
  assert.match(layout, /class="app-main /)
  assert.match(layout, /class="app-content /)
  assert.match(header, /class="app-header /)
  assert.match(header, /class="app-header-inner /)
  assert.match(header, /app-header-balance/)
  assert.match(header, /app-header-user/)
  assert.doesNotMatch(header, /const userInitials/)
})

test('Apophis theme defines console chrome and neutral active navigation', async () => {
  const css = await read('frontend/src/styles/apophis-theme.css')
  assert.match(css, /\.app-shell \.sidebar\s*\{/)
  assert.match(css, /\.app-shell \.sidebar-link-active,/)
  assert.match(css, /\.app-header\s*\{/)
  assert.match(css, /\.app-content\s*\{/)
  assert.match(css, /--console-accent:/)
})

test('theme overlay persists authenticated console changes across upstream syncs', async () => {
  const manifest = JSON.parse(await read('theme/apophis/manifest.json'))
  const patchTargets = new Set((manifest.patches || []).map((entry) => entry.target))
  const fileTargets = new Set((manifest.files || []).map((entry) => entry.target))

  const appLayoutStatePatch = await read('theme/apophis/patches/app-layout-full-height-state.txt')
  assert.match(appLayoutStatePatch, /const appStore = useAppStore\(\)/)
  assert.match(appLayoutStatePatch, /const authStore = useAuthStore\(\)/)
  assert.match(appLayoutStatePatch, /const fullHeight = computed/)

  const appLayoutMainPatch = (manifest.patches || []).find((entry) => entry.source === 'patches/app-layout-main.txt')
  assert.ok(appLayoutMainPatch)
  assert.match(appLayoutMainPatch.marker, /:class=\"\[sidebarCollapsed/)

  assert.ok(patchTargets.has('frontend/src/components/layout/AppLayout.vue'))
  assert.ok(patchTargets.has('frontend/src/components/layout/AppHeader.vue'))
  assert.ok(fileTargets.has('frontend/src/styles/apophis-theme.css'))
})

test('public auth screens use the Apophis authentication shell', async () => {
  const [layout, css] = await Promise.all([
    read('frontend/src/components/layout/AuthLayout.vue'),
    read('frontend/src/styles/apophis-theme.css'),
  ])
  assert.match(layout, /class="auth-shell /)
  assert.match(layout, /class="auth-container /)
  assert.match(layout, /class="auth-card /)
  assert.match(css, /\.auth-shell\s*\{/)
  assert.match(css, /\.auth-shell \.btn-primary/)

  const manifest = JSON.parse(await read('theme/apophis/manifest.json'))
  assert.ok((manifest.patches || []).some((entry) => entry.target === 'frontend/src/components/layout/AuthLayout.vue'))
})


test('all routed pages inherit the neutral Apophis palette', async () => {
  const [css, tailwind] = await Promise.all([
    read('frontend/src/styles/apophis-theme.css'),
    read('frontend/tailwind.config.js'),
  ])

  assert.match(tailwind, /gray:\s*\{[\s\S]*50: '#fafafa'[\s\S]*950: '#09090b'/)
  assert.match(tailwind, /slate:\s*\{[\s\S]*50: '#fafafa'[\s\S]*950: '#09090b'/)
  assert.match(tailwind, /primary:\s*\{[\s\S]*50: 'hsl\(var\(--muted\)/)
  assert.match(tailwind, /dark:\s*\{[\s\S]*800: '#18181b'[\s\S]*950: '#09090b'/)
  assert.match(tailwind, /'gradient-primary': 'linear-gradient\(135deg, hsl\(var\(--foreground\)\)/)
  assert.doesNotMatch(tailwind, /#14b8a6|#0d9488|rgba\(20, 184, 166/)
  assert.match(css, /\.app-shell table th/)
  assert.match(css, /\.app-shell table td/)
})

test('redeem summary uses the existing neutral card language instead of a custom primary gradient', async () => {
  const [view, manifest] = await Promise.all([
    read('frontend/src/views/user/RedeemView.vue'),
    read('theme/apophis/manifest.json'),
  ])

  assert.doesNotMatch(view, /from-primary-500 to-primary-600/)
  assert.match(view, /redeem-balance-summary/)

  const parsed = JSON.parse(manifest)
  assert.ok(
    (parsed.patches || []).some(
      (entry) => entry.target === 'frontend/src/views/user/RedeemView.vue',
    ),
  )
})


test('remaining standalone and overlay UI hooks use the same neutral template tokens', async () => {
  const [css, settings, keyUsage, dataTable, manifestText] = await Promise.all([
    read('frontend/src/styles/apophis-theme.css'),
    read('frontend/src/views/admin/SettingsView.vue'),
    read('frontend/src/views/KeyUsageView.vue'),
    read('frontend/src/components/common/DataTable.vue'),
    read('theme/apophis/manifest.json'),
  ])

  assert.match(css, /html \.driver-popover\.theme-tour-popover/)
  assert.match(css, /html \.theme-tour-popover \.driver-popover-next-btn/)
  assert.doesNotMatch(settings, /linear-gradient\(90deg, #14b8a6, #0ea5e9\)/)
  assert.doesNotMatch(keyUsage, /border-color: #14b8a6/)
  assert.doesNotMatch(settings, /background: rgb\(15 23 42 \/ 0\.86\)/)
  assert.doesNotMatch(dataTable, /background-color: rgb\(17 24 39\)/)
  assert.match(dataTable, /background-color: hsl\(var\(--card\)\)/)

  const manifest = JSON.parse(manifestText)
  for (const target of [
    'frontend/src/views/admin/SettingsView.vue',
    'frontend/src/views/KeyUsageView.vue',
    'frontend/src/components/common/DataTable.vue',
  ]) {
    assert.ok((manifest.patches || []).some((entry) => entry.target === target))
  }
})


test('dark mode switches keep the thumb distinct from the active track', async () => {
  const css = await read('frontend/src/styles/apophis-theme.css')
  assert.match(
    css,
    /\.dark \.app-shell button\[class\*="bg-primary-"\] > span\[class\*="rounded-full"\]\[class\*="bg-white"\]/,
  )
  assert.match(css, /background: var\(--console-background\) !important;/)
})
