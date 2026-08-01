import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache'])
const textExtensions = new Set([
  '.css', '.go', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.npmrc', '.ps1',
  '.sh', '.sql', '.ts', '.tsx', '.txt', '.vue', '.yaml', '.yml',
])
const replacementCharacter = String.fromCodePoint(0xfffd)
const mojibakeMarker = String.fromCodePoint(0x951f, 0x65a4, 0x62f7)
const suspiciousMarkers = [
  ['U+FFFD', replacementCharacter],
  [mojibakeMarker, mojibakeMarker],
]

function isTextFile(name) {
  if (name === 'Dockerfile' || name === 'Makefile') return true
  return textExtensions.has(path.extname(name).toLowerCase())
}

export async function scanTextFiles(root) {
  const base = path.resolve(root)
  const issues = []
  const decoder = new TextDecoder('utf-8', { fatal: true })

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(path.join(directory, entry.name))
        continue
      }
      if (!entry.isFile() || !isTextFile(entry.name)) continue

      const absolute = path.join(directory, entry.name)
      const relative = path.relative(base, absolute).split(path.sep).join('/')
      const buffer = await readFile(absolute)
      let text
      try {
        text = decoder.decode(buffer)
      } catch {
        issues.push({ file: relative, markers: ['invalid UTF-8'] })
        continue
      }
      const markers = suspiciousMarkers.filter(([, value]) => text.includes(value)).map(([label]) => label)
      if (markers.length > 0) issues.push({ file: relative, markers })
    }
  }

  await visit(base)
  return issues
}