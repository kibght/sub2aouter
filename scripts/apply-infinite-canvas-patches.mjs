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

function withLineEndings(content, value) {
  return content.includes('\r\n') ? value.replaceAll('\n', '\r\n') : value
}

function replaceText(content, marker, replacement, file) {
  const effectiveMarker = withLineEndings(content, marker)
  if (!content.includes(effectiveMarker)) {
    throw new Error(`Infinite Canvas adapter marker not found in ${file}: ${marker.slice(0, 100)}`)
  }
  return content.replace(effectiveMarker, withLineEndings(content, replacement))
}

export async function patchCanvasGenerationHelpers(file) {
  let content
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (content.includes('node.metadata?.images')) return false
  if (!content.includes('node.metadata.images')) return false
  content = content.replaceAll('node.metadata.images', 'node.metadata?.images')
  await writeFile(file, content, 'utf8')
  return true
}

export async function patchCanvasImageStorage(file) {
  let content
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }

  let changed = false
  if (!content.includes('const memoryBlobs = new Map<string, Blob>();')) {
    content = replaceText(
      content,
      'const objectUrls = new Map<string, string>();\n',
      'const objectUrls = new Map<string, string>();\nconst memoryBlobs = new Map<string, Blob>();\n',
      file,
    )
    changed = true
  }

  if (!content.includes('export function isImageFile(file: Blob & { name?: string })')) {
    content = replaceText(
      content,
      'type ImageReadOptions = { signal?: AbortSignal };\n',
      [
        'type ImageReadOptions = { signal?: AbortSignal };',
        '',
        'const IMAGE_FILE_EXTENSIONS = /\\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i;',
        '',
        'export function isImageFile(file: Blob & { name?: string }) {',
        '    const type = file.type?.toLowerCase() || "";',
        '    const name = typeof file.name === "string" ? file.name : "";',
        '    return type.startsWith("image/") || IMAGE_FILE_EXTENSIONS.test(name);',
        '}',
        '',
        'function normalizeImageBlob(blob: Blob) {',
        '    if (blob.type?.toLowerCase().startsWith("image/")) return blob;',
        '    const name = "name" in blob && typeof (blob as Blob & { name?: unknown }).name === "string" ? String((blob as Blob & { name?: unknown }).name) : "";',
        '    const mimeType = name.match(/\\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i)?.[1];',
        '    const normalizedType = mimeType ? `image/${mimeType.toLowerCase().replace("jpg", "jpeg")}` : "image/png";',
        '    return new Blob([blob], { type: normalizedType });',
        '}',
        '',
      ].join('\n'),
      file,
    )
    changed = true
  }

  if (!content.includes('return storeImage(normalizeImageBlob(input), options);')) {
    content = replaceText(
      content,
      '    if (typeof input !== "string") return storeImage(input, options);\n',
      '    if (typeof input !== "string") return storeImage(normalizeImageBlob(input), options);\n',
      file,
    )
    changed = true
  }

  if (!content.includes('return storeImage(normalizeImageBlob(blob), options);')) {
    content = replaceText(
      content,
      '    return storeImage(blob, options);\n',
      '    return storeImage(normalizeImageBlob(blob), options);\n',
      file,
    )
    changed = true
  }
  const storageMarker = '    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));\n'
  const storageReplacement = [
    '    const storedUrl = image.storageKey ? await resolveImageUrl(image.storageKey, "") : "";',
    '    const url = storedUrl || image.dataUrl || image.url || "";',
    '',
  ].join('\n')
  if (!content.includes('const storedUrl = image.storageKey ? await resolveImageUrl(image.storageKey, "")')) {
    const effectiveMarker = content.includes(storageMarker) ? storageMarker : storageMarker.replaceAll('\n', '\r\n')
    if (!content.includes(effectiveMarker)) throw new Error(`Infinite Canvas image storage marker not found in ${file}`)
    const effectiveReplacement = content.includes('\r\n') ? storageReplacement.replaceAll('\n', '\r\n') : storageReplacement
    content = content.replace(effectiveMarker, effectiveReplacement)
    changed = true
  }

  if (!content.includes('memoryBlobs.set(storageKey, blob);')) {
    content = replaceText(
      content,
      '        await store.setItem(storageKey, blob);\n',
      [
        '        try {',
        '            await store.setItem(storageKey, blob);',
        '        } catch {',
        '            // Private browsing and quota-restricted contexts can reject IndexedDB.',
        '            memoryBlobs.set(storageKey, blob);',
        '        }',
      ].join('\n') + '\n',
      file,
    )
    changed = true
  }

  if (!content.includes('memoryBlobs.delete(storageKey);')) {
    content = replaceText(
      content,
      '        URL.revokeObjectURL(url);\n        await store.removeItem(storageKey).catch(() => undefined);\n',
      '        URL.revokeObjectURL(url);\n        memoryBlobs.delete(storageKey);\n        await store.removeItem(storageKey).catch(() => undefined);\n',
      file,
    )
    changed = true
  }

  if (!content.includes('blob = blob || memoryBlobs.get(storageKey) || null;')) {
    content = replaceText(
      content,
      '    const blob = await store.getItem<Blob>(storageKey);\n',
      [
        '    let blob: Blob | null = null;',
        '    try {',
        '        blob = await store.getItem<Blob>(storageKey);',
        '    } catch {',
        '        blob = null;',
        '    }',
        '    blob = blob || memoryBlobs.get(storageKey) || null;',
      ].join('\n') + '\n',
      file,
    )
    changed = true
  }

  const getImageBlobStart = content.indexOf('export async function getImageBlob(storageKey: string)')
  const getImageBlobEnd = content.indexOf('export function previewUrlFor', getImageBlobStart)
  const getImageBlobSource = getImageBlobStart >= 0 && getImageBlobEnd > getImageBlobStart ? content.slice(getImageBlobStart, getImageBlobEnd) : ''
  if (!getImageBlobSource.includes('return blob || memoryBlobs.get(storageKey) || null;')) {
    content = replaceText(
      content,
      'export async function getImageBlob(storageKey: string) {\n    return store.getItem<Blob>(storageKey);\n}\n',
      [
        'export async function getImageBlob(storageKey: string) {',
        '    let blob: Blob | null = null;',
        '    try {',
        '        blob = await store.getItem<Blob>(storageKey);',
        '    } catch {',
        '        blob = null;',
        '    }',
        '    return blob || memoryBlobs.get(storageKey) || null;',
        '}',
        '',
      ].join('\n'),
      file,
    )
    changed = true
  }

  if (!content.includes('memoryBlobs.delete(key);')) {
    content = replaceText(
      content,
      '            await store.removeItem(key);\n',
      '            memoryBlobs.delete(key);\n            await store.removeItem(key).catch(() => undefined);\n',
      file,
    )
    changed = true
  }

  const setImageBlobStart = content.indexOf('export async function setImageBlob(storageKey: string, blob: Blob)')
  const setImageBlobEnd = content.indexOf('export async function imageToDataUrl', setImageBlobStart)
  const setImageBlobSource = setImageBlobStart >= 0 && setImageBlobEnd > setImageBlobStart ? content.slice(setImageBlobStart, setImageBlobEnd) : ''
  if (!setImageBlobSource.includes('memoryBlobs.set(storageKey, blob);')) {
    content = replaceText(
      content,
      'export async function setImageBlob(storageKey: string, blob: Blob) {\n    await store.setItem(storageKey, blob);\n',
      [
        'export async function setImageBlob(storageKey: string, blob: Blob) {',
        '    try {',
        '        await store.setItem(storageKey, blob);',
        '    } catch {',
        '        memoryBlobs.set(storageKey, blob);',
        '    }',
      ].join('\n') + '\n',
      file,
    )
    changed = true
  }

  const errorSentinel = 'apiErrors.referenceImageReadFailed'
  if (!content.includes(errorSentinel)) {
    const fetchMarker = '    return blobToDataUrl(await fetchImageBlob(url, options));\n'
    const legacyFetchMarker = '    return blobToDataUrl(await (await fetch(url)).blob());\n'
    const effectiveFetchMarker = content.includes(fetchMarker) ? fetchMarker : fetchMarker.replaceAll('\n', '\r\n')
    const effectiveLegacyFetchMarker = content.includes(legacyFetchMarker) ? legacyFetchMarker : legacyFetchMarker.replaceAll('\n', '\r\n')
    const usesFetchImageBlob = content.includes(effectiveFetchMarker)
    const effectiveMarker = usesFetchImageBlob ? effectiveFetchMarker : effectiveLegacyFetchMarker
    if (!content.includes(effectiveMarker)) throw new Error(`Infinite Canvas image read marker not found in ${file}`)
    const expression = usesFetchImageBlob ? 'await fetchImageBlob(url, options)' : 'await (await fetch(url)).blob()'
    const replacement = [
      '    try {',
      `        return blobToDataUrl(${expression});`,
      '    } catch (error) {',
      '        if (error instanceof Error && error.name === "AbortError") throw error;',
      '        throw new Error(i18n.t("apiErrors.referenceImageReadFailed"));',
      '    }',
      '',
    ].join('\n')
    const effectiveReplacement = content.includes('\r\n') ? replacement.replaceAll('\n', '\r\n') : replacement
    content = content.replace(effectiveMarker, effectiveReplacement)
    changed = true
  }

  if (changed) await writeFile(file, content, 'utf8')
  return changed
}

