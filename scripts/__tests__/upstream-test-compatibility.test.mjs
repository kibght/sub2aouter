import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { applyUpstreamTestCompatibility } from '../apply-upstream-test-compatibility.mjs'

test('Codex feature assertions accept model discovery while retaining required flags', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-codex-tests-'))
  const target = path.join(root, 'frontend/src/components/keys/__tests__/UseKeyModal.spec.ts')
  await mkdir(path.dirname(target), { recursive: true })
  const original = [
    String.raw`expect(configToml).toContain('[features]\ngoals = true')`,
    String.raw`expect(configToml).toContain('[features]\nresponses_websockets_v2 = true\ngoals = true')`,
    String.raw`expect(configToml).toContain('[features]\nresponses_websockets_v2 = true\ngoals = true')`,
    "expect(configToml).toContain('requires_openai_auth = false')",
  ].join('\r\n')
  await writeFile(target, original)
  assert.equal(await applyUpstreamTestCompatibility({ root }), true)
  assert.equal(await applyUpstreamTestCompatibility({ root }), false)
  const patched = await readFile(target, 'utf8')
  assert.equal((patched.match(/toMatch/g) ?? []).length, 3)
  assert.ok(patched.includes("expect(configToml).toContain('requires_openai_auth = false')"))
  assert.equal(patched.split('\r\n').length, 4)
  const expressions = [...patched.matchAll(/toMatch\((\/.*\/)\)/g)]
    .map((match) => new Function(`return ${match[1]}`)())
  for (const discovery of ['', 'api_key_model_discovery = true\n']) {
    assert.ok(expressions[0].test(`[features]\n${discovery}goals = true`))
    for (const expression of expressions.slice(1)) {
      assert.ok(expression.test(`[features]\n${discovery}responses_websockets_v2 = true\ngoals = true`))
      assert.equal(expression.test(`[features]\n${discovery}goals = true`), false)
      assert.equal(expression.test(`[features]\n${discovery}responses_websockets_v2 = false\ngoals = true`), false)
    }
    assert.equal(expressions[0].test(`[features]\n${discovery}goals = false`), false)
  }
})

test('compatibility reconciliation runs before frontend regression tests', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const compatibility = workflow.indexOf('node scripts/apply-upstream-test-compatibility.mjs --root .')
  assert.ok(compatibility > workflow.indexOf('name: Apply theme overlay'))
  assert.ok(compatibility < workflow.indexOf('name: Frontend regression tests'))
})
