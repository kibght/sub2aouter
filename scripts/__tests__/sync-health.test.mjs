import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateSyncHealth,
  fetchWorkflowSnapshot,
  fetchReleaseSnapshot,
  fetchRepositoryContent,
} from '../lib/sync-health.mjs'

const NOW = new Date('2026-08-17T12:00:00Z')

function workflow(overrides = {}) {
  return {
    id: 'workflow.yml',
    name: 'Workflow',
    latestSuccessAt: '2026-08-17T11:30:00Z',
    latestRun: {
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-08-17T11:29:00Z',
      updatedAt: '2026-08-17T11:30:00Z',
      url: 'https://example.test/run/1',
    },
    ...overrides,
  }
}

test('fresh successful workflow runs are healthy', () => {
  const result = evaluateSyncHealth({
    now: NOW,
    staleAfterMinutes: 120,
    stuckAfterMinutes: 90,
    workflows: [workflow(), workflow({ id: 'publisher.yml', name: 'Publisher' })],
  })

  assert.equal(result.state, 'healthy')
  assert.equal(result.healthy, true)
  assert.equal(result.shouldDispatch, false)
  assert.equal(result.shouldAlert, false)
  assert.deepEqual(result.reasons, [])
})

test('a recent active workflow is running and suppresses recovery dispatch', () => {
  const result = evaluateSyncHealth({
    now: NOW,
    staleAfterMinutes: 120,
    stuckAfterMinutes: 90,
    workflows: [workflow({
      latestRun: {
        status: 'in_progress',
        conclusion: null,
        createdAt: '2026-08-17T11:40:00Z',
        updatedAt: '2026-08-17T11:55:00Z',
        url: 'https://example.test/run/2',
      },
    })],
  })

  assert.equal(result.state, 'running')
  assert.equal(result.healthy, true)
  assert.equal(result.shouldDispatch, false)
  assert.equal(result.shouldAlert, false)
})

test('a stuck active workflow is critical and is not duplicated', () => {
  const result = evaluateSyncHealth({
    now: NOW,
    staleAfterMinutes: 120,
    stuckAfterMinutes: 90,
    workflows: [workflow({
      latestRun: {
        status: 'in_progress',
        conclusion: null,
        createdAt: '2026-08-17T09:00:00Z',
        updatedAt: '2026-08-17T09:30:00Z',
        url: 'https://example.test/run/3',
      },
    })],
  })

  assert.equal(result.state, 'critical')
  assert.equal(result.healthy, false)
  assert.equal(result.shouldDispatch, false)
  assert.equal(result.shouldAlert, true)
  assert.match(result.summary, /stuck/i)
})

test('a stale last success is recoverable when no workflow is active', () => {
  const result = evaluateSyncHealth({
    now: NOW,
    staleAfterMinutes: 120,
    stuckAfterMinutes: 90,
    workflows: [workflow({ latestSuccessAt: '2026-08-17T08:00:00Z' })],
  })

  assert.equal(result.state, 'recoverable')
  assert.equal(result.shouldDispatch, true)
  assert.equal(result.shouldAlert, true)
  assert.match(result.summary, /stale/i)
})

test('a latest failed run is recoverable even when the previous success is fresh', () => {
  const result = evaluateSyncHealth({
    now: NOW,
    staleAfterMinutes: 120,
    stuckAfterMinutes: 90,
    workflows: [workflow({
      latestRun: {
        status: 'completed',
        conclusion: 'failure',
        createdAt: '2026-08-17T11:45:00Z',
        updatedAt: '2026-08-17T11:46:00Z',
        url: 'https://example.test/run/4',
      },
    })],
  })

  assert.equal(result.state, 'recoverable')
  assert.equal(result.shouldDispatch, true)
  assert.match(result.summary, /failure/i)
})

test('missing run history and invalid timestamps fail closed', () => {
  const missing = evaluateSyncHealth({
    now: NOW,
    staleAfterMinutes: 120,
    stuckAfterMinutes: 90,
    workflows: [{ id: 'workflow.yml', name: 'Workflow', latestSuccessAt: '', latestRun: null }],
  })
  assert.equal(missing.state, 'critical')
  assert.equal(missing.shouldDispatch, false)

  const invalid = evaluateSyncHealth({
    now: NOW,
    staleAfterMinutes: 120,
    stuckAfterMinutes: 90,
    workflows: [workflow({ latestSuccessAt: 'not-a-date' })],
  })
  assert.equal(invalid.state, 'critical')
  assert.match(invalid.summary, /invalid/i)
})

test('one active workflow suppresses dispatch for stale peer workflows', () => {
  const result = evaluateSyncHealth({
    now: NOW,
    staleAfterMinutes: 120,
    stuckAfterMinutes: 90,
    workflows: [
      workflow({ id: 'coordinator.yml', latestSuccessAt: '2026-08-17T08:00:00Z' }),
      workflow({
        id: 'publisher.yml',
        latestRun: {
          status: 'queued',
          conclusion: null,
          createdAt: '2026-08-17T11:50:00Z',
          updatedAt: '2026-08-17T11:50:00Z',
          url: 'https://example.test/run/5',
        },
      }),
    ],
  })

  assert.equal(result.state, 'running')
  assert.equal(result.shouldDispatch, false)
})

