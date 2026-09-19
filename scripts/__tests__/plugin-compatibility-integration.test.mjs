import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { applySub2PluginCompatibility } from '../apply-sub2-plugin-compatibility.mjs'

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-plugin-compatibility-'))
  const files = {
    'backend/internal/service/plugin_compatibility.go': `package service

import (
\t"fmt"
\t"strings"
)

type PluginHostInfo struct {
\tVersion   string
\tBuildType string
}

func EvaluatePluginCompatibility(manifest PluginManifest, host PluginHostInfo) PluginCompatibility {
\tresult := PluginCompatibility{
\t\tCurrentSub2API:     host.Version,
\t}
\tif !matchesSemverRange(host.Version, manifest.Requires.Sub2API) {
\t\tresult.Message = fmt.Sprintf("当前 Sub2API %s 不满足插件要求 %s", host.Version, manifest.Requires.Sub2API)
\t}
\tfor _, tested := range manifest.Requires.TestedSub2APIVersions {
\t\tif normalizeSemver(tested) == normalizeSemver(host.Version) {
\t\t\tbreak
\t\t}
\t}
}
`,
    'backend/internal/handler/handler.go': `package handler

type BuildInfo struct {
\tVersion   string
\tBuildType string // "source" for manual builds, "release" for CI builds
}
`,
    'backend/cmd/server/main.go': `package main

import (
\t_ "embed"
\t"strings"
)

//go:embed VERSION
var embeddedVersion string

func buildInfo() handler.BuildInfo {
\treturn handler.BuildInfo{
\t\tVersion:   Version,
\t\tBuildType: BuildType,
\t}
}
`,
    'backend/cmd/server/wire.go': `package main

func providePluginHostInfo(buildInfo handler.BuildInfo) service.PluginHostInfo {
\treturn service.PluginHostInfo{
\t\tVersion:   buildInfo.Version,
\t\tBuildType: buildInfo.BuildType,
\t}
}
`,
    'backend/cmd/server/wire_gen.go': `package main

func providePluginHostInfo(buildInfo handler.BuildInfo) service.PluginHostInfo {
\treturn service.PluginHostInfo{
\t\tVersion:   buildInfo.Version,
\t\tBuildType: buildInfo.BuildType,
\t}
}
`,
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

test('separates the themed release version from the plugin compatibility version', async () => {
  const root = await fixture()

  assert.equal(await applySub2PluginCompatibility({ root }), true)
  await applySub2PluginCompatibility({ root })
  await applySub2PluginCompatibility({ root, check: true })

  const compatibility = await readFile(
    path.join(root, 'backend/internal/service/plugin_compatibility.go'),
    'utf8',
  )
  assert.match(compatibility, /CompatibilityVersion string/)
  assert.match(compatibility, /CurrentSub2API:\s+pluginCompatibilityVersion\(host\)/)
  assert.match(compatibility, /matchesSemverRange\(pluginCompatibilityVersion\(host\)/)
  assert.match(compatibility, /normalizeSemver\(pluginCompatibilityVersion\(host\)\)/)
  assert.match(compatibility, /fmt\.Sprintf\("当前 Sub2API %s 不满足插件要求 %s", pluginCompatibilityVersion\(host\)/)

  const main = await readFile(path.join(root, 'backend/cmd/server/main.go'), 'utf8')
  assert.match(main, /go:embed UPSTREAM_VERSION/)
  assert.match(main, /CompatibilityVersion: strings\.TrimSpace\(embeddedUpstreamVersion\)/)
})

test('skips compatibility integration for upstream versions without the plugin API', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-no-plugin-'))
  assert.equal(await applySub2PluginCompatibility({ root }), false)
})

test('release synchronization writes and verifies the upstream compatibility version', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/upstream-theme-sync.yml', import.meta.url),
    'utf8',
  )
  assert.match(workflow, /UPSTREAM_SOURCE_VERSION=.*backend\/cmd\/server\/UPSTREAM_VERSION/)
  assert.match(workflow, /COMPATIBILITY_VERSION="\$\{UPSTREAM_SOURCE_VERSION:-\$RELEASE_VERSION\}"/)
  assert.match(workflow, /backend\/cmd\/server\/UPSTREAM_VERSION/)

  const applyIndex = workflow.indexOf('name: Apply Sub2API plugin compatibility integration')
  const canvasIndex = workflow.indexOf('name: Carry Infinite Canvas integration')
  const verifyIndex = workflow.indexOf('node scripts/apply-sub2-plugin-compatibility.mjs --root . --check')
  assert.ok(applyIndex >= 0 && applyIndex < canvasIndex)
  assert.ok(verifyIndex >= 0)
})
