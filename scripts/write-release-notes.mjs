#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { changelogChanges, concreteSubjects, composeReleaseNotes, previousReleaseTag } from "./lib/release-notes.mjs"

const env = process.env
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const generated = env.GENERATED_DIR
if (!generated || !/^\d+\.\d+\.\d+$/.test(env.RELEASE_VERSION || "")) throw new Error("Missing release output directory or version.")
const releases = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', 'repos/' + env.GITHUB_REPOSITORY + '/releases?per_page=100'], { encoding: 'utf8' }))
const baseTag = previousReleaseTag(releases, env.RELEASE_VERSION)
if (!baseTag) throw new Error('No earlier published release found for concrete change comparison.')
const baseRef = 'refs/apophis/release-notes-base'
git('.', 'fetch', '--force', 'origin', 'refs/tags/' + baseTag + ':' + baseRef)
const previousCanvas = git('.', 'rev-parse', baseRef + ':integrations/infinite-canvas')
let previousRepository = ''
let repositoryBaselineFromMetadata = true
try {
  previousRepository = git('.', 'show', baseRef + ':.apophis-repository-sha')
} catch {
  // Releases before repository metadata was introduced keep the source
  // revision as the generated release commit's first parent. Use that stable
  // source baseline instead of refusing the first repository release.
  previousRepository = git('.', 'rev-parse', baseRef + '^1')
  repositoryBaselineFromMetadata = false
}
const previousUpstream = git('.', 'show', baseRef + ':.apophis-upstream-sha')
const canvasRoot = path.resolve("integrations/infinite-canvas")
let canvas = ""
if (previousCanvas !== env.CURRENT_CANVAS_SHA) {
  if (!/^[0-9a-f]{40}$/.test(previousCanvas || "") || !/^[0-9a-f]{40}$/.test(env.CURRENT_CANVAS_SHA || "")) {
    throw new Error("Canvas changelog requires both immutable source revisions.")
  }
  try {
    git(canvasRoot, "cat-file", "-e", `${previousCanvas}^{commit}`)
  } catch {
    git(canvasRoot, "fetch", "--depth=1", "origin", previousCanvas)
  }
  canvas = changelogChanges(
    git(canvasRoot, "show", `${previousCanvas}:CHANGELOG.md`),
    git(canvasRoot, "show", `${env.CURRENT_CANVAS_SHA}:CHANGELOG.md`),
  )
  if (!canvas) throw new Error("Canvas changed without concrete changelog entries; publication requires release notes.")
}
let repository = ""
if (env.RELEASE_KIND === "repository" || previousUpstream === env.UPSTREAM_SHA) {
  const base = previousRepository
  const head = env.CURRENT_REPOSITORY_SHA
  if (!/^[0-9a-f]{40}$/.test(base || "") || !/^[0-9a-f]{40}$/.test(head || "")) throw new Error("Repository notes require the last published revision.")
  if (repositoryBaselineFromMetadata) git(".", "merge-base", "--is-ancestor", base, head)
  repository = concreteSubjects(git(".", "log", "--reverse", "--format=%s", `${base}..${head}`).split("\n"))
}
const upstream = env.RELEASE_KIND === "upstream" && previousUpstream !== env.UPSTREAM_SHA
  ? readFileSync(path.join(generated, ".apophis-upstream-release-notes.md"), "utf8") : ""
const body = composeReleaseNotes({ upstream, canvas, repository, canvasTag: env.CANVAS_RELEASE_TAG || "" })
writeFileSync(path.join(generated, ".apophis-release-title"), `Sub2Aouter ${env.RELEASE_VERSION}\n`, "utf8")
writeFileSync(path.join(generated, ".apophis-release-notes.md"), body, "utf8")
