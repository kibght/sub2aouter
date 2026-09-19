import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { patchCanvasGenerationHelpers } from "../apply-infinite-canvas-patches.mjs"

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
