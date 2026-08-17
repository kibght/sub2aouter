#!/usr/bin/env node

import { appendFile, writeFile } from 'node:fs/promises'

import { evaluateSyncHealth, fetchWorkflowSnapshot } from './lib/sync-health.mjs'

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`)
    }
    const name = argument.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`)
    }
    options[name] = value
    index += 1
  }
  return options
}

function githubOutputLines(result) {
  const delimiter = `SYNC_HEALTH_${Date.now()}`
  return [
    `healthy=${result.healthy}`,
    `state=${result.state}`,
    `should_dispatch=${result.shouldDispatch}`,
    `should_alert=${result.shouldAlert}`,
    `summary<<${delimiter}`,
    result.summary,
    delimiter,
  ].join('\n') + '\n'
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const repository = args.repository || process.env.GITHUB_REPOSITORY
  if (!repository) {
    throw new Error('--repository or GITHUB_REPOSITORY is required')
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
  const coordinator = args['coordinator-workflow'] || 'infinite-canvas-upstream-sync.yml'
  const publisher = args['publisher-workflow'] || 'upstream-theme-sync.yml'
  const workflows = await Promise.all([
    fetchWorkflowSnapshot({ repository, workflowId: coordinator, name: 'Infinite Canvas coordinator', token }),
    fetchWorkflowSnapshot({ repository, workflowId: publisher, name: 'Themed upstream publisher', token }),
  ])

  const result = evaluateSyncHealth({
    now: args.now || new Date(),
    staleAfterMinutes: Number(args['stale-after-minutes'] || 120),
    stuckAfterMinutes: Number(args['stuck-after-minutes'] || 90),
    workflows,
  })
  const json = `${JSON.stringify(result, null, 2)}\n`
  process.stdout.write(json)

  const githubOutput = args['github-output'] || process.env.GITHUB_OUTPUT
  if (githubOutput) {
    await appendFile(githubOutput, githubOutputLines(result), 'utf8')
  }
  if (args['json-output']) {
    await writeFile(args['json-output'], json, 'utf8')
  }
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})