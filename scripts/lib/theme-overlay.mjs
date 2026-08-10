import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

function resolveWithin(base, relativePath) {
  const resolvedBase = path.resolve(base)
  const resolved = path.resolve(resolvedBase, relativePath)
  if (resolved !== resolvedBase && !resolved.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error(`Path escapes base directory: ${relativePath}`)
  }
  return resolved
}

async function readManifest(overlay) {
  const manifestPath = resolveWithin(overlay, 'manifest.json')
  return JSON.parse(await readFile(manifestPath, 'utf8'))
}

async function currentFile(target) {
  try {
    return { exists: true, content: await readFile(target) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, content: Buffer.alloc(0) }
    throw error
  }
}

async function currentBuffer(target) {
  return (await currentFile(target)).content
}

function normalizeTextBuffer(buffer) {
  if (buffer.includes(0)) return buffer
  return Buffer.from(buffer.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8')
}

function sha256(buffer) {
  return createHash('sha256').update(normalizeTextBuffer(buffer)).digest('hex')
}

function validateBaseline(buffer, entry) {
  if (!entry.expectedUpstreamSha256) return
  const actual = sha256(buffer)
  const legacy = Array.isArray(entry.legacySha256)
    ? entry.legacySha256
    : entry.legacySha256 ? [entry.legacySha256] : []
  if (actual !== entry.expectedUpstreamSha256 && !legacy.includes(actual)) {
    throw new Error(
      `Upstream baseline drift in ${entry.target}: expected ${entry.expectedUpstreamSha256}, actual ${actual}. ` +
      'Review the upstream/theme diff and update the baseline before applying the overlay.',
    )
  }
}

function normalizedPatchValues(text, patch, patchText = '') {
  const targetEol = text.includes('\r\n') ? '\r\n' : '\n'
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\n/g, targetEol)
  return {
    normalizedMarkers: [patch.marker, ...(patch.markers ?? [])].map(normalize).filter(Boolean),
    normalizedPatchText: normalize(patchText),
    normalizedSentinel: normalize(patch.sentinel),
  }
}

function componentEventBindings(patch) {
  const events = patch.forwardEvents ?? []
  for (const event of events) {
    if (!/^[A-Za-z][A-Za-z0-9:_-]*$/.test(event)) {
      throw new Error(`Invalid forwarded component event ${event} in ${patch.target}`)
    }
  }
  return events
}

function blockRange(match) {
  return {
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
  }
}

function findScriptSetupBlock(text) {
  const match = /<script(?=[^>]*\bsetup\b)[^>]*>[\s\S]*?<\/script>/.exec(text)
  return match ? blockRange(match) : null
}

function excludedSfcRanges(text) {
  const ranges = []
  for (const pattern of [/<script\b[^>]*>[\s\S]*?<\/script>/gi, /<style\b[^>]*>[\s\S]*?<\/style>/gi]) {
    for (const match of text.matchAll(pattern)) ranges.push(blockRange(match))
  }
  return ranges
}

function nextTemplateToken(text, from) {
  let start = text.indexOf('<', from)
  while (start >= 0 && !/[!/?A-Za-z]/.test(text[start + 1] || '')) {
    start = text.indexOf('<', start + 1)
  }
  if (start < 0) return null
  if (text.startsWith('<!--', start)) {
    const end = text.indexOf('-->', start + 4)
    if (end < 0) throw new Error('Unterminated template comment')
    return { start, end: end + 3, text: text.slice(start, end + 3), comment: true }
  }

  let quote = ''
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index]
    if (quote) {
      if (character === quote && text[index - 1] !== '\\') quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') {
      return { start, end: index + 1, text: text.slice(start, index + 1), comment: false }
    }
  }
  throw new Error('Unterminated template tag')
}