export async function patchCanvasImageApi(file) {
  let content
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }

  let changed = false
  const imageResponseFormat = '                response_format: "b64_json",'
  const compatibleImageResponseFormat = '                ...(/gpt-image/.test(requestConfig.model) ? {} : { response_format: "b64_json" }),'
  if (content.includes(imageResponseFormat)) {
    content = content.replaceAll(imageResponseFormat, compatibleImageResponseFormat)
    changed = true
  }

  const formResponseMarker = '\n    formData.set("response_format", "b64_json");\n'
  const formResponseSentinel = '\n    if (!/gpt-image/.test(requestConfig.model)) {'
  if (!content.includes(formResponseSentinel) && !content.includes(formResponseSentinel.replaceAll('\n', '\r\n'))) {
    const effectiveMarker = content.includes(formResponseMarker) ? formResponseMarker : formResponseMarker.replaceAll('\n', '\r\n')
    if (content.includes(effectiveMarker)) {
      const replacement = [
        '',
        '    if (!/gpt-image/.test(requestConfig.model)) {',
        '        formData.set("response_format", "b64_json");',
        '    }',
        '',
      ].join('\n')
      const effectiveReplacement = content.includes('\r\n') ? replacement.replaceAll('\n', '\r\n') : replacement
      content = content.replace(effectiveMarker, effectiveReplacement)
      changed = true
    }
  }

  const imageAppendMarker = '\n    files.forEach((file) => formData.append("image", file));\n'
  if (!content.includes('const imageField = files.length > 1 ? "image[]" : "image";')) {
    const effectiveMarker = content.includes(imageAppendMarker) ? imageAppendMarker : imageAppendMarker.replaceAll('\n', '\r\n')
    if (content.includes(effectiveMarker)) {
      const replacement = [
        '',
        '    const imageField = files.length > 1 ? "image[]" : "image";',
        '    files.forEach((file) => formData.append(imageField, file));',
        '',
      ].join('\n')
      const effectiveReplacement = content.includes('\r\n') ? replacement.replaceAll('\n', '\r\n') : replacement
      content = content.replace(effectiveMarker, effectiveReplacement)
      changed = true
    }
  }

  if (changed) await writeFile(file, content, 'utf8')
  return changed
}

