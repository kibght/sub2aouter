#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function withDetectedLineEndings(content, value) {
  return content.includes('\r\n') ? value.replaceAll('\n', '\r\n') : value
}

async function replaceOnce(file, marker, replacement, sentinel, check, position = 'replace') {
  let content
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Plugin compatibility integration file missing: ${file}`)
    }
    throw error
  }

  const effectiveMarker = withDetectedLineEndings(content, marker)
  const effectiveReplacement = withDetectedLineEndings(content, replacement)
  const effectiveSentinel = withDetectedLineEndings(content, sentinel)
  if (content.includes(effectiveSentinel)) return false
  if (check) throw new Error(`Plugin compatibility integration drift in ${file}: ${sentinel}`)

  const index = content.indexOf(effectiveMarker)
  if (index < 0) {
    throw new Error(`Plugin compatibility integration marker not found in ${file}: ${marker}`)
  }

  const insertionIndex = position === 'after' ? index + effectiveMarker.length : index
  const nextContent = position === 'replace'
    ? `${content.slice(0, index)}${effectiveReplacement}${content.slice(index + effectiveMarker.length)}`
    : `${content.slice(0, insertionIndex)}${effectiveReplacement}${content.slice(insertionIndex)}`
  await writeFile(file, nextContent, 'utf8')
  return true
}

async function exists(file) {
  try {
    await readFile(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function applySub2PluginCompatibility({ root, check = false }) {
  const resolvedRoot = path.resolve(root)
  const pluginCompatibility = path.join(resolvedRoot, 'backend/internal/service/plugin_compatibility.go')
  if (!(await exists(pluginCompatibility))) return false

  await replaceOnce(
    pluginCompatibility,
    'type PluginHostInfo struct {\n\tVersion   string\n\tBuildType string\n}\n',
    'type PluginHostInfo struct {\n\tVersion              string\n\tCompatibilityVersion string\n\tBuildType            string\n}\n',
    'CompatibilityVersion string',
    check,
  )
  await replaceOnce(
    pluginCompatibility,
    'func EvaluatePluginCompatibility(manifest PluginManifest, host PluginHostInfo) PluginCompatibility {\n',
    'func pluginCompatibilityVersion(host PluginHostInfo) string {\n\tversion := strings.TrimSpace(host.CompatibilityVersion)\n\tif version != "" {\n\t\treturn version\n\t}\n\treturn host.Version\n}\n\n',
    'func pluginCompatibilityVersion(host PluginHostInfo) string',
    check,
    'before',
  )
  await replaceOnce(
    pluginCompatibility,
    '\t\tCurrentSub2API:     host.Version,\n',
    '\t\tCurrentSub2API:     pluginCompatibilityVersion(host),\n',
    'CurrentSub2API:     pluginCompatibilityVersion(host)',
    check,
  )
  await replaceOnce(
    pluginCompatibility,
    '\tif !matchesSemverRange(host.Version, manifest.Requires.Sub2API) {\n',
    '\tif !matchesSemverRange(pluginCompatibilityVersion(host), manifest.Requires.Sub2API) {\n',
    'matchesSemverRange(pluginCompatibilityVersion(host), manifest.Requires.Sub2API)',
    check,
  )
  await replaceOnce(
    pluginCompatibility,
    '\t\tresult.Message = fmt.Sprintf("当前 Sub2API %s 不满足插件要求 %s", host.Version, manifest.Requires.Sub2API)\n',
    '\t\tresult.Message = fmt.Sprintf("当前 Sub2API %s 不满足插件要求 %s", pluginCompatibilityVersion(host), manifest.Requires.Sub2API)\n',
    'result.Message = fmt.Sprintf("当前 Sub2API %s 不满足插件要求 %s", pluginCompatibilityVersion(host)',
    check,
  )
  await replaceOnce(
    pluginCompatibility,
    '\t\tif normalizeSemver(tested) == normalizeSemver(host.Version) {\n',
    '\t\tif normalizeSemver(tested) == normalizeSemver(pluginCompatibilityVersion(host)) {\n',
    'normalizeSemver(pluginCompatibilityVersion(host))',
    check,
  )

  await replaceOnce(
    path.join(resolvedRoot, 'backend/internal/handler/handler.go'),
    'type BuildInfo struct {\n',
    '\tCompatibilityVersion string\n',
    'CompatibilityVersion string',
    check,
    'after',
  )
  await replaceOnce(
    path.join(resolvedRoot, 'backend/cmd/server/main.go'),
    '//go:embed VERSION\nvar embeddedVersion string\n',
    '\n//go:embed UPSTREAM_VERSION\nvar embeddedUpstreamVersion string\n',
    '//go:embed UPSTREAM_VERSION',
    check,
    'after',
  )
  await replaceOnce(
    path.join(resolvedRoot, 'backend/cmd/server/main.go'),
    '\t\tBuildType: BuildType,\n',
    '\t\tCompatibilityVersion: strings.TrimSpace(embeddedUpstreamVersion),\n',
    'CompatibilityVersion: strings.TrimSpace(embeddedUpstreamVersion),',
    check,
    'after',
  )

  const wireMarker = '\t\tBuildType: buildInfo.BuildType,\n'
  const wireReplacement = '\t\tCompatibilityVersion: buildInfo.CompatibilityVersion,\n'
  for (const relative of ['backend/cmd/server/wire.go', 'backend/cmd/server/wire_gen.go']) {
    await replaceOnce(
      path.join(resolvedRoot, relative),
      wireMarker,
      wireReplacement,
      'CompatibilityVersion: buildInfo.CompatibilityVersion,',
      check,
      'after',
    )
  }

  return true
}

async function main() {
  const args = process.argv.slice(2)
  const rootIndex = args.indexOf('--root')
  const root = rootIndex >= 0 ? args[rootIndex + 1] : args[0]
  const check = args.includes('--check')
  if (!root) throw new Error('Usage: node scripts/apply-sub2-plugin-compatibility.mjs --root <path> [--check]')
  const applied = await applySub2PluginCompatibility({ root, check })
  console.log(`${check ? 'Verified' : 'Applied'} Sub2 plugin compatibility integration: ${path.resolve(root)}${applied ? '' : ' (plugin API not present)'}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
