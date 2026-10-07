import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { patchCanvasGenerationHelpers, patchCanvasImageApi, patchCanvasImageStorage, patchCanvasReferenceImageRead } from "../apply-infinite-canvas-patches.mjs"

test("patches optional Canvas node metadata before upstream typecheck", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infinite-canvas-patch-"))
  const file = path.join(root, "canvas-generation-helpers.ts")
  const source = [
    "export async function hydrateCanvasImages(nodes: CanvasNodeData[]) {",
    "    return Promise.all(",
    "        nodes.map(async (node) => {",
    "            const content = node.metadata?.content;",
    "            const images = await Promise.all((node.metadata.images || []).map(async (image) => image));",
    "            return { ...node, metadata: { ...node.metadata, content, images } };",
    "        }),",
    "    );",
    "}",
    "",
  ].join("\n")

  try {
    await writeFile(file, source, "utf8")

    assert.equal(await patchCanvasGenerationHelpers(file), true)
    assert.match(await readFile(file, "utf8"), /node\.metadata\?\.images/)
    assert.equal(await patchCanvasGenerationHelpers(file), false)
    assert.equal(await patchCanvasGenerationHelpers(path.join(root, "missing.ts")), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("patches image edits for GPT Image and restores references from local storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infinite-canvas-image-patch-"))
  const storageFile = path.join(root, "image-storage.ts")
  const apiFile = path.join(root, "image.ts")
  const newline = "\r\n"
  const storageSource = [
    'import i18n from "@/i18n";',
    "",
    "export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {",
    '    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));',
    '    if (!url || url.startsWith("data:")) return url;',
    '    return blobToDataUrl(await (await fetch(url)).blob());',
    "}",
    "",
  ].join(newline)
  const apiSource = [
    'const body = {',
    '                response_format: "b64_json",',
    "};",
    '    formData.set("response_format", "b64_json");',
    '    files.forEach((file) => formData.append("image", file));',
    "",
  ].join(newline)

  try {
    await writeFile(storageFile, storageSource, "utf8")
    await writeFile(apiFile, apiSource, "utf8")

    assert.equal(await patchCanvasImageStorage(storageFile), true)
    assert.equal(await patchCanvasImageApi(apiFile), true)

    const patchedStorage = await readFile(storageFile, "utf8")
    assert.match(patchedStorage, /const storedUrl = image\.storageKey \? await resolveImageUrl\(image\.storageKey, ""\) : "";/)
    assert.match(patchedStorage, /const url = storedUrl \|\| image\.dataUrl \|\| image\.url \|\| "";/)
    assert.match(patchedStorage, /apiErrors\.referenceImageReadFailed/)
    assert.match(patchedStorage, /await \(await fetch\(url\)\)\.blob\(\)/)

    const patchedApi = await readFile(apiFile, "utf8")
    assert.match(patchedApi, /\.\.\.\(\/gpt-image\/\.test\(requestConfig\.model\)/)
    assert.match(patchedApi, /if \(!\/gpt-image\/\.test\(requestConfig\.model\)\)/)
    assert.match(patchedApi, /const imageField = files\.length > 1 \? "image\[\]" : "image";/)
    assert.match(patchedApi, /formData\.append\(imageField, file\)/)

    assert.equal(await patchCanvasImageStorage(storageFile), false)
    assert.equal(await patchCanvasImageApi(apiFile), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reads original image bytes before resolving a blob URL and survives reapplication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-reference-read-"))
  const file = path.join(root, "image-storage.ts")
  try {
    for (const newline of ["\n", "\r\n"]) {
      const source = [
        'export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }, options?: ImageReadOptions) {',
        '    const url = await resolveImageUrl(image.storageKey, image.url || "");',
        '    return blobToDataUrl(await fetchImageBlob(url, options));',
        '}',
      ].join(newline)
      await writeFile(file, source, "utf8")
      assert.equal(await patchCanvasReferenceImageRead(file), true)
      assert.equal(await patchCanvasReferenceImageRead(file), false)
      const patched = await readFile(file, "utf8")
      if (newline === "\r\n") assert.equal(patched.replaceAll("\r\n", "").includes("\n"), false)
      assert.ok(patched.indexOf("getImageBlob(image.storageKey)") < patched.indexOf("resolveImageUrl"))
      assert.match(patched, /if \(originalBlob\) return blobToDataUrl\(originalBlob\)/)
    }
    await writeFile(file, "export function incompatibleUpstream() {}", "utf8")
    await assert.rejects(() => patchCanvasReferenceImageRead(file), /marker not found/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
