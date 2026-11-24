import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

for (const lineEnding of ['\n', '\r\n']) {
  test(`Ultra Fast compatibility works without the Codex test and preserves ${JSON.stringify(lineEnding)} source`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-ultrafast-tests-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const target = path.join(root, 'frontend/src/views/admin/__tests__/groupsOpenAIFast.spec.ts')
    await mkdir(path.dirname(target), { recursive: true })
    const marker = 'ultrafastHint: expect.stringContaining("service_tier=ultrafast")'
    const replacement = 'ultrafastHint: expect.stringMatching(/service_tier=ultrafast|Ultra Fast/)'
    const modelChecks = [
      'expect(locale.groups.openaiFast.ultrafastHint).toContain("GPT-6 Astra");',
      'expect(locale.groups.openaiFast.ultrafastHint).toContain("GPT-6.1 Sol");',
    ]
    const original = [
      'forceUltrafast: expect.stringContaining("ultrafast"),',
      `${marker},`,
      ...modelChecks,
      '',
    ].join(lineEnding)
    await writeFile(target, original)

    assert.equal(await applyUpstreamTestCompatibility({ root }), true)
    const patched = await readFile(target, 'utf8')
    assert.equal(patched, original.replace(marker, replacement))
    assert.equal(await applyUpstreamTestCompatibility({ root }), false)
    assert.equal(await readFile(target, 'utf8'), patched)
    for (const modelCheck of modelChecks) assert.ok(patched.includes(modelCheck))
    const expression = patched.match(/ultrafastHint: expect\.stringMatching\(\/([^\n]*)\/\)/)
    assert.ok(expression)
    const matcher = new RegExp(expression[1])
    // Exact upstream v0.2.22 and v0.2.23 locale text, copied without rewriting.
    const hints = [
      '开启后，仅对支持 Ultra Fast 的模型（GPT-6 Astra、GPT-6.1 Sol）强制写入 service_tier=ultrafast，优先于"强制使用 Fast"；其他模型在同时开启"强制使用 Fast"时写入 priority，否则跟随客户端。Ultra Fast 按标准价 6 倍计费，不受"免费 Fast"影响，且需要上游账号具备 Ultra Fast 权限。',
      'Forces service_tier=ultrafast only on models that support Ultra Fast (GPT-6 Astra, GPT-6.1 Sol), taking precedence over "Force Fast". Other models get priority when "Force Fast" is also on, otherwise they follow the client. Ultra Fast is billed at 6x the Standard price, is not covered by "Free Fast", and requires upstream accounts with Ultra Fast access.',
      '对支持的模型强制使用 Ultra Fast。GPT-6.2 订阅档位按套餐补全：Pro 200 支持 Sol，Pro 500 支持 Sol 和 Astra；其他账号使用其目录明确提供的档位。不可用时，若同时开启强制 Fast 则使用 Fast，否则跟随客户端。6.2 Sol 和 Astra 在太平洋时间 2027 年 2 月 28 日及之前按标准价 3 倍计费，之后为 6 倍。GPT-6 Astra 和 GPT-6.1 Sol 为 6 倍。免费 Fast 不包含 Ultra Fast。',
      'Forces Ultra Fast on supported models. Pro 200 includes GPT-6.2 Sol Ultrafast. Pro 500 includes both Sol and Astra Ultrafast. Other subscriptions use the tiers advertised by their account. If unavailable, Force Fast takes precedence over the client tier. GPT-6.2 Sol and Astra cost 3× Standard through February 28, 2027 (Pacific time), then 6×. GPT-6 Astra and GPT-6.1 Sol cost 6×. Free Fast excludes Ultra Fast.',
    ]
    for (const hint of [...hints, 'service_tier=ultrafast']) assert.equal(matcher.test(hint), true)
    for (const hint of ['', 'service_tier=priority', 'GPT-6 Astra and GPT-6.1 Sol use Fast.']) {
      assert.equal(matcher.test(hint), false)
    }
  })
}

for (const lineEnding of ['\n', '\r\n']) {
  test(`account homepage alignment accepts the centered action row and preserves ${JSON.stringify(lineEnding)} source`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sub2api-account-layout-tests-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const target = path.join(root, 'frontend/src/views/admin/__tests__/AccountsView.sparkShadow.spec.ts')
    await mkdir(path.dirname(target), { recursive: true })
    const marker = "expect(tooltip.classes()).toEqual(expect.arrayContaining(['self-start']))"
    const securityChecks = [
      "expect(links).toHaveLength(1)",
      "expect(link.attributes()).toMatchObject({ href: 'https://relay.example.com', target: '_blank', rel: 'noopener noreferrer' })",
      "expect(wrapper.text()).toContain('invalid-url')",
    ]
    const original = [...securityChecks, marker, ''].join(lineEnding)
    await writeFile(target, original)

    assert.equal(await applyUpstreamTestCompatibility({ root }), true)
    const patched = await readFile(target, 'utf8')
    for (const check of securityChecks) assert.ok(patched.includes(check))
    assert.equal(patched.split(lineEnding).length, original.split(lineEnding).length)
    assert.equal(await applyUpstreamTestCompatibility({ root }), false)
    assert.equal(await readFile(target, 'utf8'), patched)

    const expression = patched.match(/expect\((tooltip\.classes\(\).*?)\)\.toBe\(true\)/)
    assert.ok(expression)
    const isAligned = new Function('tooltip', `return ${expression[1]}`)
    const tooltip = (classes, parentClasses) => ({
      classes: () => classes,
      element: { parentElement: parentClasses && { matches: (selector) => selector.split('.').filter(Boolean).every((value) => parentClasses.includes(value)) } },
    })
    assert.equal(isAligned(tooltip(['self-start'], ['flex', 'flex-col'])), true)
    assert.equal(isAligned(tooltip(['-ml-1'], ['flex', 'items-center', 'gap-1'])), true)
    assert.equal(isAligned(tooltip(['-ml-1'], ['flex', 'flex-col'])), false)
    assert.equal(isAligned(tooltip(['-ml-1'], ['items-center'])), false)
    assert.ok(!isAligned(tooltip([], null)))
  })
}

test('compatibility reconciliation runs before frontend regression tests', async () => {
  const workflow = await readFile('.github/workflows/upstream-theme-sync.yml', 'utf8')
  const compatibility = workflow.indexOf('node scripts/apply-upstream-test-compatibility.mjs --root .')
  assert.ok(compatibility > workflow.indexOf('name: Apply theme overlay'))
  assert.ok(compatibility < workflow.indexOf('name: Frontend regression tests'))
})
