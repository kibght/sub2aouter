const ACTIVE = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending'])

export function decideHourlySync({ now = new Date(), coordinatorRuns, publisherRuns, upstream, synchronizedTag, synchronizedId }) {
  const current = new Date(now)
  if (!Number.isFinite(current.getTime())) throw new Error('Invalid synchronization clock.')
  const slot = new Date(current)
  slot.setUTCMinutes(17, 0, 0)
  if (slot > current) slot.setUTCHours(slot.getUTCHours() - 1)
  const active = [...coordinatorRuns, ...publisherRuns].find((run) => ACTIVE.has(run.status))
  if (active) return { dispatch: false, reason: 'active-run', runId: active.databaseId }
  if (current.getUTCMinutes() < 12 || current.getUTCMinutes() > 48) {
    return { dispatch: false, reason: 'deferred-hour-boundary' }
  }
  const latest = [...coordinatorRuns].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
  const pendingUpstream = upstream.tag_name !== synchronizedTag || String(upstream.id) !== synchronizedId
  const latestTime = latest ? Date.parse(latest.createdAt) : 0
  if (latest && !Number.isFinite(latestTime)) throw new Error('Invalid coordinator timestamp.')
  if (latestTime >= slot.getTime() && latest.conclusion === 'success' && !pendingUpstream) {
    return { dispatch: false, reason: 'hour-already-checked', runId: latest.databaseId }
  }
  if (latest && current.getTime() - latestTime < 20 * 60_000) {
    return { dispatch: false, reason: 'recent-dispatch', runId: latest.databaseId }
  }
  return { dispatch: true, reason: pendingUpstream ? 'upstream-release-pending' : 'hourly-schedule-missing', slot: slot.toISOString() }
}
