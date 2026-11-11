import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateSyncHealth,
  fetchWorkflowSnapshot,
  fetchReleaseSnapshot,
  fetchRepositoryContent,
  waitForSyncRecovery,
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

test('repository-only metadata drift does not mint an automatic release', () => {
  const result = evaluateSyncHealth({
    now: NOW,
    staleAfterMinutes: 120,
    stuckAfterMinutes: 90,
    workflows: [workflow()],
    release: release({ repositorySha: 'stale-sha' }),
  })
  assert.equal(result.state, 'healthy')
  assert.equal(result.shouldDispatch, false)
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

test('publication is timed from the current stage, with an independent whole-run limit', () => {
  const publisher = workflow({
    maxRunMinutes: 330,
    latestRun: { status: 'in_progress', createdAt: '2026-08-17T09:00:00Z' },
    jobs: [
      { name: 'sync-build-publish', status: 'completed', completedAt: '2026-08-17T10:20:00Z' },
      { name: 'binary-release', status: 'in_progress', startedAt: '2026-08-17T10:30:00Z' },
    ],
  })
  assert.equal(evaluateSyncHealth({ now: NOW, workflows: [publisher] }).state, 'running')
  publisher.jobs[1].startedAt = '2026-08-17T10:29:00Z'
  assert.equal(evaluateSyncHealth({ now: NOW, workflows: [publisher] }).state, 'critical')
  publisher.jobs[1].startedAt = '2026-08-17T11:50:00Z'
  publisher.latestRun.createdAt = '2026-08-17T06:00:00Z'
  const overBudget = evaluateSyncHealth({ now: NOW, workflows: [publisher] })
  assert.equal(overBudget.state, 'critical')
  assert.equal(overBudget.workflows[0].reason, 'run-budget-exceeded')
})

test('waiting for the next stage uses the last completion and still detects a stuck queue', () => {
  const publisher = workflow({
    latestRun: { status: 'in_progress', createdAt: '2026-08-17T09:00:00Z' },
    jobs: [{ status: 'completed', completedAt: '2026-08-17T11:50:00Z' }, { status: 'queued' }],
  })
  assert.equal(evaluateSyncHealth({ now: NOW, workflows: [publisher] }).state, 'running')
  publisher.jobs[0].completedAt = '2026-08-17T10:00:00Z'
  assert.equal(evaluateSyncHealth({ now: NOW, workflows: [publisher] }).state, 'critical')
  publisher.jobs = [{ status: 'in_progress', startedAt: 'invalid' }]
  assert.equal(evaluateSyncHealth({ now: NOW, workflows: [publisher] }).state, 'critical')
})

test('an active coordinator does not hide a failed publisher while suppressing duplicate recovery', () => {
  const result = evaluateSyncHealth({
    now: NOW,
    workflows: [
      workflow({ id: 'coordinator', latestRun: { status: 'in_progress', createdAt: '2026-08-17T11:55:00Z' } }),
      workflow({ id: 'publisher', latestRun: { status: 'completed', conclusion: 'failure', createdAt: '2026-08-17T11:50:00Z' } }),
    ],
  })
  assert.equal(result.state, 'running')
  assert.equal(result.shouldDispatch, false)
  assert.equal(result.shouldAlert, true)
  assert.match(result.summary, /failure/)
})

test('workflow snapshots fetch current job phases for an active run', async () => {
  const urls = []
  const result = await fetchWorkflowSnapshot({
    repository: 'owner/repo', workflowId: 'sync.yml',
    fetchImpl: async (url) => {
      urls.push(url)
      const payload = urls.length === 1
        ? { workflow_runs: [{ id: 42, status: 'in_progress', created_at: '2026-08-17T09:00:00Z' }] }
        : { jobs: [{ name: 'binary-release', status: 'in_progress', started_at: '2026-08-17T11:30:00Z' }] }
      return new Response(JSON.stringify(payload), { status: 200 })
    },
  })
  assert.match(urls[1], /actions\/runs\/42\/jobs\?/)
  assert.equal(evaluateSyncHealth({ now: NOW, workflows: [result] }).state, 'running')
})

test('a newer queued run cannot hide an older execution or its whole-run timeout', async () => {
  const urls = []
  const snapshot = await fetchWorkflowSnapshot({
    repository: 'owner/repo', workflowId: 'sync.yml',
    fetchImpl: async (url) => {
      urls.push(url)
      const payload = url.includes('/workflows/')
        ? { workflow_runs: [
          { id: 2, status: 'queued', created_at: '2026-08-17T11:55:00Z' },
          { id: 1, status: 'in_progress', created_at: '2026-08-17T05:00:00Z' },
        ] }
        : { jobs: url.includes('/runs/1/')
          ? [{ name: 'binary-release', status: 'in_progress', started_at: '2026-08-17T11:30:00Z' }]
          : [] }
      return new Response(JSON.stringify(payload), { status: 200 })
    },
  })
  assert.equal(snapshot.latestRun.databaseId, '2')
  assert.deepEqual(snapshot.activeRuns.map((run) => run.databaseId), ['2', '1'])
  assert.ok(urls.some((url) => url.includes('/runs/1/jobs?')))
  assert.ok(urls.some((url) => url.includes('/runs/2/jobs?')))
  const overBudget = evaluateSyncHealth({ now: NOW, workflows: [{ ...snapshot, maxRunMinutes: 330 }] })
  assert.equal(overBudget.state, 'critical')
  assert.equal(overBudget.shouldAlert, true)
  assert.equal(overBudget.shouldDispatch, false)
  assert.ok(overBudget.workflows.some((entry) => entry.reason === 'run-budget-exceeded'))

  snapshot.activeRuns[1].createdAt = '2026-08-17T09:00:00Z'
  const progressing = evaluateSyncHealth({ now: NOW, workflows: [{ ...snapshot, maxRunMinutes: 330 }] })
  assert.equal(progressing.state, 'running')
  assert.equal(progressing.shouldAlert, false)
  assert.equal(progressing.shouldDispatch, false)
  snapshot.activeRuns[1].jobs[0].startedAt = '2026-08-17T10:00:00Z'
  const stuckStage = evaluateSyncHealth({ now: NOW, workflows: [{ ...snapshot, maxRunMinutes: 330 }] })
  assert.equal(stuckStage.state, 'critical')
  assert.equal(stuckStage.shouldAlert, true)
  assert.equal(stuckStage.shouldDispatch, false)
  assert.ok(stuckStage.workflows.some((entry) => entry.reason === 'stuck-active-run'))
})

test('inspecting an older execution retains a newer failed run without dispatching duplicate work', async () => {
  const snapshot = await fetchWorkflowSnapshot({
    repository: 'owner/repo', workflowId: 'sync.yml',
    fetchImpl: async (url) => new Response(JSON.stringify(url.includes('/workflows/')
      ? { workflow_runs: [
        { id: 3, status: 'completed', conclusion: 'failure', created_at: '2026-08-17T11:55:00Z' },
        { id: 2, status: 'in_progress', created_at: '2026-08-17T11:30:00Z' },
      ] }
      : { jobs: [{ status: 'in_progress', started_at: '2026-08-17T11:35:00Z' }] }), { status: 200 }),
  })
  assert.equal(snapshot.latestRun.databaseId, '3')
  assert.equal(snapshot.latestRun.conclusion, 'failure')
  const result = evaluateSyncHealth({ now: NOW, workflows: [snapshot] })
  assert.equal(result.state, 'running')
  assert.equal(result.shouldAlert, true)
  assert.equal(result.shouldDispatch, false)
  assert.match(result.summary, /failure/)
})

test('job snapshots fail closed on inspection errors and honor the coordinator CI timeout', async () => {
  await assert.rejects(fetchWorkflowSnapshot({
    repository: 'owner/repo', workflowId: 'sync.yml',
    fetchImpl: async (url) => new Response(JSON.stringify(url.includes('/jobs?') ? {} : {
      workflow_runs: [{ id: 42, status: 'in_progress', created_at: '2026-08-17T09:00:00Z' }],
    }), { status: 200 }),
  }), /missing jobs/)
  const coordinator = workflow({
    jobTimeoutMinutes: 360, maxRunMinutes: 900,
    latestRun: { status: 'in_progress', createdAt: '2026-08-17T06:00:00Z' },
    jobs: [{ status: 'in_progress', startedAt: '2026-08-17T07:00:00Z' }],
  })
  assert.equal(evaluateSyncHealth({ now: NOW, workflows: [coordinator] }).state, 'running')
})

test('recovery rechecks observe completion instead of retaining the initial stale alarm', async () => {
  let clock = 0
  const states = ['recoverable', 'running', 'healthy']
  const result = await waitForSyncRecovery({
    inspect: async () => {
      const state = states.shift()
      return { state, shouldAlert: state === 'recoverable', summary: state }
    },
    waitMs: 60, pollIntervalMs: 20, now: () => clock,
    sleep: async (delay) => { clock += delay },
  })
  assert.equal(result.state, 'healthy')
  assert.equal(result.shouldAlert, false)
  assert.equal(clock, 40)
})

test('bounded recovery waits preserve pending work and real failure states', async () => {
  for (const state of ['running', 'recoverable', 'critical']) {
    let clock = 0
    const result = await waitForSyncRecovery({
      inspect: async () => ({ state, shouldAlert: state !== 'running', summary: state }),
      waitMs: 50, pollIntervalMs: 20, now: () => clock,
      sleep: async (delay) => { clock += delay },
    })
    assert.equal(result.state, state)
    assert.equal(result.shouldAlert, state !== 'running')
    assert.equal(clock, state === 'critical' ? 0 : 50)
    assert.equal(result.recoveryPending === true, state === 'running')
    if (state === 'running') assert.match(result.summary, /next watchdog/)
  }
})