function findTemplateBlock(text, target) {
  const excluded = excludedSfcRanges(text)
  const openingPattern = /<template(?:\s[^>]*)?>/gi
  let opening
  for (const match of text.matchAll(openingPattern)) {
    if (excluded.some((range) => match.index >= range.start && match.index < range.end)) continue
    opening = match
    break
  }
  if (!opening) return null

  let depth = 1
  let cursor = opening.index + opening[0].length
  while (cursor < text.length) {
    const token = nextTemplateToken(text, cursor)
    if (!token) break
    cursor = token.end
    if (token.comment || token.text.startsWith('<!') || token.text.startsWith('<?')) continue
    const nameMatch = token.text.match(/^<\/?\s*([A-Za-z][A-Za-z0-9:_-]*)/)
    if (!nameMatch || nameMatch[1].toLowerCase() !== 'template') continue
    if (/^<\//.test(token.text)) {
      depth -= 1
      if (depth === 0) {
        return {
          start: opening.index,
          end: token.end,
          text: text.slice(opening.index, token.end),
        }
      }
      continue
    }
    if (!/\/\s*>$/.test(token.text)) depth += 1
  }
  throw new Error(`Unterminated template block in ${target}`)
}

function replaceRanges(text, replacements) {
  let result = text
  for (const { range, value } of [...replacements].sort((left, right) => right.range.start - left.range.start)) {
    result = `${result.slice(0, range.start)}${value}${result.slice(range.end)}`
  }
  return result
}

function mountedComponentBlocks(text, patch) {
  const targetEol = text.includes('\r\n') ? '\r\n' : '\n'
  const events = componentEventBindings(patch)
  const scriptLines = [
    '<script setup lang="ts">',
    `import ${patch.componentName} from '${patch.importPath}'`,
  ]
  if (events.length > 0) {
    scriptLines.push(`const emit = defineEmits([${events.map((event) => `'${event}'`).join(', ')}])`)
  }
  scriptLines.push('</script>')
  const eventBindings = events.map((event) => ` @${event}="emit('${event}')"`).join('')
  return {
    script: scriptLines.join(targetEol),
    template: [
      '<template>',
      `  <${patch.componentName}${eventBindings} />`,
      '</template>',
    ].join(targetEol),
  }
}

function mountedImportCount(scriptBlock, patch) {
  const importLine = `import ${patch.componentName} from '${patch.importPath}'`
  return scriptBlock.split(/\r?\n/).filter((line) => line === importLine).length
}

function isPatchApplied(text, patch, patchText = '') {
  if (patch.operation === 'mount-component') {
    if (!patch.componentName || !patch.importPath) return false
    const scriptBlock = findScriptSetupBlock(text)
    const templateBlock = findTemplateBlock(text, patch.target)
    if (!scriptBlock || !templateBlock) return false
    const mounted = mountedComponentBlocks(text, patch)
    return scriptBlock.text === mounted.script && templateBlock.text === mounted.template
  }
  if (patch.operation === 'mount-default-component') {
    if (!patch.componentName || !patch.importPath) return false
    const scriptBlock = findScriptSetupBlock(text)
    const templateBlock = findTemplateBlock(text, patch.target)
    if (!scriptBlock || !templateBlock || mountedImportCount(scriptBlock.text, patch) !== 1) return false
    try {
      return replaceTopLevelElseBranch(
        templateBlock.text,
        `<${patch.componentName} v-else />`,
        patch.target,
      ) === templateBlock.text
    } catch {
      return false
    }
  }
  if (patch.operation === 'remove') {
    const { normalizedMarkers } = normalizedPatchValues(text, patch, patchText)
    return normalizedMarkers.every((marker) => !text.includes(marker))
  }
  const { normalizedPatchText, normalizedSentinel } = normalizedPatchValues(text, patch, patchText)
  if (normalizedPatchText && text.includes(normalizedPatchText)) return true
  return Boolean(!normalizedPatchText && normalizedSentinel && text.includes(normalizedSentinel))
}

