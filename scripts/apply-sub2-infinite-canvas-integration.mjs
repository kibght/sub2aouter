#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const templateRoot = path.join(scriptDir, 'infinite-canvas-integration', 'sub2-files')

export async function reconcileInfiniteCanvasLocaleBlock(file, block, check = false) {
  const content = await readFile(file, 'utf8')
  const blockStart = content.indexOf('  infiniteCanvas: {')
  const authMarker = '  // Auth'
  const canonicalEnd = block.indexOf(authMarker)
  const canonicalBlock = (canonicalEnd >= 0 ? block.slice(0, canonicalEnd) : block).replace(/\n+$/, '\n\n')
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n'
  const effectiveBlock = canonicalBlock.replaceAll('\n', lineEnding)

  if (blockStart < 0) {
    if (check) throw new Error(`Infinite Canvas locale block missing in ${file}`)
    const authIndex = content.indexOf(authMarker)
    if (authIndex < 0) throw new Error(`Infinite Canvas locale auth marker missing in ${file}`)
    await writeFile(file, `${content.slice(0, authIndex)}${effectiveBlock}${content.slice(authIndex)}`, 'utf8')
    return true
  }

  const blockEnd = content.indexOf(authMarker, blockStart)
  if (blockEnd < 0) throw new Error(`Infinite Canvas locale auth marker missing in ${file}`)
  const currentBlock = content.slice(blockStart, blockEnd)
  if (currentBlock === effectiveBlock) return false
  if (check) throw new Error(`Infinite Canvas locale block drift in ${file}`)

  await writeFile(file, `${content.slice(0, blockStart)}${effectiveBlock}${content.slice(blockEnd)}`, 'utf8')
  return true
}

export async function patchCanvasDefaultCSP(file, check = false) {
  const content = await readFile(file, 'utf8')
  const match = /const DefaultCSPPolicy = "([^"\r\n]*)"/.exec(content)
  if (!match) throw new Error(`Infinite Canvas default CSP marker missing in ${file}`)

  let policy = match[1]
  let patched = policy
  const hasDirectiveValue = (directive, value) => patched.split(';').some((rawDirective) => {
    const fields = rawDirective.trim().split(/\s+/)
    return fields[0] === directive && fields.slice(1).includes(value)
  })

  const connectMarker = "connect-src 'self'"
  const canvasAgentSource = 'http://127.0.0.1:17371'
  if (!hasDirectiveValue('connect-src', canvasAgentSource)) {
    if (!patched.includes(connectMarker)) throw new Error(`Infinite Canvas connect-src marker missing in ${file}`)
    patched = patched.replace(connectMarker, `${connectMarker} ${canvasAgentSource}`)
  }

  const frameMarker = 'frame-src '
  if (!hasDirectiveValue('frame-src', "'self'")) {
    if (!patched.includes(frameMarker)) throw new Error(`Infinite Canvas frame-src marker missing in ${file}`)
    patched = patched.replace(frameMarker, "frame-src 'self' ")
  }

  if (patched === policy) return false
  if (check) throw new Error(`Infinite Canvas default CSP drift in ${file}`)

  const replacement = match[0].replace(policy, patched)
  await writeFile(file, `${content.slice(0, match.index)}${replacement}${content.slice(match.index + match[0].length)}`, 'utf8')
  return true
}

const newFiles = [
  'frontend/src/features/infiniteCanvas/bridge.ts',
  'frontend/src/features/infiniteCanvas/__tests__/bridge.spec.ts',
  'frontend/src/views/user/InfiniteCanvasView.vue',
  'frontend/src/views/user/__tests__/InfiniteCanvasView.spec.ts',
  'backend/internal/web/canvas_routing.go',
  'backend/internal/web/canvas_routing_test.go',
  'docs/infinite-canvas.md',
  'integrations/README.md',
]

function withDetectedLineEndings(content, value) {
  return content.includes('\r\n') ? value.replaceAll('\n', '\r\n') : value
}