test('workflow API snapshots sort runs and retain the latest success', async () => {
  const result = await fetchWorkflowSnapshot({
    repository: 'owner/repo',
    workflowId: 'sync.yml',
    token: 'secret',
    fetchImpl: async () => new Response(JSON.stringify({
      workflow_runs: [
        {
          status: 'completed',
          conclusion: 'failure',
          created_at: '2026-08-17T11:00:00Z',
          updated_at: '2026-08-17T11:01:00Z',
          html_url: 'https://example.test/run/7',
        },
        {
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-08-17T10:00:00Z',
          updated_at: '2026-08-17T10:02:00Z',
          html_url: 'https://example.test/run/6',
        },
      ],
    }), { status: 200 }),
    sleep: async () => {},
    random: () => 0,
  })

  assert.equal(result.id, 'sync.yml')
  assert.equal(result.latestRun.conclusion, 'failure')
  assert.equal(result.latestSuccessAt, '2026-08-17T10:02:00Z')
})

test('workflow API snapshots retry transient failures and reject malformed payloads', async () => {
  let calls = 0
  const result = await fetchWorkflowSnapshot({
    repository: 'owner/repo',
    workflowId: 'sync.yml',
    attempts: 2,
    baseDelayMs: 1,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        return new Response('temporary', { status: 502 })
      }
      return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 })
    },
    sleep: async () => {},
    random: () => 0,
  })
  assert.equal(calls, 2)
  assert.equal(result.latestRun, null)

  await assert.rejects(
    fetchWorkflowSnapshot({
      repository: 'owner/repo',
      workflowId: 'sync.yml',
      fetchImpl: async () => new Response(JSON.stringify({ wrong: [] }), { status: 200 }),
      sleep: async () => {},
    }),
    /workflow_runs/i,
  )
})

function release(overrides = {}) {
  return {
    version: '0.1.242',
    tag: 'v0.1.242',
    exists: true,
    draft: false,
    prerelease: false,
    target: 'themed-release',
    assets: [
      'sub2api_0.1.242_linux_amd64.tar.gz',
      'sub2api_0.1.242_linux_arm64.tar.gz',
      'sub2api_0.1.242_windows_amd64.zip',
      'sub2api_0.1.242_darwin_amd64.tar.gz',
      'sub2api_0.1.242_darwin_arm64.tar.gz',
      'checksums.txt',
    ],
    repositorySha: 'main-sha',
    expectedMainSha: 'main-sha',
    ...overrides,
  }
}

test('missing or incomplete generated releases are recoverable', () => {
  for (const snapshot of [
    release({ exists: false, assets: [] }),
    release({ assets: ['checksums.txt'] }),
    release({ draft: true }),
    release({ prerelease: true }),
    release({ target: 'main' }),
  ]) {
    const result = evaluateSyncHealth({
      now: NOW,
      staleAfterMinutes: 120,
      stuckAfterMinutes: 90,
      workflows: [workflow()],
      release: snapshot,
    })
    assert.equal(result.state, 'recoverable')
    assert.equal(result.shouldDispatch, true)
    assert.equal(result.shouldAlert, true)
    assert.match(result.summary, /release/i)
  }
})

test('generated repository metadata drift is recoverable', () => {
  const result = evaluateSyncHealth({
    now: NOW,
    staleAfterMinutes: 120,
    stuckAfterMinutes: 90,
    workflows: [workflow()],
    release: release({ repositorySha: 'stale-sha' }),
  })
  assert.equal(result.state, 'recoverable')
  assert.equal(result.shouldDispatch, true)
  assert.match(result.summary, /repository metadata/i)
})

test('an active synchronization run suppresses duplicate release repair dispatch', () => {
  const result = evaluateSyncHealth({
    now: NOW,
    staleAfterMinutes: 120,
    stuckAfterMinutes: 90,
    workflows: [workflow({ latestRun: { status: 'in_progress', conclusion: null, createdAt: '2026-08-17T11:50:00Z', updatedAt: '2026-08-17T11:55:00Z', url: '' } })],
    release: release({ exists: false, assets: [] }),
  })
  assert.equal(result.state, 'running')
  assert.equal(result.shouldDispatch, false)
})

test('release API snapshots treat 404 as a missing repairable release', async () => {
  const missing = await fetchReleaseSnapshot({
    repository: 'owner/repo',
    tag: 'v0.1.242',
    fetchImpl: async () => new Response('not found', { status: 404 }),
    sleep: async () => {},
  })
  assert.deepEqual(missing, { tag: 'v0.1.242', exists: false, draft: false, prerelease: false, target: '', assets: [] })

  const found = await fetchReleaseSnapshot({
    repository: 'owner/repo',
    tag: 'v0.1.242',
    fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'v0.1.242', draft: false, prerelease: false, target_commitish: 'themed-release', assets: [{ name: 'checksums.txt' }] }), { status: 200 }),
    sleep: async () => {},
  })
  assert.equal(found.exists, true)
  assert.deepEqual(found.assets, ['checksums.txt'])
})

test('repository content API decodes base64 metadata', async () => {
  const content = await fetchRepositoryContent({
    repository: 'owner/repo',
    path: 'backend/cmd/server/VERSION',
    ref: 'themed-release',
    fetchImpl: async () => new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('0.1.242\n').toString('base64') }), { status: 200 }),
    sleep: async () => {},
  })
  assert.equal(content, '0.1.242\n')
})