function mountComponent(text, patch) {
  if (!patch.componentName || !patch.importPath) {
    throw new Error(`mount-component requires componentName and importPath for ${patch.target}`)
  }
  if (isPatchApplied(text, patch)) return text

  const scriptBlock = findScriptSetupBlock(text)
  const templateBlock = findTemplateBlock(text, patch.target)
  if (!scriptBlock) {
    throw new Error(`Theme component mount requires one script setup block in ${patch.target}`)
  }
  if (!templateBlock) {
    throw new Error(`Theme component mount requires one template block in ${patch.target}`)
  }
  const mounted = mountedComponentBlocks(text, patch)
  return replaceRanges(text, [
    { range: scriptBlock, value: mounted.script },
    { range: templateBlock, value: mounted.template },
  ])
}

const HTML_VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
])

function replaceTopLevelElseBranch(templateBlock, replacement, target) {
  const openEnd = templateBlock.indexOf('>') + 1
  const closeStart = templateBlock.lastIndexOf('</template>')
  if (openEnd <= 0 || closeStart < openEnd) {
    throw new Error(`Invalid template block in ${target}`)
  }
  const body = templateBlock.slice(openEnd, closeStart)
  const stack = []
  let candidateStart = -1
  let cursor = 0

  while (cursor < body.length) {
    const token = nextTemplateToken(body, cursor)
    if (!token) break
    cursor = token.end
    if (token.comment || token.text.startsWith('<!') || token.text.startsWith('<?')) continue

    const closing = /^<\//.test(token.text)
    const nameMatch = token.text.match(/^<\/?\s*([A-Za-z][A-Za-z0-9:_-]*)/)
    if (!nameMatch) continue
    const name = nameMatch[1].toLowerCase()

    if (closing) {
      if (stack.length === 0) throw new Error(`Unexpected closing tag in ${target}`)
      const opened = stack.pop()
      if (opened !== name) throw new Error(`Mismatched closing tag in ${target}: expected ${opened}, received ${name}`)
      if (candidateStart >= 0 && stack.length === 0) {
        return `${templateBlock.slice(0, openEnd)}${body.slice(0, candidateStart)}${replacement}${body.slice(token.end)}${templateBlock.slice(closeStart)}`
      }
      continue
    }

    const topLevel = stack.length === 0
    const candidate = topLevel && /\bv-else\b(?!-if)/.test(token.text)
    const selfClosing = /\/\s*>$/.test(token.text) || HTML_VOID_ELEMENTS.has(name)
    if (candidate) candidateStart = token.start
    if (!selfClosing) stack.push(name)
    if (candidate && selfClosing) {
      return `${templateBlock.slice(0, openEnd)}${body.slice(0, token.start)}${replacement}${body.slice(token.end)}${templateBlock.slice(closeStart)}`
    }
  }

  throw new Error(`Top-level v-else branch not found in ${target}`)
}

function mountDefaultComponent(text, patch) {
  if (!patch.componentName || !patch.importPath) {
    throw new Error(`mount-default-component requires componentName and importPath for ${patch.target}`)
  }
  if (isPatchApplied(text, patch)) return text

  const targetEol = text.includes('\r\n') ? '\r\n' : '\n'
  const scriptBlock = findScriptSetupBlock(text)
  const templateBlock = findTemplateBlock(text, patch.target)
  if (!scriptBlock || !templateBlock) {
    throw new Error(`Theme default component mount requires script setup and template blocks in ${patch.target}`)
  }

  const scriptOpenEnd = scriptBlock.text.indexOf('>') + 1
  const importLine = `import ${patch.componentName} from '${patch.importPath}'`
  const mountedScript = `${scriptBlock.text.slice(0, scriptOpenEnd)}${targetEol}${importLine}${scriptBlock.text.slice(scriptOpenEnd)}`
  const mountedTemplate = replaceTopLevelElseBranch(
    templateBlock.text,
    `<${patch.componentName} v-else />`,
    patch.target,
  )
  return replaceRanges(text, [
    { range: scriptBlock, value: mountedScript },
    { range: templateBlock, value: mountedTemplate },
  ])
}

