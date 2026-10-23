#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function withDetectedLineEndings(content, value) {
  const normalized = value.replace(/\r\n?/g, '\n')
  return content.includes('\r\n') ? normalized.replaceAll('\n', '\r\n') : normalized
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
  const dualVersionTests = [
    'func TestEvaluatePluginCompatibilityUsesForkAndUpstreamVersions(t *testing.T) {',
    '\tmanifest := testPluginManifest(nil)',
    '\tmanifest.Requires.Sub2API = ">=0.1.266 <0.1.267 || >=0.2.7 <0.3.0"',
    '\tmanifest.Requires.TestedSub2APIVersions = []string{"0.2.7"}',
    '\thost := PluginHostInfo{Version: "0.1.266", CompatibilityVersion: "0.2.8", BuildType: "release"}',
    '',
    '\tresult := EvaluatePluginCompatibility(manifest, host)',
    '\trequire.True(t, result.Compatible)',
    '\tassert.False(t, result.Tested)',
    '\tassert.Equal(t, "untested", result.Status)',
    '\tassert.Equal(t, "0.1.266 (fork), 0.2.8 (upstream)", result.CurrentSub2API)',
    '',
    '\tmanifest.Requires.TestedSub2APIVersions = []string{"0.2.8"}',
    '\tresult = EvaluatePluginCompatibility(manifest, host)',
    '\tassert.True(t, result.Tested)',
    '\tassert.Equal(t, "compatible", result.Status)',
    '}',
    '',
    'func TestMatchesSemverRangeSupportsAlternatives(t *testing.T) {',
    '\texpression := ">=0.1.266 <0.1.267 || >=0.2.7 <0.3.0"',
    '\tassert.True(t, matchesSemverRange("0.1.266", expression))',
    '\tassert.True(t, matchesSemverRange("0.2.8", expression))',
    '\tassert.False(t, matchesSemverRange("0.2.6", expression))',
    '}',
  ].join('\n')

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
    `func pluginHostVersions(host PluginHostInfo) []string {
	versions := make([]string, 0, 2)
	seen := make(map[string]struct{}, 2)
	for _, candidate := range []string{host.Version, host.CompatibilityVersion} {
		version := normalizeSemver(candidate)
		if version == "" {
			continue
		}
		if _, ok := seen[version]; ok {
			continue
		}
		seen[version] = struct{}{}
		versions = append(versions, strings.TrimPrefix(version, "v"))
	}
	return versions
}

func pluginHostVersionDisplay(host PluginHostInfo) string {
	versions := pluginHostVersions(host)
	if len(versions) == 0 {
		return strings.TrimSpace(host.Version)
	}
	if len(versions) == 1 {
		return versions[0]
	}
	return fmt.Sprintf("%s (fork), %s (upstream)", versions[0], versions[1])
}

func pluginHostVersionMatches(host PluginHostInfo, expression string) bool {
	for _, version := range pluginHostVersions(host) {
		if matchesSemverRange(version, expression) {
			return true
		}
	}
	return false
}

func pluginTestedAgainstHostVersion(tested string, host PluginHostInfo) bool {
	testedVersion := normalizeSemver(tested)
	if testedVersion == "" {
		return false
	}
	for _, version := range pluginHostVersions(host) {
		if testedVersion == normalizeSemver(version) {
			return true
		}
	}
	return false
}

func EvaluatePluginCompatibility(manifest PluginManifest, host PluginHostInfo) PluginCompatibility {
`,
    'func pluginHostVersions(host PluginHostInfo) []string',
    check,
  )
  await replaceOnce(
    pluginCompatibility,
    '\t\tCurrentSub2API:     host.Version,\n',
    '\t\tCurrentSub2API:     pluginHostVersionDisplay(host),\n',
    'CurrentSub2API:     pluginHostVersionDisplay(host)',
    check,
  )
  await replaceOnce(
    pluginCompatibility,
    '\tif !matchesSemverRange(host.Version, manifest.Requires.Sub2API) {\n',
    '\tif !pluginHostVersionMatches(host, manifest.Requires.Sub2API) {\n',
    'pluginHostVersionMatches(host, manifest.Requires.Sub2API)',
    check,
  )
  await replaceOnce(
    pluginCompatibility,
    '\t\tresult.Message = fmt.Sprintf("当前 Sub2API %s 不满足插件要求 %s", host.Version, manifest.Requires.Sub2API)\n',
    '\t\tresult.Message = fmt.Sprintf("当前 Sub2API %s 不满足插件要求 %s", result.CurrentSub2API, manifest.Requires.Sub2API)\n',
    'result.Message = fmt.Sprintf("当前 Sub2API %s 不满足插件要求 %s", result.CurrentSub2API',
    check,
  )
  await replaceOnce(
    pluginCompatibility,
    '\t\tif normalizeSemver(tested) == normalizeSemver(host.Version) {\n',
    '\t\tif pluginTestedAgainstHostVersion(tested, host) {\n',
    'pluginTestedAgainstHostVersion(tested, host)',
    check,
  )
  await replaceOnce(
    pluginCompatibility,
    'func matchesSemverRange(version, expression string) bool {\n',
    `func matchesSemverRange(version, expression string) bool {
	for _, alternative := range strings.Split(expression, "||") {
		if matchesSemverRangeConjunction(version, strings.TrimSpace(alternative)) {
			return true
		}
	}
	return false
}

func matchesSemverRangeConjunction(version, expression string) bool {
`,
    'func matchesSemverRangeConjunction(version, expression string) bool',
    check,
  )
  await replaceOnce(
    path.join(resolvedRoot, 'backend/internal/service/plugin_compatibility_test.go'),
    'func TestEvaluatePluginCompatibilityRejectsProtocolMismatch(t *testing.T) {\n',
    `${dualVersionTests}\n\nfunc TestEvaluatePluginCompatibilityRejectsProtocolMismatch(t *testing.T) {\n`,
    'func TestEvaluatePluginCompatibilityUsesForkAndUpstreamVersions(t *testing.T)',
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

  const serviceBuildInfo = path.join(resolvedRoot, 'backend/internal/service/wire.go')
  if (await exists(serviceBuildInfo)) {
    await replaceOnce(
      serviceBuildInfo,
      'type BuildInfo struct {\n',
      '\tCompatibilityVersion string\n',
      'CompatibilityVersion string',
      check,
      'after',
    )
  }
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

  const wireFiles = ['backend/cmd/server/wire.go', 'backend/cmd/server/wire_gen.go']
  const wireProviders = [
    {
      marker: 'func provideServiceBuildInfo(buildInfo handler.BuildInfo) service.BuildInfo {\n\treturn service.BuildInfo{\n',
      sentinel: 'func provideServiceBuildInfo(buildInfo handler.BuildInfo) service.BuildInfo {\n\treturn service.BuildInfo{\n\t\tCompatibilityVersion: buildInfo.CompatibilityVersion,\n',
    },
    {
      marker: 'func providePluginHostInfo(buildInfo handler.BuildInfo) service.PluginHostInfo {\n\treturn service.PluginHostInfo{\n',
      sentinel: 'func providePluginHostInfo(buildInfo handler.BuildInfo) service.PluginHostInfo {\n\treturn service.PluginHostInfo{\n\t\tCompatibilityVersion: buildInfo.CompatibilityVersion,\n',
    },
  ]
  for (const relative of wireFiles) {
    for (const provider of wireProviders) {
      await replaceOnce(
        path.join(resolvedRoot, relative),
        provider.marker,
        '\t\tCompatibilityVersion: buildInfo.CompatibilityVersion,\n',
        provider.sentinel,
        check,
        'after',
      )
    }
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
