const RELEASE_MAJOR = 0
const RELEASE_MINOR = 1
const FIRST_RELEASE_PATCH = 200
const RELEASE_CUTOVER_PATCH = 270
const NEXT_RELEASE_MINOR = 2

export function nextReleaseVersion(previousVersion = '') {
  const normalized = String(previousVersion).trim().replace(/^v/, '')
  const legacyMatch = normalized.match(/^0\.1\.(\d+)$/)
  if (legacyMatch) {
    const patch = Number.parseInt(legacyMatch[1], 10)
    if (!Number.isSafeInteger(patch) || patch < FIRST_RELEASE_PATCH) {
      return `${RELEASE_MAJOR}.${RELEASE_MINOR}.${FIRST_RELEASE_PATCH}`
    }

    if (patch >= RELEASE_CUTOVER_PATCH) {
      return `${RELEASE_MAJOR}.${NEXT_RELEASE_MINOR}.0`
    }

    return `${RELEASE_MAJOR}.${RELEASE_MINOR}.${patch + 1}`
  }

  const currentMatch = normalized.match(new RegExp(`^${RELEASE_MAJOR}\\.${NEXT_RELEASE_MINOR}\\.(\\d+)$`))
  if (!currentMatch) {
    return `${RELEASE_MAJOR}.${RELEASE_MINOR}.${FIRST_RELEASE_PATCH}`
  }

  const patch = Number.parseInt(currentMatch[1], 10)
  if (!Number.isSafeInteger(patch)) {
    return `${RELEASE_MAJOR}.${RELEASE_MINOR}.${FIRST_RELEASE_PATCH}`
  }

  return `${RELEASE_MAJOR}.${NEXT_RELEASE_MINOR}.${patch + 1}`
}
