#!/usr/bin/env node
import process from 'node:process'
import { scanTextFiles } from './lib/encoding-check.mjs'

const root = process.argv[2] || process.cwd()
const issues = await scanTextFiles(root)
if (issues.length > 0) {
  console.error('Encoding problems detected:')
  for (const issue of issues) console.error(`- ${issue.file}: ${issue.markers.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('UTF-8 encoding check passed.')
}