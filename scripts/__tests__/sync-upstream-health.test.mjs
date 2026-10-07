import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateSyncHealth } from '../lib/sync-health.mjs'

const snapshot = {
  now: '2026-10-07T03:00:00Z',
  workflows: [{
    id: 'coordinator',
    latestSuccessAt: '2026-10-07T02:45:00Z',
    latestRun: { status: 'completed', conclusion: 'success', createdAt: '2026-10-07T02:44:00Z', updatedAt: '2026-10-07T02:45:00Z' },
  }],
  upstream: { found: true, tag: 'v0.2.14', id: '405300292', publishedAt: '2026-10-07T02:02:43Z', synchronizedTag: 'v0.2.13', synchronizedId: '401788812' },
}

test('a fresh successful workflow does not hide an unsynchronized upstream release', () => {
  const result = evaluateSyncHealth(snapshot)
  assert.equal(result.state, 'recoverable')
  assert.equal(result.shouldDispatch, true)
  assert.equal(result.upstream.state, 'recoverable')
  assert.match(result.summary, /v0.2.14/)
})

test('matching release tag and ID are healthy, but a recreated release requires checking', () => {
  const upstream = { ...snapshot.upstream, synchronizedTag: snapshot.upstream.tag, synchronizedId: snapshot.upstream.id }
  assert.equal(evaluateSyncHealth({ ...snapshot, upstream }).state, 'healthy')
  assert.equal(evaluateSyncHealth({ ...snapshot, upstream: { ...upstream, id: 'new-id' } }).shouldDispatch, true)
})

test('an active publisher suppresses duplicate dispatch for an upstream update', () => {
  const workflows = [{ ...snapshot.workflows[0], latestRun: { status: 'in_progress', createdAt: '2026-10-07T02:50:00Z' } }]
  const result = evaluateSyncHealth({ ...snapshot, workflows })
  assert.equal(result.state, 'running')
  assert.equal(result.shouldDispatch, false)
  assert.equal(result.upstream.state, 'recoverable')
})
