#!/usr/bin/env node

import { verifyReleasePipelineContract } from './lib/release-pipeline-contract.mjs'

function parseRoot(argv) {
  const index = argv.indexOf('--root')
  if (index < 0) {
    return '.'
  }
  if (!argv[index + 1]) {
    throw new Error('--root requires a directory')
  }
  return argv[index + 1]
}

try {
  const root = parseRoot(process.argv.slice(2))
  const violations = await verifyReleasePipelineContract(root)
  if (violations.length > 0) {
    for (const item of violations) {
      console.error(`[${item.code}] ${item.path}: ${item.message}`)
    }
    process.exitCode = 1
  } else {
    console.log('Release pipeline contract verified.')
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
