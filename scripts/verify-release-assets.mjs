#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function verifyReleaseAssets({ version, release, dist = 'dist' }) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    throw new Error('Invalid release asset version.')
  }
  if (release !== undefined && (release?.tag_name !== `v${version}` || release.draft !== true || !Array.isArray(release.assets))) {
    throw new Error('Release assets must be staged in the expected draft before publication.')
  }
  const archives = [
    `sub2api_${version}_linux_amd64.tar.gz`,
    `sub2api_${version}_linux_arm64.tar.gz`,
    `sub2api_${version}_windows_amd64.zip`,
    `sub2api_${version}_darwin_amd64.tar.gz`,
    `sub2api_${version}_darwin_arm64.tar.gz`,
  ]
  const checksums = new Map()
  for (const line of (await readFile(path.join(dist, 'checksums.txt'), 'utf8')).split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line)
    if (!match || checksums.has(match[2])) throw new Error('Invalid or duplicate release checksum entry.')
    checksums.set(match[2], match[1])
  }
  for (const name of [...archives, 'checksums.txt']) {
    const contents = await readFile(path.join(dist, name))
    const hash = createHash('sha256').update(contents).digest('hex')
    if (contents.length === 0 || (name !== 'checksums.txt' && checksums.get(name) !== hash)) {
      throw new Error(`Local release checksum mismatch: ${name}`)
    }
    if (release === undefined) continue
    const matches = release.assets.filter((asset) => asset.name === name)
    if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].size !== contents.length || matches[0].digest !== `sha256:${hash}`) {
      throw new Error(`Staged release asset does not match the verified build: ${name}`)
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    if (!['--version', '--release-json', '--dist'].includes(args[index]) || !args[index + 1]) {
      throw new Error('Expected --version, --release-json, and --dist arguments.')
    }
    options.set(args[index], args[index + 1])
  }
  await verifyReleaseAssets({
    version: options.get('--version'),
    release: options.has('--release-json') ? JSON.parse(await readFile(options.get('--release-json'), 'utf8')) : undefined,
    dist: options.get('--dist'),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
