import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchLatestRelease } from '../lib/github-release.mjs'

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function textResponse(body, status, headers = {}) {
  return new Response(body, { status, headers })
}

test('release discovery returns one immutable latest-release descriptor', async () => {
  const requests = []
  const result = await fetchLatestRelease({
    repository: 'owner/repo',
    token: 'secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return jsonResponse({
        tag_name: 'v1.2.3',
        id: 42,
        published_at: '2026-08-17T00:00:00Z',
      })
    },
    sleep: async () => {},
    random: () => 0,
  })

  assert.deepEqual(result, {
    found: true,
    tag: 'v1.2.3',
    id: '42',
    publishedAt: '2026-08-17T00:00:00Z',
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.github.com/repos/owner/repo/releases/latest')
  assert.equal(requests[0].options.headers.authorization, 'Bearer secret')
})

test('release discovery treats 404 as an explicit no-release result without retrying', async () => {
  let calls = 0
  const result = await fetchLatestRelease({
    repository: 'owner/repo',
    fetchImpl: async () => {
      calls += 1
      return textResponse('not found', 404)
    },
    sleep: async () => assert.fail('404 must not sleep'),
  })

  assert.deepEqual(result, { found: false, tag: '', id: '', publishedAt: '' })
  assert.equal(calls, 1)
})

for (const status of [401, 403]) {
  test(`release discovery fails closed on HTTP ${status} without retry indication`, async () => {
    let calls = 0
    await assert.rejects(
      fetchLatestRelease({
        repository: 'owner/repo',
        fetchImpl: async () => {
          calls += 1
          return textResponse('denied', status)
        },
        sleep: async () => assert.fail(`${status} must not sleep`),
      }),
      new RegExp(`HTTP ${status}`),
    )
    assert.equal(calls, 1)
  })
}

test('release discovery retries HTTP 429 with bounded exponential backoff', async () => {
  const sleeps = []
  let calls = 0
  const result = await fetchLatestRelease({
    repository: 'owner/repo',
    attempts: 4,
    baseDelayMs: 10,
    fetchImpl: async () => {
      calls += 1
      if (calls < 3) {
        return textResponse('rate limited', 429)
      }
      return jsonResponse({ tag_name: 'v2.0.0', id: 99, published_at: null })
    },
    sleep: async (delay) => sleeps.push(delay),
    random: () => 0,
  })

  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [10, 20])
  assert.deepEqual(result, { found: true, tag: 'v2.0.0', id: '99', publishedAt: '' })
})

test('release discovery retries server failures and honors Retry-After when larger', async () => {
  const sleeps = []
  let calls = 0
  const result = await fetchLatestRelease({
    repository: 'owner/repo',
    attempts: 3,
    baseDelayMs: 100,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        return textResponse('temporary', 503, { 'retry-after': '2' })
      }
      return jsonResponse({ tag_name: 'v3.0.0', id: '100' })
    },
    sleep: async (delay) => sleeps.push(delay),
    random: () => 0,
  })

  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [2000])
  assert.equal(result.tag, 'v3.0.0')
})

test('release discovery retries rate-limit 403 only when headers identify it as transient', async () => {
  let calls = 0
  const result = await fetchLatestRelease({
    repository: 'owner/repo',
    attempts: 2,
    baseDelayMs: 1,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        return textResponse('rate limited', 403, { 'x-ratelimit-remaining': '0' })
      }
      return jsonResponse({ tag_name: 'v4.0.0', id: 101 })
    },
    sleep: async () => {},
    random: () => 0,
  })

  assert.equal(calls, 2)
  assert.equal(result.tag, 'v4.0.0')
})

test('release discovery retries transport failures', async () => {
  let calls = 0
  const result = await fetchLatestRelease({
    repository: 'owner/repo',
    attempts: 2,
    baseDelayMs: 1,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        throw new TypeError('connection reset')
      }
      return jsonResponse({ tag_name: 'v5.0.0', id: 102 })
    },
    sleep: async () => {},
    random: () => 0,
  })

  assert.equal(calls, 2)
  assert.equal(result.tag, 'v5.0.0')
})

test('release discovery fails closed on malformed JSON and missing tags', async () => {
  await assert.rejects(
    fetchLatestRelease({
      repository: 'owner/repo',
      fetchImpl: async () => textResponse('{invalid', 200, { 'content-type': 'application/json' }),
      sleep: async () => {},
    }),
    /invalid JSON/i,
  )

  await assert.rejects(
    fetchLatestRelease({
      repository: 'owner/repo',
      fetchImpl: async () => jsonResponse({ id: 1 }),
      sleep: async () => {},
    }),
    /tag_name/i,
  )
})

test('release discovery reports retry exhaustion with the final status', async () => {
  let calls = 0
  await assert.rejects(
    fetchLatestRelease({
      repository: 'owner/repo',
      attempts: 3,
      baseDelayMs: 1,
      fetchImpl: async () => {
        calls += 1
        return textResponse('unavailable', 502)
      },
      sleep: async () => {},
      random: () => 0,
    }),
    /after 3 attempts.*HTTP 502/i,
  )
  assert.equal(calls, 3)
})

test('release discovery rejects invalid repository names before making a request', async () => {
  await assert.rejects(
    fetchLatestRelease({
      repository: '../bad',
      fetchImpl: async () => assert.fail('invalid input must not fetch'),
    }),
    /owner\/repo/i,
  )
})