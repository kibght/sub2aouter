#!/usr/bin/env node

import { appendFile, writeFile } from 'node:fs/promises'

import { fetchLatestRelease } from './lib/github-release.mjs'

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

function outputLines(result) {
  return [
    `found=${result.found}`,
    `tag=${result.tag}`,
    `id=${result.id}`,
    `published_at=${result.publishedAt}`,
  ].join('\n') + '\n'
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (!args.repository) {
    throw new Error('--repository is required')
  }

  const result = await fetchLatestRelease({
    repository: args.repository,
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '',
    attempts: args.attempts ? Number(args.attempts) : undefined,
    baseDelayMs: args['base-delay-ms'] ? Number(args['base-delay-ms']) : undefined,
  })

  const json = `${JSON.stringify(result, null, 2)}\n`
  process.stdout.write(json)

  const githubOutput = args['github-output'] || process.env.GITHUB_OUTPUT
  if (githubOutput) {
    await appendFile(githubOutput, outputLines(result), 'utf8')
  }
  if (args['json-output']) {
    await writeFile(args['json-output'], json, 'utf8')
  }
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})