export async function ensureReplace(file, marker, replacement, sentinel, check) {
  const content = await readFile(file, 'utf8')
  const effectiveMarker = withDetectedLineEndings(content, marker)
  const effectiveReplacement = withDetectedLineEndings(content, replacement)
  const effectiveSentinel = withDetectedLineEndings(content, sentinel)
  if (content.includes(effectiveReplacement)) return false
  if (effectiveSentinel && content.includes(effectiveSentinel)) {
    throw new Error(`Infinite Canvas integration drift in ${file}: sentinel exists without the exact replacement`)
  }
  if (check) throw new Error(`Infinite Canvas integration sentinel missing in ${file}: ${sentinel}`)

  const index = content.indexOf(effectiveMarker)
  if (index < 0) throw new Error(`Infinite Canvas integration marker not found in ${file}: ${marker.slice(0, 100)}`)
  await writeFile(
    file,
    `${content.slice(0, index)}${effectiveReplacement}${content.slice(index + effectiveMarker.length)}`,
    'utf8'
  )
  return true
}

async function ensureNewFiles(root, check) {
  for (const relative of newFiles) {
    const source = path.join(templateRoot, relative)
    const target = path.join(root, relative)
    if (check) {
      const [expected, actual] = await Promise.all([readFile(source), readFile(target)])
      if (!expected.equals(actual)) throw new Error(`Infinite Canvas integration file drift: ${target}`)
      continue
    }
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(source, target)
  }
}

async function patchDockerfile(file, check) {
  await ensureReplace(
    file,
    'ARG NODE_IMAGE=node:24-alpine\n',
    'ARG NODE_IMAGE=node:24-alpine\nARG BUN_IMAGE=oven/bun:1.3.13\n',
    'ARG BUN_IMAGE=oven/bun:1.3.13',
    check
  )

  const canvasStage = `# -----------------------------------------------------------------------------
# Stage 0: Infinite Canvas Builder
# -----------------------------------------------------------------------------
FROM --platform=\${BUILDPLATFORM} \${BUN_IMAGE} AS canvas-builder

WORKDIR /app
COPY integrations/infinite-canvas ./infinite-canvas
COPY scripts/apply-infinite-canvas-patches.mjs ./scripts/apply-infinite-canvas-patches.mjs
COPY scripts/infinite-canvas-integration ./scripts/infinite-canvas-integration
RUN bun ./scripts/apply-infinite-canvas-patches.mjs --root /app/infinite-canvas

WORKDIR /app/infinite-canvas/web
RUN --mount=type=cache,id=infinite-canvas-bun,target=/root/.bun/install/cache \\
    bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
RUN VITE_BASE=/canvas-app/ bun run typecheck && VITE_BASE=/canvas-app/ bun run build && cp ../VERSION dist/version.txt

# -----------------------------------------------------------------------------
# Stage 1: Frontend Builder
# -----------------------------------------------------------------------------
`
  await ensureReplace(
    file,
    '# -----------------------------------------------------------------------------\n# Stage 1: Frontend Builder\n# -----------------------------------------------------------------------------\n',
    canvasStage,
    'AS canvas-builder',
    check
  )
  await ensureReplace(
    file,
    'RUN pnpm run build\n',
    'RUN pnpm run build\nCOPY --from=canvas-builder /app/infinite-canvas/web/dist /app/backend/internal/web/dist/canvas-app\n',
    'COPY --from=canvas-builder /app/infinite-canvas/web/dist /app/backend/internal/web/dist/canvas-app',
    check
  )
}

