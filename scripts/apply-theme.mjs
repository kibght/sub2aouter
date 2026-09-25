#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { applyTheme, checkTheme } from './lib/theme-overlay.mjs'

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const root = path.resolve(valueAfter('--root') || process.cwd())
const overlay = path.resolve(valueAfter('--overlay') || path.join(root, 'theme/apophis'))
const check = process.argv.includes('--check')

if (check) {
  const result = await checkTheme({ root, overlay })
  if (!result.ok) {
    console.error(`Theme drift detected:\n${result.drift.map((file) => `- ${file}`).join('\n')}`)
    process.exitCode = 1
  } else {
    console.log('Theme overlay is applied and current.')
  }
} else {
  const result = await applyTheme({ root, overlay })
  if (result.changed) {
    console.log(`Applied theme overlay:\n${result.changedFiles.map((file) => `- ${file}`).join('\n')}`)
  } else {
    console.log('Theme overlay already current.')
  }
}