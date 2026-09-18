// Exact source hunks preserve upstream code outside the maintained changes.
// Accepted prior overlays are normalized only if every hunk still matches.
export function applySourceHunks(content, hunks, target) {
  let result = content
  for (const { before, after } of hunks) {
    if (result.includes(after)) {
      if (result.indexOf(after) !== result.lastIndexOf(after)) {
        throw new Error(`Ambiguous overlay replacement in ${target}`)
      }
      continue
    }
    const offset = result.indexOf(before)
    if (offset < 0 || offset !== result.lastIndexOf(before)) {
      throw new Error(`Source overlay drift in ${target}: ${before.slice(0, 100)}`)
    }
    result = result.slice(0, offset) + after + result.slice(offset + before.length)
  }
  return result
}

export function applySourceOverlay(content, entry) {
  try {
    return applySourceHunks(content, entry.hunks, entry.target)
  } catch (currentError) {
    for (const legacy of entry.legacy || []) {
      try {
        const reverse = [...legacy].reverse().map(({ before, after }) => ({ before: after, after: before }))
        const baseline = applySourceHunks(content, reverse, entry.target)
        return applySourceHunks(baseline, entry.hunks, entry.target)
      } catch {
        // Only explicitly recorded complete prior implementations may upgrade.
      }
    }
    throw currentError
  }
}