function applyPatch(text, patch, patchText = '') {
  if (patch.operation === 'mount-component') return mountComponent(text, patch)
  if (patch.operation === 'mount-default-component') return mountDefaultComponent(text, patch)

  const {
    normalizedMarkers,
    normalizedPatchText,
    normalizedSentinel,
  } = normalizedPatchValues(text, patch, patchText)

  if (normalizedPatchText && text.includes(normalizedPatchText)) return text

  const matchedMarker = normalizedMarkers
    .map((marker, index) => ({ marker, index: text.indexOf(marker), legacy: index > 0 }))
    .find(({ index }) => index >= 0)
  if (matchedMarker && normalizedPatchText && normalizedSentinel && text.includes(normalizedSentinel) && !matchedMarker.legacy) {
    throw new Error(`Theme patch drift in ${patch.target}: sentinel exists without the exact replacement`)
  }
  if (matchedMarker) {
    const { marker, index } = matchedMarker
    if (patch.operation === 'replace' || patch.operation === 'remove') {
      return `${text.slice(0, index)}${normalizedPatchText}${text.slice(index + marker.length)}`
    }
    const insertionIndex = patch.position === 'after' ? index + marker.length : index
    return `${text.slice(0, insertionIndex)}${normalizedPatchText}${text.slice(insertionIndex)}`
  }
  if (patch.operation === 'remove') return text
  if (!normalizedPatchText && normalizedSentinel && text.includes(normalizedSentinel)) return text
  if (normalizedPatchText && normalizedSentinel && text.includes(normalizedSentinel)) {
    throw new Error(`Theme patch drift in ${patch.target}: sentinel exists without the exact replacement`)
  }
  throw new Error(`Patch marker not found in ${patch.target}: ${patch.marker}`)
}

async function expectedTargets({ root, overlay }) {
  const manifest = await readManifest(overlay)
  const expected = new Map()

  for (const entry of manifest.additions ?? []) {
    const source = resolveWithin(overlay, entry.source)
    const target = resolveWithin(root, entry.target)
    const sourceContent = await readFile(source)
    const current = await currentFile(target)
    if (current.exists && !current.content.equals(sourceContent)) {
      throw new Error(`Refusing to overwrite existing addition target ${entry.target}`)
    }
    expected.set(target, {
      relative: entry.target,
      content: sourceContent,
    })
  }

  for (const entry of manifest.files ?? []) {
    const source = resolveWithin(overlay, entry.source)
    const target = resolveWithin(root, entry.target)
    const sourceContent = await readFile(source)
    const current = await currentBuffer(target)
    if (!current.equals(sourceContent)) validateBaseline(current, entry)
    expected.set(target, {
      relative: entry.target,
      content: sourceContent,
    })
  }

  for (const patch of manifest.patches ?? []) {
    const target = resolveWithin(root, patch.target)
    const base = expected.get(target)?.content ?? await currentBuffer(target)
    const patchText = patch.source
      ? await readFile(resolveWithin(overlay, patch.source), 'utf8')
      : ''
    if (!isPatchApplied(base.toString('utf8'), patch, patchText)) validateBaseline(base, patch)
    const patched = applyPatch(base.toString('utf8'), patch, patchText)
    expected.set(target, {
      relative: patch.target,
      content: Buffer.from(patched, 'utf8'),
    })
  }

  return expected
}

export async function checkTheme({ root, overlay }) {
  const expected = await expectedTargets({ root, overlay })
  const drift = []
  for (const [target, entry] of expected) {
    const current = await currentBuffer(target)
    if (!current.equals(entry.content)) drift.push(entry.relative)
  }
  return { ok: drift.length === 0, drift }
}

export async function applyTheme({ root, overlay }) {
  const expected = await expectedTargets({ root, overlay })
  let changed = false
  const changedFiles = []

  for (const [target, entry] of expected) {
    const current = await currentBuffer(target)
    if (current.equals(entry.content)) continue
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, entry.content)
    changed = true
    changedFiles.push(entry.relative)
  }

  return { changed, changedFiles }
}
