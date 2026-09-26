import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  patchCanvasGenerationHelpers,
  patchCanvasImageApi,
  patchCanvasImageStorage,
  patchCanvasImageWorkbench,
  patchCanvasModalStyles,
} from "../apply-infinite-canvas-patches.mjs"

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
    'import localforage from "localforage";',
    "",
    'const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });',
    'const objectUrls = new Map<string, string>();',
    "",
    'type ImageReadOptions = { signal?: AbortSignal };',
    "",
    'export async function uploadImage(input: string | Blob, options?: ImageReadOptions) {',
    '    if (typeof input !== "string") return storeImage(input, options);',
    '    const blob = await fetchImageBlob(input, options);',
    '    return storeImage(blob, options);',
    '}',
    "",
    'async function storeImage(blob: Blob, options?: ImageReadOptions) {',
    '    const storageKey = "image:test";',
    '    const url = URL.createObjectURL(blob);',
    '    try {',
    '        await store.setItem(storageKey, blob);',
    '        objectUrls.set(storageKey, url);',
    '        return { url, storageKey, width: 1, height: 1, bytes: blob.size, mimeType: blob.type };',
    '    } catch (error) {',
    '        URL.revokeObjectURL(url);',
    '        await store.removeItem(storageKey).catch(() => undefined);',
    '        throw error;',
    '    }',
    '}',
    "",
    'async function fetchImageBlob(url: string, options?: ImageReadOptions) { return new Blob(); }',
    'async function resolveImageUrl(storageKey?: string, fallback = "") {',
    '    const blob = await store.getItem<Blob>(storageKey);',
    '    return blob ? URL.createObjectURL(blob) : fallback;',
    '}',
    "",
    'export async function getImageBlob(storageKey: string) {',
    '    return store.getItem<Blob>(storageKey);',
    '}',
    'export function previewUrlFor(storageKey?: string) { return storageKey; }',
    'export async function deleteStoredImages(keys: Iterable<string>) {',
    '    await Promise.all(Array.from(keys).map(async (key) => {',
    '            await store.removeItem(key);',
    '    }));',
    '}',
    'export async function setImageBlob(storageKey: string, blob: Blob) {',
    '    await store.setItem(storageKey, blob);',
    '    return URL.createObjectURL(blob);',
    '}',
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
    assert.match(patchedStorage, /const memoryBlobs = new Map<string, Blob>\(\);/)
    assert.match(patchedStorage, /export function isImageFile\(file: Blob & \{ name\?: string \}\)/)
    assert.match(patchedStorage, /memoryBlobs\.set\(storageKey, blob\)/)

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

test("patches image workbench uploads for empty MIME types and visible failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infinite-canvas-workbench-patch-"))
  const imageFile = path.join(root, "image.tsx")
  const videoFile = path.join(root, "video.tsx")
  const source = (video) => [
    'import { uploadImage } from "@/services/image-storage";',
    "",
    '    const addReferences = async (files?: FileList | null) => {',
    ...(video ? [
      '        const selectedFiles = Array.from(files || []);',
      '        const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/"));',
      '        const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/")).slice(0, 7 - references.length);',
    ] : [
      '        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));',
    ]),
    '        const nextReferences = await Promise.all(imageFiles.map(async (file) => uploadImage(file)));',
    '        setReferences((value) => [...value, ...nextReferences]);',
    '    };',
    "",
    ...(video ? ['    const handleReferenceDragEnter = () => {};'] : ['    const addReferencesFromClipboard = async () => {};']),
    "",
  ].join("\n")

  try {
    await writeFile(imageFile, source(false), "utf8")
    await writeFile(videoFile, source(true), "utf8")
    assert.equal(await patchCanvasImageWorkbench(imageFile), true)
    assert.equal(await patchCanvasImageWorkbench(videoFile), true)
    const patchedImage = await readFile(imageFile, "utf8")
    const patchedVideo = await readFile(videoFile, "utf8")
    for (const patched of [patchedImage, patchedVideo]) {
      assert.match(patched, /isImageFile/)
      assert.match(patched, /message\.error\(t\("common\.imageReadFailed"\)\)/)
    }
    assert.match(patchedImage, /filter\(\(file\) => isImageFile\(file\)\)/)
    assert.match(patchedVideo, /filter\(\(file\) => !isImageFile\(file\)/)
    assert.equal(await patchCanvasImageWorkbench(imageFile), false)
    assert.equal(await patchCanvasImageWorkbench(videoFile), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("patches the Ant Design 6 Modal semantic style key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infinite-canvas-modal-patch-"))
  const file = path.join(root, "model-script-editor.tsx")
  const source = '            styles={{\n                content: { height: "100dvh", maxHeight: "100dvh", margin: 0, padding: 0, borderRadius: 0, overflow: "hidden" },\n            }}\n'
  try {
    await writeFile(file, source, "utf8")
    assert.equal(await patchCanvasModalStyles(file), true)
    assert.match(await readFile(file, "utf8"), /container: \{ height: "100dvh"/)
    assert.equal(await patchCanvasModalStyles(file), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
