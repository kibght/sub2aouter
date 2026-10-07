import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideHourlySync } from './sync-policy.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const ghPath = process.env.SUB2_SYNC_GH || 'gh'
const repository = 'kibght/sub2aouter'
const logRoot = process.env.SUB2_SYNC_LOG_DIR || path.join(root, 'logs')
const dryRun = process.argv.includes('--dry-run')
const gh = (args) => execFileSync(ghPath, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }).trim()
const api = (endpoint) => JSON.parse(gh(['api', endpoint]))
const readMetadata = (name) => {
  const file = api(`repos/${repository}/contents/${name}?ref=themed-release`)
  if (file.encoding !== 'base64') throw new Error('Invalid release metadata encoding.')
  return Buffer.from(file.content, 'base64').toString('utf8').trim()
}
const runs = (workflow) => JSON.parse(gh(['run', 'list', '-R', repository, '--workflow', workflow, '--branch', 'main', '--limit', '20', '--json', 'databaseId,status,conclusion,createdAt,url']))
const evidence = { evaluatedAt: new Date().toISOString(), repository, dryRun }
try {
  const coordinatorRuns = runs('infinite-canvas-upstream-sync.yml')
  const publisherRuns = runs('upstream-theme-sync.yml')
  const upstream = api('repos/Wei-Shaw/sub2api/releases/latest')
  if (!upstream.tag_name || !upstream.id) throw new Error('Invalid upstream release identity.')
  const synchronizedTag = readMetadata('.apophis-upstream-release-tag')
  const synchronizedId = readMetadata('.apophis-upstream-release-id')
  Object.assign(evidence, { upstreamTag: upstream.tag_name, upstreamPublishedAt: upstream.published_at, synchronizedTag, latestCoordinator: coordinatorRuns[0]?.createdAt })
  Object.assign(evidence, decideHourlySync({ coordinatorRuns, publisherRuns, upstream, synchronizedTag, synchronizedId }))
  if (evidence.dispatch && !dryRun) {
    // Recheck immediately before dispatching to avoid overlapping an arriving cron run.
    Object.assign(evidence, decideHourlySync({ coordinatorRuns: runs('infinite-canvas-upstream-sync.yml'), publisherRuns: runs('upstream-theme-sync.yml'), upstream, synchronizedTag, synchronizedId }))
    if (evidence.dispatch) {
      evidence.result = gh(['workflow', 'run', 'infinite-canvas-upstream-sync.yml', '-R', repository, '--ref', 'main'])
      evidence.dispatched = true
    }
  }
} catch (error) {
  evidence.error = error.message
  process.exitCode = 1
} finally {
  mkdirSync(logRoot, { recursive: true })
  appendFileSync(path.join(logRoot, `sync-${evidence.evaluatedAt.slice(0, 10)}.jsonl`), `${JSON.stringify(evidence)}\n`, 'utf8')
  console.log(JSON.stringify(evidence, null, 2))
}