export async function patchCanvasImageWorkbench(file) {
  let content
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }

  let changed = false
  if (!content.includes('isImageFile } from "@/services/image-storage"')) {
    const importPattern = /(uploadImage)(\s*}\s*from\s+"@\/services\/image-storage";)/
    if (!importPattern.test(content)) throw new Error(`Infinite Canvas image workbench import marker not found in ${file}`)
    content = content.replace(importPattern, '$1, isImageFile$2')
    changed = true
  }

  const imageFilterMarker = 'const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));'
  if (content.includes(imageFilterMarker)) {
    content = replaceText(content, imageFilterMarker, 'const imageFiles = Array.from(files || []).filter((file) => isImageFile(file));', file)
    changed = true
  }

  const videoUnsupportedMarker = 'const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/"));'
  if (content.includes(videoUnsupportedMarker)) {
    content = replaceText(content, videoUnsupportedMarker, 'const unsupported = selectedFiles.filter((file) => !isImageFile(file));', file)
    changed = true
  }
  const videoFilterMarker = 'const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/")).slice(0, 7 - references.length);'
  if (content.includes(videoFilterMarker)) {
    content = replaceText(content, videoFilterMarker, 'const imageFiles = selectedFiles.filter((file) => isImageFile(file)).slice(0, 7 - references.length);', file)
    changed = true
  }

  if (!content.includes('message.error(t("common.imageReadFailed"));')) {
    const opening = '    const addReferences = async (files?: FileList | null) => {\n'
    const effectiveOpening = withLineEndings(content, opening)
    const openingIndex = content.indexOf(effectiveOpening)
    if (openingIndex < 0) throw new Error(`Infinite Canvas image workbench opening marker not found in ${file}`)
    const isVideoWorkbench = file.replaceAll('\\', '/').endsWith('/video/index.tsx') || content.includes('const selectedFiles = Array.from(files || []);')
    const nextFunction = isVideoWorkbench
      ? '    const handleReferenceDragEnter = '
      : '    const addReferencesFromClipboard = '
    const nextFunctionIndex = content.indexOf(nextFunction, openingIndex + effectiveOpening.length)
    if (nextFunctionIndex < 0) throw new Error(`Infinite Canvas image workbench next function marker not found in ${file}`)
    if (!content.slice(openingIndex, nextFunctionIndex).includes('        try {\n')) {
      content = replaceText(content, opening, `${opening}        try {\n`, file)
      changed = true
    }

    const closingMarker = `    };\n\n${nextFunction}`
    if (!content.includes(withLineEndings(content, closingMarker))) throw new Error(`Infinite Canvas image workbench closing marker not found in ${file}`)
    const closingReplacement = [
      '        } catch {',
      '            message.error(t("common.imageReadFailed"));',
      '        }',
      '    };',
      '',
      nextFunction,
    ].join('\n')
    content = replaceText(content, closingMarker, closingReplacement, file)
    changed = true
  }

  if (changed) await writeFile(file, content, 'utf8')
  return changed
}

