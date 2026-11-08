#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const replacements = [
  [
    "expect(configToml).toContain('[features]\\ngoals = true')",
    String.raw`expect(configToml).toMatch(/\[features\]\n(?:api_key_model_discovery = true\n)?goals = true/)`,
  ],
  [
    "expect(configToml).toContain('[features]\\nresponses_websockets_v2 = true\\ngoals = true')",
    String.raw`expect(configToml).toMatch(/\[features\]\n(?:api_key_model_discovery = true\n)?responses_websockets_v2 = true\ngoals = true/)`,
  ],
]

export async function applyUpstreamTestCompatibility({ root }) {
  const target = path.join(root, 'frontend/src/components/keys/__tests__/UseKeyModal.spec.ts')
  let source
  try {
    source = await readFile(target, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  let result = source
  for (const [marker, replacement] of replacements) {
    result = result.replaceAll(marker, replacement)
  }
  if (result === source) return false
  await writeFile(target, result, 'utf8')
  return true
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--root')
  const root = path.resolve(index >= 0 ? process.argv[index + 1] : process.cwd())
  const changed = await applyUpstreamTestCompatibility({ root })
  console.log(changed ? 'Updated upstream Codex feature assertions.' : 'Upstream test assertions are current.')
}
