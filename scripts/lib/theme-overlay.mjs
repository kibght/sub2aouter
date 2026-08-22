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

async function currentBuffer(target) {
  try {
    return await readFile(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return Buffer.alloc(0)
    throw error
  }
}

function applyPatch(text, patch, patchText) {
  const targetEol = text.includes('\r\n') ? '\r\n' : '\n'
  const normalize = (value) => String(value || '').replace(/\r\n?/g, '\n').replace(/\n/g, targetEol)
  const normalizedMarkers = [patch.marker, ...(patch.markers ?? [])]
    .map(normalize)
    .filter(Boolean)
  const normalizedPatchText = normalize(patchText)
  const normalizedSentinel = normalize(patch.sentinel)

  if (normalizedPatchText && text.includes(normalizedPatchText)) return text

  const matchedMarker = normalizedMarkers
    .map((marker, index) => ({ marker, index: text.indexOf(marker), legacy: index > 0 }))
    .find(({ index }) => index >= 0)
  if (matchedMarker && normalizedPatchText && normalizedSentinel && text.includes(normalizedSentinel) && !matchedMarker.legacy) {
    throw new Error(`Theme patch drift in ${patch.target}: sentinel exists without the exact replacement`)
  }
  if (matchedMarker) {
    const { marker, index } = matchedMarker
    if (patch.operation === 'replace') {
      return `${text.slice(0, index)}${normalizedPatchText}${text.slice(index + marker.length)}`
    }
    const insertionIndex = patch.position === 'after' ? index + marker.length : index
    return `${text.slice(0, insertionIndex)}${normalizedPatchText}${text.slice(insertionIndex)}`
  }
  if (normalizedPatchText && patch.optional === true && normalizedSentinel && text.includes(normalizedSentinel)) return text
  if (!normalizedPatchText && normalizedSentinel && text.includes(normalizedSentinel)) return text
  if (normalizedPatchText && normalizedSentinel && text.includes(normalizedSentinel)) {
    throw new Error(`Theme patch drift in ${patch.target}: sentinel exists without the exact replacement`)
  }
  if (patch.optional === true) return text
  throw new Error(`Patch marker not found in ${patch.target}: ${patch.marker}`)
}

async function expectedTargets({ root, overlay }) {
  const manifest = await readManifest(overlay)
  const expected = new Map()

  for (const entry of manifest.files ?? []) {
    const source = resolveWithin(overlay, entry.source)
    const target = resolveWithin(root, entry.target)
    expected.set(target, {
      relative: entry.target,
      content: await readFile(source),
    })
  }

  for (const patch of manifest.patches ?? []) {
    const target = resolveWithin(root, patch.target)
    const base = expected.get(target)?.content ?? await currentBuffer(target)
    const patchSource = resolveWithin(overlay, patch.source)
    const patched = applyPatch(base.toString('utf8'), patch, await readFile(patchSource, 'utf8'))
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