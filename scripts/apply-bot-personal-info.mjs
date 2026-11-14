#!/usr/bin/env node

// Add the personal-info endpoint after the binding, QQ, and check-in overlays.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SOURCE_FILES = [
  'backend/internal/handler/bot_personal_info.go',
  'backend/internal/handler/bot_personal_info_test.go',
  'backend/internal/repository/usage_log_repo_personal_info_test.go',
  'docs/bot-personal-info.md',
]

const normalize = (text) => text.replaceAll('\r\n', '\n')
const fail = (message) => { throw new Error(message) }

function replaceBlock(source, pattern, transform, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, 'gm'))]
  if (matches.length !== 1) fail('unsupported ' + label + ': expected one block')
  const match = matches[0]
  return source.slice(0, match.index) + transform(match[0]) + source.slice(match.index + match[0].length)
}

function composeHandler(source) {
  return replaceBlock(source, /^type BotHandler struct \{[\s\S]*?^\}/m, (block) => {
    if (/^\tconcurrency\b/m.test(block)) {
      if (!/^\tconcurrency\s+botConcurrencyReader\s*$/m.test(block)) fail('unsupported BotHandler concurrency field')
      return block
    }
    return block.replace(/\n\}$/, '\n\tconcurrency         botConcurrencyReader\n}')
  }, 'BotHandler')
}

function composeProvider(source) {
  return replaceBlock(source, /^func ProvideBotHandler\([\s\S]*?^\}/m, (block) => {
    const parts = block.match(/^(func ProvideBotHandler\(\n)([\s\S]*?)(\) \*BotHandler \{\n)([\s\S]*)$/)
    if (!parts) fail('unsupported bot provider signature')
    let params = parts[2]
    let body = parts[4]
    if (params.includes('concurrencyCache')) {
      if (!/^\tconcurrencyCache service\.ConcurrencyCache,\n$/.test(params.slice(params.lastIndexOf('\tconcurrencyCache')))) {
        fail('unsupported bot provider concurrency parameter')
      }
    } else {
      if (!/^\tusers \*service\.UserService,$/m.test(params)) fail('unsupported bot provider user parameter')
      params += '\tconcurrencyCache service.ConcurrencyCache,\n'
    }
    if (body.includes('SetConcurrencyReader')) {
      if (!/^\th\.SetConcurrencyReader\(concurrencyCache\)$/m.test(body)) fail('unsupported bot provider concurrency setter')
    } else {
      if (!body.includes('\th := NewBotHandler(bindings, usage, apiKeys, users)\n') || !body.includes('\treturn h\n')) {
        fail('unsupported bot provider construction')
      }
      body = body.replace('\treturn h\n', '\th.SetConcurrencyReader(concurrencyCache)\n\treturn h\n')
    }
    return parts[1] + params + parts[3] + body
  }, 'ProvideBotHandler')
}

function composeWire(source) {
  if (!/^\tconcurrencyCache := repository\.ProvideConcurrencyCache\(/m.test(source)) {
    fail('generated Wire concurrency cache is missing')
  }
  return replaceBlock(source, /^\tbotHandler := handler\.ProvideBotHandler\([^\n]*\)$/m, (call) => {
    const args = call.slice(call.indexOf('(') + 1, -1).split(',').map((arg) => arg.trim())
    const required = ['botBindingService', 'usageService', 'apiKeyService', 'userService']
    if (args.some((arg) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) || required.some((arg) => !args.includes(arg))) {
      fail('unsupported generated bot provider arguments')
    }
    if (args.includes('concurrencyCache')) {
      if (args.at(-1) !== 'concurrencyCache' || args.filter((arg) => arg === 'concurrencyCache').length !== 1) {
        fail('unsupported generated bot concurrency argument')
      }
      return call
    }
    return call.slice(0, -1) + ', concurrencyCache)'
  }, 'generated bot provider')
}

function composeRoutes(source) {
  for (const middleware of ['gin.HandlerFunc(adminAuth)', 'gin.HandlerFunc(botAuth)', 'panelRateLimiter.Global()']) {
    if (!source.includes('bot.Use(' + middleware + ')')) fail('bot authentication or global rate limit is missing: ' + middleware)
  }
  const endpoint = '\t\tbot.GET("/personal-info", panelRateLimiter.Heavy(), h.Bot.PersonalInfo)'
  if (source.includes('"/personal-info"')) {
    const declarations = source.split('\n').filter((line) => line.includes('"/personal-info"'))
    if (declarations.length !== 1 || declarations[0] !== endpoint) fail('unsupported personal-info route or missing heavy rate limit')
    return source
  }
  return replaceBlock(source, /^\t\tbot\.GET\("\/profile", h\.Bot\.Profile\)$/m, (anchor) => anchor + '\n' + endpoint, 'bot profile route')
}

function composeIgnore(source) {
  const exception = '!docs/bot-personal-info.md'
  if (source.split('\n').includes(exception)) return source
  return source + (source.endsWith('\n') ? '' : '\n') + exception + '\n'
}

function main() {
  const argv = process.argv.slice(2)
  const valueOf = (name, fallback) => {
    const index = argv.indexOf(name)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
  }
  const root = path.resolve(valueOf('--root', '.'))
  const ref = valueOf('--ref', 'origin/QQbot')
  const checkOnly = argv.includes('--check')
  const planned = new Map()

  for (const file of SOURCE_FILES) {
    const content = execFileSync('git', ['show', ref + ':' + file], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    const target = path.join(root, file)
    if (checkOnly) {
      if (!existsSync(target) || normalize(readFileSync(target, 'utf8')) !== normalize(content.toString('utf8'))) {
        fail('source file is missing or differs from ' + ref + ': ' + file)
      }
    } else {
      planned.set(target, content)
    }
  }

  for (const [file, transform] of [
    ['backend/internal/handler/bot_handler.go', composeHandler],
    ['backend/internal/handler/wire.go', composeProvider],
    ['backend/cmd/server/wire_gen.go', composeWire],
    ['backend/internal/server/routes/bot.go', composeRoutes],
    ...(existsSync(path.join(root, '.gitignore')) ? [['.gitignore', composeIgnore]] : []),
  ]) {
    const target = path.join(root, file)
    const original = readFileSync(target, 'utf8')
    const normalized = normalize(original)
    const composed = transform(normalized)
    if (checkOnly) {
      if (composed !== normalized) fail('personal-info integration is missing in ' + file)
    } else if (composed !== normalized) {
      planned.set(target, original.includes('\r\n') ? composed.replaceAll('\n', '\r\n') : composed)
    }
  }

  // Validate every shared anchor before writing any file.
  for (const [target, content] of planned) {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  console.log((checkOnly ? 'Verified' : 'Applied') + ' bot personal-info overlay from ' + ref + '.')
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error('apply-bot-personal-info: ' + error.message)
    process.exitCode = 1
  }
}
