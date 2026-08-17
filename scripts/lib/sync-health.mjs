const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending'])
const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export class SyncHealthError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'SyncHealthError'
    this.status = options.status || 0
  }
}

function defaultSleep(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay))
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function ageMinutes(now, value) {
  const date = validDate(value)
  return date ? (now.getTime() - date.getTime()) / 60_000 : Number.NaN
}

function formatAge(value) {
  return Number.isFinite(value) ? `${Math.max(0, Math.round(value))}m` : 'invalid'
}

function validRepository(repository) {
  if (!REPOSITORY_PATTERN.test(repository || '')) {
    return false
  }
  return repository.split('/').every((part) => part !== '.' && part !== '..')
}

function transientStatus(response) {
  return response.status === 429 || response.status >= 500 || (
    response.status === 403 && (
      response.headers.get('x-ratelimit-remaining') === '0' ||
      response.headers.has('retry-after')
    )
  )
}

function retryDelay(attempt, baseDelayMs, maxDelayMs, random, response) {
  let retryAfterMs = 0
  const retryAfter = response?.headers.get('retry-after') || ''
  if (/^\d+$/.test(retryAfter.trim())) {
    retryAfterMs = Number(retryAfter.trim()) * 1_000
  }
  const exponential = baseDelayMs * (2 ** (attempt - 1))
  const jitter = Math.floor(Math.max(0, random()) * Math.max(1, baseDelayMs))
  return Math.min(maxDelayMs, Math.max(retryAfterMs, exponential + jitter))
}

async function responseText(response) {
  try {
    return (await response.text()).trim().slice(0, 500)
  } catch {
    return ''
  }
}

function mapRun(run) {
  return {
    status: typeof run.status === 'string' ? run.status : '',
    conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
    createdAt: typeof run.created_at === 'string' ? run.created_at : '',
    updatedAt: typeof run.updated_at === 'string' ? run.updated_at : '',
    url: typeof run.html_url === 'string' ? run.html_url : '',
    databaseId: run.id === undefined || run.id === null ? '' : String(run.id),
  }
}

export async function fetchWorkflowSnapshot(options) {
  const {
    repository,
    workflowId,
    name = workflowId,
    token = '',
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    attempts = 5,
    baseDelayMs = 5_000,
    maxDelayMs = 120_000,
    apiBaseUrl = 'https://api.github.com',
  } = options || {}

  if (!validRepository(repository)) {
    throw new SyncHealthError('Repository must use the owner/repo format.')
  }
  if (typeof workflowId !== 'string' || !workflowId.trim() || workflowId.includes('..')) {
    throw new SyncHealthError('A valid workflow identifier is required.')
  }
  if (typeof fetchImpl !== 'function') {
    throw new SyncHealthError('A fetch implementation is required.')
  }

  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/repos/${repository}/actions/workflows/${encodeURIComponent(workflowId)}/runs?per_page=20`
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'sub2api-sync-watchdog',
    'x-github-api-version': '2022-11-28',
  }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }

  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response
    try {
      response = await fetchImpl(endpoint, { headers })
    } catch (error) {
      lastError = new SyncHealthError(`transport error: ${error.message}`, { cause: error })
      if (attempt === attempts) {
        break
      }
      await sleep(retryDelay(attempt, baseDelayMs, maxDelayMs, random))
      continue
    }

    if (transientStatus(response)) {
      const body = await responseText(response)
      lastError = new SyncHealthError(`HTTP ${response.status}${body ? `: ${body}` : ''}`, { status: response.status })
      if (attempt === attempts) {
        break
      }
      await sleep(retryDelay(attempt, baseDelayMs, maxDelayMs, random, response))
      continue
    }

    if (!response.ok) {
      const body = await responseText(response)
      throw new SyncHealthError(`Workflow run query failed with HTTP ${response.status}${body ? `: ${body}` : ''}`, { status: response.status })
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw new SyncHealthError(`Workflow run query returned invalid JSON: ${error.message}`, { cause: error })
    }
    if (!payload || !Array.isArray(payload.workflow_runs)) {
      throw new SyncHealthError('Workflow run query response is missing workflow_runs.')
    }

    const runs = payload.workflow_runs
      .map(mapRun)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    const latestRun = runs[0] || null
    const latestSuccess = runs.find((run) => run.status === 'completed' && run.conclusion === 'success') || null

    return {
      id: workflowId,
      name,
      latestRun,
      latestSuccessAt: latestSuccess?.updatedAt || '',
      runs,
    }
  }

  throw new SyncHealthError(`Workflow run query failed after ${attempts} attempts: ${lastError?.message || 'unknown error'}`, {
    cause: lastError || undefined,
    status: lastError?.status || 0,
  })
}


async function fetchJsonEndpoint(options) {
  const {
    endpoint,
    token = '',
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    attempts = 5,
    baseDelayMs = 5_000,
    maxDelayMs = 120_000,
    allowNotFound = false,
    description = 'GitHub API query',
  } = options
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'sub2api-sync-watchdog',
    'x-github-api-version': '2022-11-28',
  }
  if (token) headers.authorization = `Bearer ${token}`

  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response
    try {
      response = await fetchImpl(endpoint, { headers })
    } catch (error) {
      lastError = new SyncHealthError(`transport error: ${error.message}`, { cause: error })
      if (attempt === attempts) break
      await sleep(retryDelay(attempt, baseDelayMs, maxDelayMs, random))
      continue
    }
    if (allowNotFound && response.status === 404) return { found: false, payload: null }
    if (transientStatus(response)) {
      const body = await responseText(response)
      lastError = new SyncHealthError(`HTTP ${response.status}${body ? `: ${body}` : ''}`, { status: response.status })
      if (attempt === attempts) break
      await sleep(retryDelay(attempt, baseDelayMs, maxDelayMs, random, response))
      continue
    }
    if (!response.ok) {
      const body = await responseText(response)
      throw new SyncHealthError(`${description} failed with HTTP ${response.status}${body ? `: ${body}` : ''}`, { status: response.status })
    }
    try {
      return { found: true, payload: await response.json() }
    } catch (error) {
      throw new SyncHealthError(`${description} returned invalid JSON: ${error.message}`, { cause: error })
    }
  }
  throw new SyncHealthError(`${description} failed after ${attempts} attempts: ${lastError?.message || 'unknown error'}`, { cause: lastError || undefined, status: lastError?.status || 0 })
}

export async function fetchReleaseSnapshot(options) {
  const {
    repository,
    tag,
    token = '',
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    attempts = 5,
    baseDelayMs = 5_000,
    maxDelayMs = 120_000,
    apiBaseUrl = 'https://api.github.com',
  } = options || {}
  if (!validRepository(repository)) throw new SyncHealthError('Repository must use the owner/repo format.')
  if (typeof tag !== 'string' || !tag.trim() || tag.includes('..')) throw new SyncHealthError('A valid release tag is required.')
  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`
  const result = await fetchJsonEndpoint({ endpoint, token, fetchImpl, sleep, random, attempts, baseDelayMs, maxDelayMs, allowNotFound: true, description: 'Release integrity query' })
  if (!result.found) return { tag, exists: false, draft: false, prerelease: false, target: '', assets: [] }
  const payload = result.payload
  if (!payload || !Array.isArray(payload.assets)) throw new SyncHealthError('Release integrity query response is missing assets.')
  return {
    tag,
    exists: true,
    draft: payload.draft === true,
    prerelease: payload.prerelease === true,
    target: typeof payload.target_commitish === 'string' ? payload.target_commitish : '',
    assets: payload.assets.map((asset) => asset?.name).filter((name) => typeof name === 'string'),
  }
}

