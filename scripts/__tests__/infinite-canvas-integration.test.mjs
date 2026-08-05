import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { applyInfiniteCanvasPatches } from '../apply-infinite-canvas-patches.mjs'

test('infinite canvas adapter applies cleanly and remains idempotent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'infinite-canvas-adapter-'))
  try {
    for (const relative of [
      'web/index.html',
      'web/src/router.tsx',
      'web/src/components/layout/client-root-init.tsx',
      'web/src/layouts/user-layout.tsx',
      'web/src/components/agent/agent-chat.tsx',
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
    const historyTest = await readFile(path.join(root, 'canvas-agent/src/agent/codex-history.test.ts'), 'utf8')
    const bridge = await readFile(path.join(root, 'web/src/lib/sub2-bridge.ts'), 'utf8')

    assert.match(indexHtml, /nonce="__CSP_NONCE_VALUE__"/)
    assert.match(router, /basename: routerBasename/)
    assert.match(init, /installSub2Bridge/)
    assert.match(layout, /window\.parent !== window/)
    assert.match(agentChat, /typeof working\.detail === \"string\"/)
    assert.doesNotMatch(historyTest, /\uFFFD/)
    assert.match(historyTest, /\\uFFFD\\uFFFD/)
    assert.match(bridge, /event\.origin !== window\.location\.origin/)
    assert.equal((init.match(/installSub2Bridge/g) || []).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
