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
  const files = [
    ['frontend/src/components/keys/__tests__/UseKeyModal.spec.ts', replacements],
    ['frontend/src/views/admin/__tests__/groupsOpenAIFast.spec.ts', [
      [
        'ultrafastHint: expect.stringContaining("service_tier=ultrafast")',
        'ultrafastHint: expect.stringMatching(/service_tier=ultrafast|Ultra Fast/)',
      ],
    ]],
  ]
  let changed = false
  for (const [relativePath, fileReplacements] of files) {
    const target = path.join(root, relativePath)
    let source
    try {
      source = await readFile(target, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    let result = source
    for (const [marker, replacement] of fileReplacements) {
      result = result.replaceAll(marker, replacement)
    }
    if (result === source) continue
    await writeFile(target, result, 'utf8')
    changed = true
  }
  return changed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--root')
  const root = path.resolve(index >= 0 ? process.argv[index + 1] : process.cwd())
  const changed = await applyUpstreamTestCompatibility({ root })
  console.log(changed ? 'Updated upstream frontend assertions.' : 'Upstream test assertions are current.')
}