export async function fetchRepositoryContent(options) {
  const {
    repository,
    path,
    ref,
    token = '',
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    attempts = 5,
    baseDelayMs = 5_000,
    maxDelayMs = 120_000,
    apiBaseUrl = 'https://api.github.com',
  } = options || {}
  if (!validRepository(repository)) throw new SyncHealthError('Repository must use the owner/repo format.')
  if (typeof path !== 'string' || !path.trim() || path.includes('..')) throw new SyncHealthError('A valid repository content path is required.')
  if (typeof ref !== 'string' || !ref.trim() || ref.includes('..')) throw new SyncHealthError('A valid repository content ref is required.')
  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/repos/${repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
  const { payload } = await fetchJsonEndpoint({ endpoint, token, fetchImpl, sleep, random, attempts, baseDelayMs, maxDelayMs, description: 'Repository content query' })
  if (!payload || payload.encoding !== 'base64' || typeof payload.content !== 'string') throw new SyncHealthError('Repository content query response is not base64 file content.')
  return Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8')
}

function requiredReleaseAssets(version) {
  return [
    `sub2api_${version}_linux_amd64.tar.gz`,
    `sub2api_${version}_linux_arm64.tar.gz`,
    `sub2api_${version}_windows_amd64.zip`,
    `sub2api_${version}_darwin_amd64.tar.gz`,
    `sub2api_${version}_darwin_arm64.tar.gz`,
    'checksums.txt',
  ]
}

export function evaluateSyncHealth(options) {
  const {
    now: nowValue = new Date(),
    staleAfterMinutes = 120,
    stuckAfterMinutes = 90,
    workflows = [],
    release = null,
  } = options || {}

  const now = validDate(nowValue)
  if (!now) {
    throw new SyncHealthError('The health evaluation clock is invalid.')
  }
  if (!Number.isFinite(staleAfterMinutes) || staleAfterMinutes <= 0) {
    throw new SyncHealthError('staleAfterMinutes must be positive.')
  }
  if (!Number.isFinite(stuckAfterMinutes) || stuckAfterMinutes <= 0) {
    throw new SyncHealthError('stuckAfterMinutes must be positive.')
  }
  if (!Array.isArray(workflows) || workflows.length === 0) {
    throw new SyncHealthError('At least one workflow snapshot is required.')
  }

  const criticalReasons = []
  const recoverableReasons = []
  const runningReasons = []
  const details = []

  for (const workflow of workflows) {
    const name = workflow?.name || workflow?.id || 'unknown workflow'
    const latestRun = workflow?.latestRun
    if (!latestRun) {
      criticalReasons.push(`${name} has no workflow run history.`)
      details.push({ id: workflow?.id || '', name, state: 'critical', reason: 'missing-run-history' })
      continue
    }

    const createdAt = validDate(latestRun.createdAt)
    const updatedAt = validDate(latestRun.updatedAt || latestRun.createdAt)
    if (!createdAt || !updatedAt) {
      criticalReasons.push(`${name} contains an invalid latest-run timestamp.`)
      details.push({ id: workflow?.id || '', name, state: 'critical', reason: 'invalid-run-timestamp' })
      continue
    }

    if (ACTIVE_STATUSES.has(latestRun.status)) {
      const activeAge = ageMinutes(now, createdAt)
      if (activeAge > stuckAfterMinutes) {
        criticalReasons.push(`${name} is stuck in ${latestRun.status} for ${formatAge(activeAge)}.`)
        details.push({ id: workflow?.id || '', name, state: 'critical', reason: 'stuck-active-run', ageMinutes: activeAge })
      } else {
        runningReasons.push(`${name} is ${latestRun.status} for ${formatAge(activeAge)}.`)
        details.push({ id: workflow?.id || '', name, state: 'running', reason: 'active-run', ageMinutes: activeAge })
      }
      continue
    }

    if (latestRun.status !== 'completed') {
      criticalReasons.push(`${name} has unsupported run status ${latestRun.status || 'empty'}.`)
      details.push({ id: workflow?.id || '', name, state: 'critical', reason: 'invalid-run-status' })
      continue
    }

    if (!SUCCESS_CONCLUSIONS.has(latestRun.conclusion)) {
      recoverableReasons.push(`${name} latest run concluded with ${latestRun.conclusion || 'no conclusion'} failure state.`)
      details.push({ id: workflow?.id || '', name, state: 'recoverable', reason: 'latest-run-failure' })
      continue
    }

    const latestSuccessAt = validDate(workflow.latestSuccessAt)
    if (!latestSuccessAt) {
      criticalReasons.push(`${name} contains an invalid latest-success timestamp.`)
      details.push({ id: workflow?.id || '', name, state: 'critical', reason: 'invalid-success-timestamp' })
      continue
    }

    const successAge = ageMinutes(now, latestSuccessAt)
    if (successAge > staleAfterMinutes) {
      recoverableReasons.push(`${name} latest success is stale at ${formatAge(successAge)}.`)
      details.push({ id: workflow?.id || '', name, state: 'recoverable', reason: 'stale-success', ageMinutes: successAge })
    } else {
      details.push({ id: workflow?.id || '', name, state: 'healthy', reason: 'fresh-success', ageMinutes: successAge })
    }
  }

  let releaseDetails = null
  if (release) {
    const version = typeof release.version === 'string' ? release.version.trim() : ''
    const expectedTag = version ? `v${version}` : ''
    releaseDetails = { version, tag: release.tag || expectedTag, state: 'healthy', missingAssets: [] }
    if (!/^\d+\.\d+\.\d+$/.test(version) || release.tag !== expectedTag) {
      criticalReasons.push('Generated release metadata contains an invalid version or tag.')
      releaseDetails.state = 'critical'
    } else {
      if (release.expectedMainSha && release.repositorySha !== release.expectedMainSha) {
        recoverableReasons.push(`Generated repository metadata is stale: ${release.repositorySha || 'missing'} != ${release.expectedMainSha}.`)
        releaseDetails.state = 'recoverable'
      }
      if (!release.exists) {
        recoverableReasons.push(`GitHub Release ${expectedTag} is missing and requires repair.`)
        releaseDetails.state = 'recoverable'
      } else {
        const missingAssets = requiredReleaseAssets(version).filter((asset) => !release.assets?.includes(asset))
        releaseDetails.missingAssets = missingAssets
        if (release.draft || release.prerelease || release.target !== 'themed-release' || missingAssets.length > 0) {
          recoverableReasons.push(`GitHub Release ${expectedTag} is incomplete or mis-targeted (draft=${release.draft}, prerelease=${release.prerelease}, target=${release.target || 'missing'}, missing=${missingAssets.join(',') || 'none'}).`)
          releaseDetails.state = 'recoverable'
        }
      }
    }
  }

  let state = 'healthy'
  let reasons = []
  if (criticalReasons.length > 0) {
    state = 'critical'
    reasons = criticalReasons
  } else if (runningReasons.length > 0) {
    state = 'running'
    reasons = runningReasons
  } else if (recoverableReasons.length > 0) {
    state = 'recoverable'
    reasons = recoverableReasons
  }

  return {
    state,
    healthy: state === 'healthy' || state === 'running',
    shouldDispatch: state === 'recoverable',
    shouldAlert: state === 'recoverable' || state === 'critical',
    reasons,
    summary: reasons.length > 0 ? reasons.join(' ') : (release ? 'All synchronization workflows and generated release assets are healthy.' : 'All synchronization workflows have a fresh successful run.'),
    evaluatedAt: now.toISOString(),
    staleAfterMinutes,
    stuckAfterMinutes,
    workflows: details,
    release: releaseDetails,
  }
}