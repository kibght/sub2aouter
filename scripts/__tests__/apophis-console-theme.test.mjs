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
