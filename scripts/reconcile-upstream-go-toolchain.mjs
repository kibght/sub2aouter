import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dockerfiles = ['Dockerfile', 'backend/Dockerfile', 'deploy/Dockerfile']
const goVersionPattern = /^go (\d+\.\d+\.\d+)$/m
const golangImagePattern = /golang:[0-9]+\.[0-9]+\.[0-9]+-alpine/g

export async function reconcileUpstreamGoToolchain({ root }) {
  const goMod = await readFile(path.join(root, 'backend/go.mod'), 'utf8')
  const version = goMod.match(goVersionPattern)?.[1]
  if (!version) {
    throw new Error('backend/go.mod must declare a full Go version')
  }

  const changedFiles = []
  for (const file of dockerfiles) {
    const filePath = path.join(root, file)
    const source = await readFile(filePath, 'utf8')
    if (!source.match(golangImagePattern)) {
      throw new Error(`${file} has no full golang image reference to reconcile`)
    }
    const reconciled = source.replace(golangImagePattern, `golang:${version}-alpine`)
    if (reconciled !== source) {
      await writeFile(filePath, reconciled, 'utf8')
      changedFiles.push(file)
    }
  }

  return { version, changedFiles }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--root')
  const root = path.resolve(index >= 0 ? process.argv[index + 1] : process.cwd())
  const { version, changedFiles } = await reconcileUpstreamGoToolchain({ root })
  console.log(changedFiles.length
    ? `Aligned Go ${version} in: ${changedFiles.join(', ')}`
    : `Go ${version} image tags are already aligned.`)
}
