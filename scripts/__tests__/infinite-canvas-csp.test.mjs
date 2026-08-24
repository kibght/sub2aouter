import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { patchCanvasDefaultCSP } from "../apply-sub2-infinite-canvas-integration.mjs"

const vulnerableConfig = `package config

const DefaultCSPPolicy = "default-src 'self'; connect-src 'self' https://turing.captcha.qcloud.com https:; frame-src https://challenges.cloudflare.com https://turing.captcha.qcloud.com; frame-ancestors 'none'"
`

const existingCanvasAgentConfig = `package config

const DefaultCSPPolicy = "default-src 'self'; connect-src 'self' https: http://127.0.0.1:17371; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'"
`

test("keeps the default CSP aligned with Canvas-required directives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sub2-canvas-csp-"))
  const file = path.join(root, "config.go")

  try {
    await writeFile(file, vulnerableConfig, "utf8")
    assert.equal(await patchCanvasDefaultCSP(file), true)
    const patched = await readFile(file, "utf8")
    assert.match(patched, /connect-src 'self' http:\/\/127\.0\.0\.1:17371/)
    assert.match(patched, /frame-src 'self' https:\/\/challenges\.cloudflare\.com/)
    assert.equal(await patchCanvasDefaultCSP(file), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("check mode rejects an unpatched default CSP", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sub2-canvas-csp-check-"))
  const file = path.join(root, "config.go")

  try {
    await writeFile(file, vulnerableConfig, "utf8")
    await assert.rejects(() => patchCanvasDefaultCSP(file, true), /default CSP drift/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("does not duplicate an existing Canvas Agent source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sub2-canvas-csp-existing-"))
  const file = path.join(root, "config.go")

  try {
    await writeFile(file, existingCanvasAgentConfig, "utf8")
    assert.equal(await patchCanvasDefaultCSP(file), true)
    const patched = await readFile(file, "utf8")
    assert.equal((patched.match(/http:\/\/127\.0\.0\.1:17371/g) || []).length, 1)
    assert.match(patched, /frame-src 'self' https:\/\/challenges\.cloudflare\.com/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
