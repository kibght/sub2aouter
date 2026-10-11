const DEFAULT_API_BASE_URL = 'https://api.github.com'
const DEFAULT_ATTEMPTS = 5
const DEFAULT_BASE_DELAY_MS = 5_000
const DEFAULT_MAX_DELAY_MS = 120_000
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function isValidRepository(repository) {
  if (typeof repository !== 'string') {
    return false
  }
  const parts = repository.split('/')
  return parts.length === 2 && parts.every((part) => (
    part.length > 0 &&
    part !== '.' &&
    part !== '..' &&
    /^[A-Za-z0-9_.-]+$/.test(part)
  ))
}
export class GitHubReleaseError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'GitHubReleaseError'
    this.status = options.status || 0
    this.attempts = options.attempts || 1
  }
}

function defaultSleep(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay))
}

function retryAfterMilliseconds(response, now = Date.now()) {
  const value = response.headers.get('retry-after')
  if (!value) {
    return 0
  }

  if (/^\d+$/.test(value.trim())) {
    return Number(value.trim()) * 1_000
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : 0
}

function isTransientResponse(response) {
  if (response.status === 429 || response.status >= 500) {
    return true
  }

  return response.status === 403 && (
    response.headers.get('x-ratelimit-remaining') === '0' ||
    response.headers.has('retry-after')
  )
}

function delayForAttempt({ attempt, baseDelayMs, maxDelayMs, retryAfterMs, random }) {
  const exponential = baseDelayMs * (2 ** (attempt - 1))
  const jitter = Math.floor(Math.max(0, random()) * Math.max(1, baseDelayMs))
  return Math.min(maxDelayMs, Math.max(retryAfterMs, exponential + jitter))
}

async function responseDescription(response) {
  let body = ''
  try {
    body = (await response.text()).trim()
  } catch {
    body = ''
  }
  const suffix = body ? `: ${body.slice(0, 500)}` : ''
  return `HTTP ${response.status}${suffix}`
}

export async function fetchLatestRelease(options) {
  const {
    repository,
    token = '',
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    apiBaseUrl = DEFAULT_API_BASE_URL,
  } = options || {}

  if (!isValidRepository(repository)) {
    throw new GitHubReleaseError('Repository must use the owner/repo format.')
  }
  if (typeof fetchImpl !== 'function') {
    throw new GitHubReleaseError('A fetch implementation is required.')
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new GitHubReleaseError('Attempts must be a positive integer.')
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new GitHubReleaseError('Retry delays must be non-negative numbers.')
  }

  const endpoint = `${apiBaseUrl.replace(/\/$/, '')}/repos/${repository}/releases/latest`
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'sub2api-upstream-sync',
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
      lastError = new GitHubReleaseError(`transport error: ${error.message}`, {
        cause: error,
        attempts: attempt,
      })
      if (attempt === attempts) {
        break
      }
      await sleep(delayForAttempt({
        attempt,
        baseDelayMs,
        maxDelayMs,
        retryAfterMs: 0,
        random,
      }))
      continue
    }

    if (response.status === 404) {
      return { found: false, tag: '', id: '', publishedAt: '' }
    }

    if (isTransientResponse(response)) {
      const retryAfterMs = retryAfterMilliseconds(response)
      const description = await responseDescription(response)
      lastError = new GitHubReleaseError(description, {
        status: response.status,
        attempts: attempt,
      })
      if (attempt === attempts) {
        break
      }
      await sleep(delayForAttempt({
        attempt,
        baseDelayMs,
        maxDelayMs,
        retryAfterMs,
        random,
      }))
      continue
    }

    if (!response.ok) {
      const description = await responseDescription(response)
      throw new GitHubReleaseError(`GitHub latest-release request failed: ${description}`, {
        status: response.status,
        attempts: attempt,
      })
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw new GitHubReleaseError(`GitHub latest-release response contained invalid JSON: ${error.message}`, {
        cause: error,
        status: response.status,
        attempts: attempt,
      })
    }

    if (!payload || typeof payload.tag_name !== 'string' || !payload.tag_name.trim()) {
      throw new GitHubReleaseError('GitHub latest-release response is missing tag_name.', {
        status: response.status,
        attempts: attempt,
      })
    }

    if (payload.id === undefined || payload.id === null || String(payload.id).trim() === '') {
      throw new GitHubReleaseError('GitHub latest-release response is missing id.', {
        status: response.status,
        attempts: attempt,
      })
    }

    return {
      found: true,
      tag: payload.tag_name.trim(),
      id: String(payload.id),
      publishedAt: typeof payload.published_at === 'string' ? payload.published_at : '',
    }
  }

  const detail = lastError ? lastError.message : 'unknown error'
  throw new GitHubReleaseError(
    `GitHub latest-release request failed after ${attempts} attempts: ${detail}`,
    {
      cause: lastError || undefined,
      status: lastError?.status || 0,
      attempts,
    },
  )
}