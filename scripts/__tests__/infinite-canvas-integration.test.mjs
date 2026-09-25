import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  applyInfiniteCanvasPatches,
  patchModelScriptEditorModalStyles,
} from '../apply-infinite-canvas-patches.mjs'

test('infinite canvas adapter removes the Ant Design 6 modal content style key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'infinite-canvas-model-script-editor-'))
  const file = path.join(root, 'model-script-editor.tsx')
  try {
    await writeFile(file, `
<Modal
  styles={{
    wrapper: { overflow: "hidden" },
    content: { height: "100dvh", maxHeight: "100dvh", margin: 0, padding: 0, borderRadius: 0, overflow: "hidden" },
    body: { height: "100dvh", maxHeight: "100dvh", padding: 0, overflow: "hidden" },
  }}
>
</Modal>
`)

    await patchModelScriptEditorModalStyles(file)
    await patchModelScriptEditorModalStyles(file)

    const patched = await readFile(file, 'utf8')
    assert.doesNotMatch(patched, /content: \{ height: "100dvh"/)
    assert.match(patched, /wrapper: \{ overflow: "hidden" \}/)
    assert.match(patched, /body: \{ height: "100dvh"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('infinite canvas adapter applies cleanly and remains idempotent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'infinite-canvas-adapter-'))
  try {
    for (const relative of [
      'web/index.html',
      'web/src/router.tsx',
      'web/src/components/layout/client-root-init.tsx',
      'web/src/layouts/user-layout.tsx',
      'web/src/components/agent/agent-chat.tsx',
      'web/src/pages/home/index.tsx',
      'web/src/services/api/image.ts',
      'web/src/services/image-storage.ts',
      'canvas-agent/src/agent/codex-history.test.ts',
    ]) {
      const target = path.join(root, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await cp(path.join('integrations/infinite-canvas', relative), target, { recursive: true })
    }

    await applyInfiniteCanvasPatches({ root })
    await applyInfiniteCanvasPatches({ root })

    const indexHtml = await readFile(path.join(root, 'web/index.html'), 'utf8')
    const router = await readFile(path.join(root, 'web/src/router.tsx'), 'utf8')
    const init = await readFile(path.join(root, 'web/src/components/layout/client-root-init.tsx'), 'utf8')
    const layout = await readFile(path.join(root, 'web/src/layouts/user-layout.tsx'), 'utf8')
    const agentChat = await readFile(path.join(root, 'web/src/components/agent/agent-chat.tsx'), 'utf8')
    const home = await readFile(path.join(root, 'web/src/pages/home/index.tsx'), 'utf8')
    const historyTest = await readFile(path.join(root, 'canvas-agent/src/agent/codex-history.test.ts'), 'utf8')
    const bridge = await readFile(path.join(root, 'web/src/lib/sub2-bridge.ts'), 'utf8')
    const imageApi = await readFile(path.join(root, 'web/src/services/api/image.ts'), 'utf8')
    const imageStorage = await readFile(path.join(root, 'web/src/services/image-storage.ts'), 'utf8')
    const sub2CanvasView = await readFile('scripts/infinite-canvas-integration/sub2-files/frontend/src/views/user/InfiniteCanvasView.vue', 'utf8')
    const childBridge = await readFile('scripts/infinite-canvas-integration/canvas-files/web/src/lib/sub2-bridge.ts', 'utf8')

    assert.match(indexHtml, /nonce="__CSP_NONCE_VALUE__"/)
    assert.match(router, /basename: routerBasename/)
    assert.match(init, /installSub2Bridge/)
    assert.match(layout, /window\.parent !== window/)
    assert.match(agentChat, /typeof working\.detail === \"string\"/)
    assert.match(home, /navigate\(\"\/image\"\)/)
    assert.match(home, /\u8fdb\u5165\u751f\u56fe\u5de5\u4f5c\u53f0/)
    assert.equal((home.match(/\u8fdb\u5165\u751f\u56fe\u5de5\u4f5c\u53f0/g) || []).length, 1)
    assert.doesNotMatch(historyTest, /\uFFFD/)
    assert.match(historyTest, /\\uFFFD\\uFFFD/)
    assert.match(bridge, /event\.origin !== targetOrigin/)
    assert.match(
      bridge,
      /state\.config\.channels\.map\(\(channel\) => \(\{ \.\.\.channel, baseUrl: gatewayBaseUrl, apiKey: gatewayApiKey, apiFormat: "openai"(?: as const)? \}\)\)/
    )
    assert.match(bridge, /state\.updateConfig\("apiFormat", "openai"\)/)
    assert.match(imageStorage, /const storedUrl = image\.storageKey \? await resolveImageUrl\(image\.storageKey, ""\) : "";/)
    assert.match(imageStorage, /apiErrors\.referenceImageReadFailed/)
    assert.match(imageApi, /const imageField = files\.length > 1 \? "image\[\]" : "image";/)
    assert.match(
      bridge,
      /state\.config\.channels\.map\(\(channel\) => \(\{ \.\.\.channel, baseUrl: gatewayBaseUrl, apiKey: gatewayApiKey, apiFormat: "openai"(?: as const)? \}\)\)/
    )
    assert.match(bridge, /state\.updateConfig\("apiFormat", "openai"\)/)
    assert.match(sub2CanvasView, /buildCanvasEntryUrl\(window\.location\.origin\)/)
    assert.match(sub2CanvasView, /window\.open\(canvasEntryUrl, 'sub2-infinite-canvas'\)/)
    assert.match(sub2CanvasView, /standaloneWindow/)
    assert.match(sub2CanvasView, /@click\.prevent="openStandalone"/)
    assert.match(sub2CanvasView, /cachedPublicSettings\?\.api_base_url/)
    assert.match(childBridge, /import \{ changeAppLocale, type AppLocale \} from "@\/i18n"/)
    assert.match(childBridge, /const \{ baseUrl, apiKey, theme, locale \} = event\.data\.payload/)
    assert.match(childBridge, /changeAppLocale\(locale(?: as AppLocale)?\)/)
    assert.match(
      childBridge,
      /state\.config\.channels\.map\(\(channel\) => \(\{ \.\.\.channel, baseUrl: gatewayBaseUrl, apiKey: gatewayApiKey, apiFormat: "openai"(?: as const)? \}\)\)/
    )
    assert.match(childBridge, /state\.updateConfig\("apiFormat", "openai"\)/)
    assert.match(childBridge, /window\.parent !== window \? window\.parent : window\.opener/)
    assert.match(childBridge, /event\.source !== host/)
    assert.equal((init.match(/installSub2Bridge/g) || []).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('infinite canvas adapter accepts the translated v0.14 home button', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'infinite-canvas-adapter-i18n-'))
  try {
    for (const relative of [
      'web/index.html',
      'web/src/router.tsx',
      'web/src/components/layout/client-root-init.tsx',
      'web/src/layouts/user-layout.tsx',
      'web/src/components/agent/agent-chat.tsx',
      'web/src/pages/home/index.tsx',
      'canvas-agent/src/agent/codex-history.test.ts',
    ]) {
      const target = path.join(root, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await cp(path.join('integrations/infinite-canvas', relative), target, { recursive: true })
    }

    const homePath = path.join(root, 'web/src/pages/home/index.tsx')
    const home = await readFile(homePath, 'utf8')
    const translatedHome = home.includes('{t("home.openCanvas")}')
      ? home
      : home.replace(
          /(<Button size="large" onClick=\{\(\) => navigate\("\/canvas"\)\}>\r?\n)(\s*)[^\r\n]+(\r?\n\s*<\/Button>)/,
          (_, opening, indentation, closing) => `${opening}${indentation}{t("home.openCanvas")}${closing}`,
        )
    assert.match(translatedHome, /\{t\("home\.openCanvas"\)\}/, 'fixture must model the v0.14 translated home button')
    await writeFile(homePath, translatedHome, 'utf8')

    await applyInfiniteCanvasPatches({ root })
    await applyInfiniteCanvasPatches({ root })

    const patchedHome = await readFile(homePath, 'utf8')
    assert.match(patchedHome, /navigate\("\/image"\)/)
    assert.equal((patchedHome.match(/navigate\("\/image"\)/g) || []).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