export async function applySub2InfiniteCanvasIntegration({ root, check = false }) {
  const resolvedRoot = path.resolve(root)
  await ensureNewFiles(resolvedRoot, check)

  await ensureReplace(
    path.join(resolvedRoot, '.gitignore'),
    '!docs/legal/*.md\n',
    '!docs/legal/*.md\n!docs/infinite-canvas.md\n',
    '!docs/infinite-canvas.md',
    check
  )

  await ensureReplace(
    path.join(resolvedRoot, 'frontend/src/router/index.ts'),
    "  {\n    path: '/batch-image',\n",
    `  {
    path: '/workspace/canvas',
    name: 'InfiniteCanvas',
    component: () => import('@/views/user/InfiniteCanvasView.vue'),
    meta: {
      requiresAuth: true,
      requiresAdmin: false,
      title: 'Infinite Canvas',
      titleKey: 'infiniteCanvas.title',
      descriptionKey: 'infiniteCanvas.description'
    }
  },
  {
    path: '/batch-image',
`,
    "path: '/workspace/canvas'",
    check
  )

  await ensureReplace(
    path.join(resolvedRoot, 'frontend/src/components/layout/AppSidebar.vue'),
    "    { path: '/keys', label: t('nav.apiKeys'), icon: KeyIcon },\n    { path: '/batch-image'",
    "    { path: '/keys', label: t('nav.apiKeys'), icon: KeyIcon },\n    { path: '/workspace/canvas', label: t('nav.infiniteCanvas'), icon: BatchImageIcon },\n    { path: '/batch-image'",
    "path: '/workspace/canvas', label: t('nav.infiniteCanvas')",
    check
  )

  const localePatches = [
    {
      file: 'frontend/src/i18n/locales/zh/common.ts',
      navMarker: "    apiKeys: 'API 密钥',",
      navReplacement: "    apiKeys: 'API 密钥',\n    infiniteCanvas: '无限画布',",
      block: `  infiniteCanvas: {
    title: '无限画布',
    description: '使用当前 API 密钥直接进入 AI 图片、视频与创意工作台',
    frameTitle: '无限画布创作工作台',
    selectKey: '选择画布使用的 API 密钥',
    openStandalone: '新窗口打开',
    loadingKeys: '正在读取可用 API 密钥…',
    noKeyTitle: '需要一个可用的 API 密钥',
    noKeyDescription: '先创建或启用一个 API 密钥，画布会通过同源安全通道使用它，密钥不会出现在地址栏。',
    manageKeys: '管理 API 密钥',
    connecting: '正在安全连接无限画布…',
    connectionFailed: '无限画布没有正确启动',
    connectionFailedDescription: '请检查发布包是否包含 Canvas 产物，然后重试。',
    retry: '重新连接',
    loadKeysFailed: '读取 API 密钥失败',
    statusIdle: '等待连接',
    statusConnecting: '连接中',
    statusReady: '已连接',
    statusError: '连接失败',
    connectCodex: '连接 Codex',
    codexHelpTitle: '连接 Codex',
    codexHelpDescription: '固定入口和本地 Agent 检测都在这里完成。',
    fixedEntry: '固定入口',
    copyAgentCommand: '复制 Agent 命令',
    agentChecking: '正在检测本地 Agent',
    agentAvailable: 'Agent 已连接',
    agentUnavailable: '未检测到 Agent',
    checkAgentAgain: '重新检测',
    downloadStartAgent: '下载/启动 Agent',
    downloadStartAgentDescription: '安装 Node.js 后，在终端执行上面的命令，并保持 Agent 运行。',
    closeCodexHelp: '关闭连接 Codex 帮助',
    noTokenInUrl: '不把 token 放在公共 URL 中，连接配置只通过安全通道传递。',
  },

  // Auth
`,
    },
    {
      file: 'frontend/src/i18n/locales/en/common.ts',
      navMarker: "    apiKeys: 'API Keys',",
      navReplacement: "    apiKeys: 'API Keys',\n    infiniteCanvas: 'Infinite Canvas',",
      block: `  infiniteCanvas: {
    title: 'Infinite Canvas',
    description: 'Open the AI image, video, and creative workspace with your current API key',
    frameTitle: 'Infinite Canvas creative workspace',
    selectKey: 'Select the API key used by Canvas',
    openStandalone: 'Open in new window',
    loadingKeys: 'Loading available API keys…',
    noKeyTitle: 'An active API key is required',
    noKeyDescription: 'Create or enable an API key first. Canvas receives it through a same-origin channel and never places it in the address bar.',
    manageKeys: 'Manage API keys',
    connecting: 'Connecting to Infinite Canvas securely…',
    connectionFailed: 'Infinite Canvas did not start correctly',
    connectionFailedDescription: 'Verify that the release contains the Canvas build output, then retry.',
    retry: 'Reconnect',
    loadKeysFailed: 'Failed to load API keys',
    statusIdle: 'Waiting',
    statusConnecting: 'Connecting',
    statusReady: 'Connected',
    statusError: 'Connection failed',
    connectCodex: 'Connect Codex',
    codexHelpTitle: 'Connect Codex',
    codexHelpDescription: 'Use the fixed entry and check the local Agent from this panel.',
    fixedEntry: 'Fixed entry',
    copyAgentCommand: 'Copy Agent command',
    agentChecking: 'Checking local Agent',
    agentAvailable: 'Agent connected',
    agentUnavailable: 'Agent not detected',
    checkAgentAgain: 'Check again',
    downloadStartAgent: 'Download/start Agent',
    downloadStartAgentDescription: 'Install Node.js, run the command above in a terminal, and keep the Agent running.',
    closeCodexHelp: 'Close Connect Codex help',
    noTokenInUrl: 'Tokens are not placed in public URLs; connection configuration uses the secure channel.',
  },

  // Auth
`,
    },
  ]
  for (const locale of localePatches) {
    const file = path.join(resolvedRoot, locale.file)
    const navSentinel = locale.navReplacement.split('\n')[1]
    await ensureReplace(file, locale.navMarker, locale.navReplacement, navSentinel, check)
    await reconcileInfiniteCanvasLocaleBlock(file, locale.block, check)
  }

  await ensureReplace(
    path.join(resolvedRoot, 'backend/internal/service/content_moderation_runtime_cache_test.go'),
    `\tsvc := runtimeCacheTestService(repo, time.Nanosecond)
\tinput := runtimeCacheTestInput("blocked")

\tdecision, err := svc.Check(context.Background(), input)
\trequire.NoError(t, err)
\trequire.True(t, decision.Blocked)

\trepo.failMultiple(errors.New("database unavailable"))
`,
    `\tsvc := runtimeCacheTestService(repo, time.Minute)
\tinput := runtimeCacheTestInput("blocked")

\tdecision, err := svc.Check(context.Background(), input)
\trequire.NoError(t, err)
\trequire.True(t, decision.Blocked)

\t// Expire deterministically because coarse clock resolution can make a nanosecond TTL flaky.
\tcurrent := svc.runtimeSnapshot.Load()
\trequire.NotNil(t, current)
\texpired := *current
\texpired.loadedAt = time.Now().Add(-2 * time.Minute)
\tsvc.runtimeSnapshot.Store(&expired)

\trepo.failMultiple(errors.New("database unavailable"))
`,
    'Expire deterministically because coarse clock resolution can make a nanosecond TTL flaky.',
    check
  )

  await patchCanvasDefaultCSP(path.join(resolvedRoot, 'backend/internal/config/config.go'), check)

  const securityHeadersFile = path.join(resolvedRoot, 'backend/internal/server/middleware/security_headers.go')
  await ensureReplace(
    securityHeadersFile,
    `var requiredCSPDirectiveValues = []struct {
\tdirective string
\tvalue     string
}{
`,
    `var requiredCSPDirectiveValues = []struct {
\tdirective string
\tvalue     string
}{
\t{"frame-src", "'self'"},
\t{"connect-src", "http://127.0.0.1:17371"},
`,
    `{"connect-src", "http://127.0.0.1:17371"}`,
    check
  )
  await ensureReplace(
    securityHeadersFile,
    `\treturn func(c *gin.Context) {
\t\tfinalPolicy := policy
\t\tif getFrameSrcOrigins != nil {
`,
    `\treturn func(c *gin.Context) {
\t\tfinalPolicy := policy
\t\tcanvasAppRoute := isCanvasAppRoutePath(c)
\t\tif canvasAppRoute {
\t\t\tfinalPolicy = replaceDirective(finalPolicy, "frame-ancestors", "'self'")
\t\t}
\t\tif getFrameSrcOrigins != nil {
`,
    'canvasAppRoute := isCanvasAppRoutePath(c)',
    check
  )
  await ensureReplace(
    securityHeadersFile,
    `\t\tc.Header("X-Frame-Options", "DENY")
`,
    `\t\tif canvasAppRoute {
\t\t\tc.Header("X-Frame-Options", "SAMEORIGIN")
\t\t} else {
\t\t\tc.Header("X-Frame-Options", "DENY")
\t\t}
`,
    'c.Header("X-Frame-Options", "SAMEORIGIN")',
    check
  )
  await ensureReplace(
    securityHeadersFile,
    'func isAPIRoutePath(c *gin.Context) bool {\n',
    `func isCanvasAppRoutePath(c *gin.Context) bool {
\tif c == nil || c.Request == nil || c.Request.URL == nil {
\t\treturn false
\t}
\trequestPath := c.Request.URL.Path
\treturn requestPath == "/canvas-app" || strings.HasPrefix(requestPath, "/canvas-app/")
}

func isAPIRoutePath(c *gin.Context) bool {
`,
    'func isCanvasAppRoutePath(c *gin.Context)',
    check
  )
  await ensureReplace(
    securityHeadersFile,
    '// addToDirective adds a value to a specific CSP directive.\n',
    `func replaceDirective(policy, directive, value string) string {
\tparts := strings.Split(policy, ";")
\treplaced := false
\tfor index, rawDirective := range parts {
\t\tfields := strings.Fields(strings.TrimSpace(rawDirective))
\t\tif len(fields) == 0 || fields[0] != directive {
\t\t\tcontinue
\t\t}
\t\tparts[index] = " " + directive + " " + value
\t\treplaced = true
\t}
\tif !replaced {
\t\treturn addToDirective(policy, directive, value)
\t}
\treturn strings.TrimSpace(strings.Join(parts, ";"))
}

// addToDirective adds a value to a specific CSP directive.
`,
    'func replaceDirective(policy, directive, value string)',
    check
  )

  await ensureReplace(
    path.join(resolvedRoot, 'backend/internal/server/middleware/security_headers_test.go'),
    `\t})

\tt.Run("csp_disabled_no_csp_header", func(t *testing.T) {
`,
    `\t})

\tt.Run("allows_same_origin_canvas_embedding", func(t *testing.T) {
\t\tcfg := config.CSPConfig{Enabled: true, Policy: config.DefaultCSPPolicy}
\t\tmiddleware := SecurityHeaders(cfg, nil)

\t\tw := httptest.NewRecorder()
\t\tc, _ := gin.CreateTestContext(w)
\t\tc.Request = httptest.NewRequest(http.MethodGet, "/canvas-app/", nil)

\t\tmiddleware(c)

\t\tassert.Equal(t, "SAMEORIGIN", w.Header().Get("X-Frame-Options"))
\t\tcsp := w.Header().Get("Content-Security-Policy")
\t\tassert.Contains(t, csp, "frame-ancestors 'self'")
\t\tassert.True(t, directiveHasValue(csp, "frame-src", "'self'"))
\t\tassert.NotContains(t, csp, "frame-ancestors 'none'")
\t})

\tt.Run("csp_disabled_no_csp_header", func(t *testing.T) {
`,
    'allows_same_origin_canvas_embedding',
    check
  )

  const embedFile = path.join(resolvedRoot, 'backend/internal/web/embed_on.go')
  await ensureReplace(
    embedFile,
    `\t\t// For index.html or SPA routes, serve with injected settings
\t\tif cleanPath == "index.html" || !s.fileExists(cleanPath) {
\t\t\ts.serveIndexHTML(c)
\t\t\treturn
\t\t}
`,
    `\t\t// For index.html or SPA routes, serve the correct application shell.
\t\tif cleanPath == "index.html" {
\t\t\ts.serveIndexHTML(c)
\t\t\treturn
\t\t}
\t\tif !s.fileExists(cleanPath) {
\t\t\tindexPath, canvas := resolveEmbeddedSPARequest(path)
\t\t\tif canvas {
\t\t\t\ts.serveStaticHTML(c, indexPath)
\t\t\t\treturn
\t\t\t}
\t\t\ts.serveIndexHTML(c)
\t\t\treturn
\t\t}
`,
    's.serveStaticHTML(c, indexPath)',
    check
  )
  await ensureReplace(
    embedFile,
    `func (s *FrontendServer) fileExists(path string) bool {
\tfile, err := s.distFS.Open(path)
\tif err != nil {
\t\treturn false
\t}
\t_ = file.Close()
\treturn true
}
`,
    `func (s *FrontendServer) fileExists(path string) bool {
\tfile, err := s.distFS.Open(path)
\tif err != nil {
\t\treturn false
\t}
\t_ = file.Close()
\treturn true
}

func (s *FrontendServer) serveStaticHTML(c *gin.Context, indexPath string) {
\tfile, err := s.distFS.Open(indexPath)
\tif err != nil {
\t\tc.String(http.StatusNotFound, "Frontend not found")
\t\tc.Abort()
\t\treturn
\t}
\tdefer func() { _ = file.Close() }()

\tcontent, err := io.ReadAll(file)
\tif err != nil {
\t\tc.String(http.StatusInternalServerError, "Failed to read frontend")
\t\tc.Abort()
\t\treturn
\t}
\t// Apply the request nonce to the Canvas shell.
\tcontent = replaceNoncePlaceholder(content, middleware.GetNonceFromContext(c))

\tc.Header("Cache-Control", "no-cache")
\tc.Data(http.StatusOK, "text/html; charset=utf-8", content)
\tc.Abort()
}
`,
    'Apply the request nonce to the Canvas shell.',
    check
  )
  await ensureReplace(
    embedFile,
    `\t\tserveIndexHTML(c, distFS)
`,
    `\t\tindexPath, _ := resolveEmbeddedSPARequest(path)
\t\tserveHTMLFile(c, distFS, indexPath)
`,
    'indexPath, _ := resolveEmbeddedSPARequest(path)',
    check
  )
  await ensureReplace(
    embedFile,
    `func serveIndexHTML(c *gin.Context, fsys fs.FS) {
\tfile, err := fsys.Open("index.html")
`,
    `func serveIndexHTML(c *gin.Context, fsys fs.FS) {
\tserveHTMLFile(c, fsys, "index.html")
}

func serveHTMLFile(c *gin.Context, fsys fs.FS, indexPath string) {
\tfile, err := fsys.Open(indexPath)
`,
    'func serveHTMLFile(c *gin.Context',
    check
  )

  await ensureReplace(
    embedFile,
    `\tcontent, err := io.ReadAll(file)
\tif err != nil {
\t\tc.String(http.StatusInternalServerError, "Failed to read index.html")
\t\tc.Abort()
\t\treturn
\t}

\tc.Data(http.StatusOK, "text/html; charset=utf-8", content)
`,
    `\tcontent, err := io.ReadAll(file)
\tif err != nil {
\t\tc.String(http.StatusInternalServerError, "Failed to read index.html")
\t\tc.Abort()
\t\treturn
\t}
\t// Apply the request nonce to the selected SPA shell.
\tcontent = replaceNoncePlaceholder(content, middleware.GetNonceFromContext(c))

\tc.Data(http.StatusOK, "text/html; charset=utf-8", content)
`,
    'Apply the request nonce to the selected SPA shell.',
    check
  )

  await ensureReplace(
    path.join(resolvedRoot, 'backend/internal/web/static_cache_test.go'),
    '\t\t{name: "fingerprinted_js", path: "assets/index-AbCd1234.js", want: true},\n',
    '\t\t{name: "fingerprinted_js", path: "assets/index-AbCd1234.js", want: true},\n\t\t{name: "canvas_fingerprinted_js", path: "canvas-app/assets/index-AbCd1234.js", want: true},\n',
    'canvas_fingerprinted_js',
    check
  )

  await ensureReplace(
    path.join(resolvedRoot, 'backend/internal/web/static_cache.go'),
    'if !strings.HasPrefix(cleanPath, "assets/") {',
    'if !strings.HasPrefix(cleanPath, "assets/") && !strings.HasPrefix(cleanPath, "canvas-app/assets/") {',
    'strings.HasPrefix(cleanPath, "canvas-app/assets/")',
    check
  )

  await patchDockerfile(path.join(resolvedRoot, 'Dockerfile'), check)
  await patchDockerfile(path.join(resolvedRoot, 'deploy/Dockerfile'), check)
}

async function main() {
  const args = process.argv.slice(2)
  const rootIndex = args.indexOf('--root')
  const root = rootIndex >= 0 ? args[rootIndex + 1] : args[0]
  const check = args.includes('--check')
  if (!root) throw new Error('Usage: node scripts/apply-sub2-infinite-canvas-integration.mjs --root <path> [--check]')
  await applySub2InfiniteCanvasIntegration({ root, check })
  console.log(`${check ? 'Verified' : 'Applied'} Sub2 Infinite Canvas integration: ${path.resolve(root)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
