// Exact source hunks preserve upstream code outside the maintained changes.
// Accepted prior overlays are normalized only if every hunk still matches.
export function applySourceHunks(content, hunks, target, { fuzzy = false } = {}) {
  let result = content
  const repeatedChanged = new Map()
  for (const hunk of hunks) {
    const changed = changedMiddle(hunk.before, hunk.after)
    if (changed) repeatedChanged.set(changed, (repeatedChanged.get(changed) || 0) + 1)
  }
  for (const { before, after } of hunks) {
    if (result.includes(after)) {
      if (result.indexOf(after) !== result.lastIndexOf(after)) {
        throw new Error(`Ambiguous overlay replacement in ${target}`)
      }
      continue
    }
    const offset = result.indexOf(before)
    if (offset >= 0 && offset === result.lastIndexOf(before)) {
      result = result.slice(0, offset) + after + result.slice(offset + before.length)
      continue
    }

    if (fuzzy) {
      if (hasContextualAfter(result, before, after) || isRepeatedChangedAlreadyPresent(result, before, after, repeatedChanged)) continue
      const contextual = applyContextualHunk(result, before, after)
      if (contextual !== null) {
        result = contextual
        continue
      }
    }
    throw new Error(`Source overlay drift in ${target}: ${before.slice(0, 100)}`)
  }
  return result
}

function changedMiddle(before, after) {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1
  return afterLines.slice(prefix, afterLines.length - suffix).join('\n')
}

function isRepeatedChangedAlreadyPresent(content, before, after, repeatedChanged) {
  const changed = changedMiddle(before, after)
  const expected = repeatedChanged.get(changed) || 0
  if (!changed || expected < 2) return false
  return content.split(changed).length - 1 >= expected
}

function hasContextualAfter(content, before, after) {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1
  const changed = afterLines.slice(prefix, afterLines.length - suffix).join('\n')
  if (!changed) return false
  if (changed.includes('sub2aouter:') && content.includes(changed)) return true
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix).join('\n')
  const occurrences = []
  let firstOccurrence = content.indexOf(changed)
  while (firstOccurrence >= 0) {
    occurrences.push(firstOccurrence)
    firstOccurrence = content.indexOf(changed, firstOccurrence + 1)
  }
  if (!removed && occurrences.length === 1) return true
  const prefixAnchor = beforeLines.slice(Math.max(0, prefix - 6), prefix).join('\n')
  const suffixAnchor = beforeLines.slice(beforeLines.length - Math.min(6, suffix)).join('\n')
  if (occurrences.length === 1) {
    const occurrence = occurrences[0]
    const prefixMatches = prefixAnchor && content.lastIndexOf(prefixAnchor, occurrence) >= 0
    const suffixMatches = suffixAnchor && content.indexOf(suffixAnchor, occurrence + changed.length) >= 0
    const prefixExists = prefixAnchor && content.includes(prefixAnchor)
    const suffixExists = suffixAnchor && content.includes(suffixAnchor)
    if (prefixExists && suffixExists) return Boolean(prefixMatches && suffixMatches)
    return Boolean(prefixMatches || suffixMatches)
  }
  if (!prefixAnchor || !suffixAnchor) return false
  for (const occurrence of occurrences) {
    if (content.lastIndexOf(prefixAnchor, occurrence) >= 0 && content.indexOf(suffixAnchor, occurrence + changed.length) >= 0) return true
  }
  return false
}

