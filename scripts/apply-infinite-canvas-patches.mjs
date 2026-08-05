#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const templateRoot = path.join(scriptDir, 'infinite-canvas-integration', 'canvas-files')

async function replaceOnce(file, marker, replacement, sentinel) {
  let content = await readFile(file, 'utf8')
  if (sentinel && content.includes(sentinel)) return false
  let effectiveMarker = marker
  let effectiveReplacement = replacement
  let index = content.indexOf(effectiveMarker)
  if (index < 0 && marker.includes('\n')) {
    effectiveMarker = marker.replaceAll('\n', '\r\n')
    effectiveReplacement = replacement.replaceAll('\n', '\r\n')
    index = content.indexOf(effectiveMarker)
  }
  if (index < 0) throw new Error(`Infinite Canvas adapter marker not found in ${file}: ${marker.slice(0, 80)}`)
  content = `${content.slice(0, index)}${effectiveReplacement}${content.slice(index + effectiveMarker.length)}`
  await writeFile(file, content, 'utf8')
  return true
}

async function copyTemplate(root, relative) {
  const source = path.join(templateRoot, relative)
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(source, target)
}

export async function applyInfiniteCanvasPatches({ root }) {
  const resolvedRoot = path.resolve(root)
  const indexPath = path.join(resolvedRoot, 'web/index.html')
  const routerPath = path.join(resolvedRoot, 'web/src/router.tsx')
  const initPath = path.join(resolvedRoot, 'web/src/components/layout/client-root-init.tsx')
  const layoutPath = path.join(resolvedRoot, 'web/src/layouts/user-layout.tsx')
  const agentChatPath = path.join(resolvedRoot, 'web/src/components/agent/agent-chat.tsx')
  const homePath = path.join(resolvedRoot, 'web/src/pages/home/index.tsx')
  const historyTestPath = path.join(resolvedRoot, 'canvas-agent/src/agent/codex-history.test.ts')

  await copyTemplate(resolvedRoot, 'web/src/lib/sub2-bridge.ts')

  await replaceOnce(
    indexPath,
    '        <script>\n',
    '        <script nonce="__CSP_NONCE_VALUE__">\n',
    'nonce="__CSP_NONCE_VALUE__"'
  )

  await replaceOnce(
    routerPath,
    'export const router = createBrowserRouter([',
    'const routerBasename = import.meta.env.BASE_URL.replace(/\\/$/, "") || "/";\n\nexport const router = createBrowserRouter([',
    'const routerBasename = import.meta.env.BASE_URL'
  )

  let router = await readFile(routerPath, 'utf8')
  if (!router.includes('basename: routerBasename')) {
    const closing = /\]\);\s*$/
    if (!closing.test(router)) throw new Error(`Infinite Canvas router closing marker not found in ${routerPath}`)
    router = router.replace(closing, '], { basename: routerBasename });\n')
    await writeFile(routerPath, router, 'utf8')
  }

  await replaceOnce(
    initPath,
    'import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";',
    'import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";\nimport { installSub2Bridge } from "@/lib/sub2-bridge";',
    'import { installSub2Bridge } from "@/lib/sub2-bridge";'
  )

  await replaceOnce(
    initPath,
    '    usePromptSourceScheduler();\n',
    '    usePromptSourceScheduler();\n\n    useEffect(() => installSub2Bridge(), []);\n',
    'useEffect(() => installSub2Bridge(), []);'
  )

  await replaceOnce(
    layoutPath,
    'export default function UserLayout({ children }: { children: ReactNode }) {\n    return (',
    'export default function UserLayout({ children }: { children: ReactNode }) {\n    const embedded = typeof window !== "undefined" && window.parent !== window;\n\n    return (',
    'const embedded = typeof window !== "undefined" && window.parent !== window;'
  )


  const historyTest = await readFile(historyTestPath, 'utf8')
  if (historyTest.includes('\uFFFD')) {
    await writeFile(historyTestPath, historyTest.replaceAll('\uFFFD', '\\uFFFD'), 'utf8')
  }

  await replaceOnce(
    homePath,
    '                        <Button size="large" onClick={() => navigate("/canvas")}>\n                            \u6253\u5f00\u753b\u5e03\n                        </Button>\n',
    '                        <Button size="large" onClick={() => navigate("/canvas")}>\n                            \u6253\u5f00\u753b\u5e03\n                        </Button>\n                        <Button type="primary" size="large" onClick={() => navigate("/image")}>\n                            \u8fdb\u5165\u751f\u56fe\u5de5\u4f5c\u53f0\n                        </Button>\n',
    'navigate("/image")'
  )

  await replaceOnce(
    agentChatPath,
    'detail={"detail" in working ? working.detail : undefined}',
    'detail={"detail" in working && typeof working.detail === "string" ? working.detail : undefined}',
    'typeof working.detail === "string"'
  )

  await replaceOnce(
    layoutPath,
    '                <AppTopNav />',
    '                {!embedded && <AppTopNav />}',
    '{!embedded && <AppTopNav />}'
  )
}

async function main() {
  const args = process.argv.slice(2)
  const rootIndex = args.indexOf('--root')
  const root = rootIndex >= 0 ? args[rootIndex + 1] : args[0]
  if (!root) throw new Error('Usage: node scripts/apply-infinite-canvas-patches.mjs --root <path>')
  await applyInfiniteCanvasPatches({ root })
  console.log(`Infinite Canvas adapter applied: ${path.resolve(root)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
