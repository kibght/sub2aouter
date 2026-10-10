package service

import (
	"fmt"
	"strings"

	pluginv1 "github.com/Wei-Shaw/sub2api/pkg/pluginapi/v1"
	"golang.org/x/mod/semver"
)

type PluginHostInfo struct {
	Version              string
	CompatibilityVersion string
	BuildType            string
}

func pluginHostVersions(host PluginHostInfo) []string {
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
	result := PluginCompatibility{
		CurrentSub2API:     pluginHostVersionDisplay(host),
		RequiredSub2API:    manifest.Requires.Sub2API,
		RecommendedSub2API: manifest.Requires.RecommendedSub2APIVersion,
		PluginProtocol:     manifest.Requires.PluginProtocol,
		TransportAPI:       manifest.Requires.TransportAPI,
		UIBridge:           manifest.Requires.UIBridge,
	}
	if manifest.Requires.PluginProtocol != pluginv1.ProtocolVersion ||
		manifest.Requires.TransportAPI != pluginv1.TransportAPIVersion ||
		manifest.Requires.UIBridge != pluginv1.UIBridgeVersion {
		result.Status = "incompatible"
		result.Message = "插件协议版本与当前 Sub2API 不兼容"
		return result
	}
	if !pluginHostVersionMatches(host, manifest.Requires.Sub2API) {
		result.Status = "incompatible"
		result.Message = fmt.Sprintf("当前 Sub2API %s 不满足插件要求 %s", result.CurrentSub2API, manifest.Requires.Sub2API)
		return result
	}
	result.Compatible = true
	for _, tested := range manifest.Requires.TestedSub2APIVersions {
		if pluginTestedAgainstHostVersion(tested, host) {
			result.Tested = true
			break
		}
	}
	if result.Tested {
		result.Status = "compatible"
		result.Message = "当前 Sub2API 版本已由插件声明测试"
	} else {
		result.Status = "untested"
		result.Message = "版本范围兼容，但插件未声明已测试当前 Sub2API 版本"
	}
	return result
}

func normalizeSemver(version string) string {
	v := strings.TrimSpace(version)
	if v == "" {
		return ""
	}
	if !strings.HasPrefix(v, "v") {
		v = "v" + v
	}
	if !semver.IsValid(v) {
		return ""
	}
	return v
}

func matchesSemverRange(version, expression string) bool {
	for _, alternative := range strings.Split(expression, "||") {
		if matchesSemverRangeConjunction(version, strings.TrimSpace(alternative)) {
			return true
		}
	}
	return false
}

func matchesSemverRangeConjunction(version, expression string) bool {
	v := normalizeSemver(version)
	if v == "" {
		return false
	}
	tokens := strings.Fields(strings.ReplaceAll(expression, ",", " "))
	if len(tokens) == 0 {
		return false
	}
	for _, token := range tokens {
		op := "="
		raw := token
		for _, candidate := range []string{">=", "<=", ">", "<", "="} {
			if strings.HasPrefix(token, candidate) {
				op = candidate
				raw = strings.TrimSpace(strings.TrimPrefix(token, candidate))
				break
			}
		}
		bound := normalizeSemver(raw)
		if bound == "" {
			return false
		}
		comparison := semver.Compare(v, bound)
		matched := map[string]bool{
			">=": comparison >= 0,
			"<=": comparison <= 0,
			">":  comparison > 0,
			"<":  comparison < 0,
			"=":  comparison == 0,
		}[op]
		if !matched {
			return false
		}
	}
	return true
}