// Upstream may insert an independent block inside the exact context while the
// maintained change still targets the same line. Preserve that block and
// replace only the changed middle, using the surrounding lines as anchors.
function applyContextualHunk(content, before, after) {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1
  if (prefix === 0 && suffix === 0) return null

  const removed = beforeLines.slice(prefix, beforeLines.length - suffix).join('\n')
  const added = afterLines.slice(prefix, afterLines.length - suffix).join('\n')
  if (!removed) {
    // For insertions, a small upstream edit may have changed the first line
    // after the insertion point. Find the nearest stable prefix instead of
    // requiring that line to remain byte-identical.
    const changedFollowingLine = beforeLines[prefix - 1] || ''
    const discriminator = changedFollowingLine.match(/"[^"]+"/g)?.find((value) => value.includes(' buffered'))
    if (discriminator) {
      const lineNeedle = discriminator.slice(1, -1)
      const lineOffset = content.indexOf(lineNeedle)
      if (lineOffset >= 0 && lineOffset === content.lastIndexOf(lineNeedle)) {
        const lineEnd = content.indexOf('\n', lineOffset)
        const insertion = lineEnd < 0 ? content.length : lineEnd + 1
        return content.slice(0, insertion) + added + content.slice(insertion)
      }
    }
    for (let end = prefix - 1; end >= 1; end -= 1) {
      const anchorLine = beforeLines[end - 1]
      if (!anchorLine) continue
      const anchorOffset = content.indexOf(anchorLine)
      if (anchorOffset < 0 || anchorOffset !== content.lastIndexOf(anchorLine)) continue
      let cursor = anchorOffset + anchorLine.length
      for (const expectedLine of beforeLines.slice(end, prefix)) {
        if (content[cursor] === '\n') cursor += 1
        if (expectedLine && content.startsWith(expectedLine, cursor)) {
          cursor += expectedLine.length
          continue
        }
        const nextLine = content.indexOf('\n', cursor)
        cursor = nextLine < 0 ? content.length : nextLine + 1
        break
      }
      if (content[cursor] === '\n') cursor += 1
      return content.slice(0, cursor) + added + content.slice(cursor)
    }
    for (let end = prefix; end >= 1; end -= 1) {
      for (let width = Math.min(6, end); width >= 1; width -= 1) {
        const anchor = beforeLines.slice(end - width, end).join('\n')
        const offset = content.indexOf(anchor)
        if (offset >= 0 && offset === content.lastIndexOf(anchor)) {
          const insertionOffset = offset + anchor.length
          const insertion = content[insertionOffset] === '\n' ? insertionOffset + 1 : insertionOffset
          return content.slice(0, insertion) + added + content.slice(insertion)
        }
      }
    }
  }
  for (let prefixWidth = Math.min(6, prefix); prefixWidth >= 1; prefixWidth -= 1) {
    const prefixAnchor = beforeLines.slice(prefix - prefixWidth, prefix).join('\n')
    let searchFrom = 0
    let candidate
    while ((candidate = content.indexOf(prefixAnchor, searchFrom)) >= 0) {
      const middleStart = candidate + prefixAnchor.length
      if (!removed) {
        const insertion = content[middleStart] === '\n' ? middleStart + 1 : middleStart
        return content.slice(0, insertion) + added + content.slice(insertion)
      }
      for (let suffixWidth = Math.min(6, suffix); suffixWidth >= 1; suffixWidth -= 1) {
        const suffixAnchor = beforeLines.slice(beforeLines.length - suffixWidth).join('\n')
        const suffixOffset = content.indexOf(suffixAnchor, middleStart)
        if (suffixOffset < 0) continue
        const middleEnd = removed ? content.indexOf(removed, middleStart) : middleStart
        if (removed && middleEnd < 0 && suffixOffset >= middleStart) {
          return content.slice(0, suffixOffset) + added + content.slice(suffixOffset)
        }
        if (middleEnd >= 0 && middleEnd <= suffixOffset) {
          const replacementEnd = removed ? middleEnd + removed.length : middleStart
          return content.slice(0, middleEnd) + added + content.slice(replacementEnd)
        }
      }
      searchFrom = candidate + 1
    }
  }
  return null
}

export function applySourceOverlay(content, entry) {
  try {
    return applySourceHunks(content, entry.hunks, entry.target, { fuzzy: false })
  } catch (currentError) {
    for (const legacy of entry.legacy || []) {
      try {
        const reverse = [...legacy].reverse().map(({ before, after }) => ({ before: after, after: before }))
        const baseline = applySourceHunks(content, reverse, entry.target, { fuzzy: false })
        return applySourceHunks(baseline, entry.hunks, entry.target, { fuzzy: false })
      } catch {
        // Only explicitly recorded complete prior implementations may upgrade.
      }
    }
    try {
      return applySourceHunks(content, entry.hunks, entry.target, { fuzzy: true })
    } catch {
      // Re-throw the exact drift error below so callers get the stable marker.
    }
    throw currentError
  }
}
