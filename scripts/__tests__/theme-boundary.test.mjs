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
