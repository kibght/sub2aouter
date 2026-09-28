const RELEASE_MAJOR = 0
const RELEASE_MINOR = 1
const FIRST_RELEASE_PATCH = 200

export function nextReleaseVersion(previousVersion = '') {
  const normalized = String(previousVersion).trim().replace(/^v/, '')
  const match = normalized.match(/^0\.1\.(\d+)$/)
  if (!match) {
    return `${RELEASE_MAJOR}.${RELEASE_MINOR}.${FIRST_RELEASE_PATCH}`
  }

  const patch = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(patch) || patch < FIRST_RELEASE_PATCH) {
    return `${RELEASE_MAJOR}.${RELEASE_MINOR}.${FIRST_RELEASE_PATCH}`
  }

  return `${RELEASE_MAJOR}.${RELEASE_MINOR}.${patch + 1}`
}