function findJsxOpeningTagEnd(content, start) {
  let quote = null
  let escaped = false
  let braceDepth = 0

  for (let index = start; index < content.length; index += 1) {
    const character = content[index]

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character
    } else if (character === '{') {
      braceDepth += 1
    } else if (character === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    } else if (character === '>' && braceDepth === 0) {
      return index
    }
  }

  return -1
}

async function insertImageWorkspaceButton(file) {
  let content = await readFile(file, 'utf8')
  if (/navigate\s*\(\s*["']\/image["']\s*\)/.test(content)) return false

  const routePattern = /navigate\s*\(\s*["']\/canvas["']\s*\)/g
  const candidates = new Map()

  for (const routeMatch of content.matchAll(routePattern)) {
    const buttonStart = content.lastIndexOf('<Button', routeMatch.index)
    if (buttonStart < 0) continue

    const openingEnd = findJsxOpeningTagEnd(content, buttonStart)
    if (openingEnd < routeMatch.index) continue

    const previousClosing = content.lastIndexOf('</Button>', routeMatch.index)
    if (previousClosing > buttonStart) continue

    const closingStart = content.indexOf('</Button>', openingEnd + 1)
    if (closingStart < 0) continue

    candidates.set(buttonStart, { buttonStart, closingStart })
  }

  if (candidates.size !== 1) {
    throw new Error(`Infinite Canvas adapter expected one /canvas Button in ${file}, found ${candidates.size}`)
  }

  const [{ buttonStart, closingStart }] = candidates.values()
  const lineStart = content.lastIndexOf('\n', buttonStart - 1) + 1
  const indentation = content.slice(lineStart, buttonStart)
  if (!/^[\t ]*$/.test(indentation)) {
    throw new Error(`Infinite Canvas adapter could not determine Button indentation in ${file}`)
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const insertion = [
    `${indentation}<Button type="primary" size="large" onClick={() => navigate("/image")}>`,
    `${indentation}    \u8fdb\u5165\u751f\u56fe\u5de5\u4f5c\u53f0`,
    `${indentation}</Button>`,
  ].join(newline)
  const closingEnd = closingStart + '</Button>'.length

  content = `${content.slice(0, closingEnd)}${newline}${insertion}${content.slice(closingEnd)}`
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
  const imagePagePath = path.join(resolvedRoot, 'web/src/pages/image/index.tsx')
  const videoPagePath = path.join(resolvedRoot, 'web/src/pages/video/index.tsx')
  const historyTestPath = path.join(resolvedRoot, 'canvas-agent/src/agent/codex-history.test.ts')

  await copyTemplate(resolvedRoot, 'web/src/lib/sub2-bridge.ts')
  await patchCanvasGenerationHelpers(path.join(resolvedRoot, 'web/src/lib/canvas/canvas-generation-helpers.ts'))
  await patchCanvasImageStorage(path.join(resolvedRoot, 'web/src/services/image-storage.ts'))
  await patchCanvasImageApi(path.join(resolvedRoot, 'web/src/services/api/image.ts'))
  await patchCanvasImageWorkbench(imagePagePath)
  await patchCanvasImageWorkbench(videoPagePath)

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

  await insertImageWorkspaceButton(homePath)

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
