function entries(markdown = "") {
  return markdown.replace(/\r\n/g, "\n").split(/\n(?=[+*-] )/)
    .map((block) => block.match(/^[+*-] .*(?:\n[ \t]+.+)*/m)?.[0]?.trim())
    .filter(Boolean)
}

export function changelogChanges(previous, current) {
  const before = new Set(entries(previous))
  return entries(current).filter((entry) => !before.has(entry)).join("\n")
}

export function concreteSubjects(subjects = []) {
  return subjects.filter((subject) => subject.trim() &&
    !/^(?:Merge |chore(?:\([^)]*\))?: (?:update .* upstream|sync|bump|release)|[0-9a-f]{7,40}$)/i.test(subject)
  ).map((subject) => `- ${subject}`).join("\n")
}

export function upstreamChanges(markdown) {
  return markdown.replace(/\r\n/g, "\n")
    .split(/^##[^\n]*(?:Installation|Documentation|New Contributors|Contributors|安装|文档)/mi)[0]
    .replace(/^>.*\n?/gm, "")
    .replace(/^\*\*Full Changelog\*\*:.*$/gm, "")
    .replace(/(?:\n---\s*)+$/, "").trim()
}

export function previousReleaseTag(releases, version) {
  const parse = (value) => /^v?\d+\.\d+\.\d+$/.test(value || '') ? value.replace(/^v/, '').split('.').map(Number) : null
  const compare = (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
  const target = parse(version)
  if (!target) throw new Error('Invalid release version.')
  return releases.flat().filter((release) => !release.draft && !release.prerelease && parse(release.tag_name) && compare(parse(release.tag_name), target) < 0)
    .sort((a, b) => compare(parse(b.tag_name), parse(a.tag_name)))[0]?.tag_name || ''
}

export function composeReleaseNotes({ upstream = "", canvas = "", repository = "", canvasTag = "" }) {
  const sections = []
  if (upstream.trim()) sections.push(upstreamChanges(upstream))
  if (canvas.trim()) sections.push(`### Infinite Canvas ${canvasTag}\n\n${canvas.trim()}`)
  if (repository.trim()) sections.push(repository.trim())
  const body = sections.join("\n\n").trim()
  if (!/^[+*-] \S/m.test(body)) throw new Error("Concrete release changes are required; refusing a hash-only or empty release.")
  if (body.includes("\uFFFD") || /\?{4,}/.test(body)) throw new Error("Invalid release notes encoding.")
  return `## 本次修复内容\n\n${body}\n`
}
