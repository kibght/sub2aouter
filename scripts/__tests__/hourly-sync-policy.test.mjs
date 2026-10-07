import assert from 'node:assert/strict'
import test from 'node:test'
import { decideHourlySync } from '../../tools/windows-sync/sync-policy.mjs'
const current = {
  now: '2026-10-07T03:37:00Z', coordinatorRuns: [], publisherRuns: [],
  upstream: { tag_name: 'v0.2.14', id: 1 }, synchronizedTag: 'v0.2.14', synchronizedId: '1',
}
test('missing hourly runs are dispatched, while this hour success is retained', () => {
  assert.equal(decideHourlySync(current).dispatch, true)
  const coordinatorRuns = [{ databaseId: 1, createdAt: '2026-10-07T03:17:00Z', status: 'completed', conclusion: 'success' }]
  assert.equal(decideHourlySync({ ...current, coordinatorRuns }).dispatch, false)
  assert.equal(decideHourlySync({ ...current, coordinatorRuns, synchronizedTag: 'v0.2.13' }).dispatch, true)
})
test('active runs and recent attempts suppress duplicates', () => {
  for (const status of ['queued', 'in_progress', 'waiting']) {
    assert.equal(decideHourlySync({ ...current, publisherRuns: [{ status, databaseId: 2 }] }).dispatch, false)
  }
  const coordinatorRuns = [{ createdAt: '2026-10-07T03:30:00Z', status: 'completed', conclusion: 'failure' }]
  assert.equal(decideHourlySync({ ...current, coordinatorRuns }).reason, 'recent-dispatch')
})
test('catch-up at the hourly load boundary waits for the next safe trigger', () => {
  for (const now of ['2026-10-07T04:02:00Z', '2026-10-07T03:55:00Z']) {
    assert.equal(decideHourlySync({ ...current, now }).reason, 'deferred-hour-boundary')
  }
})
