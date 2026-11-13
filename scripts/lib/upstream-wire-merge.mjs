const identifier = '[A-Za-z_][A-Za-z0-9_]*'
const providerPattern = new RegExp(`^\\s*(${identifier}(?:\\.${identifier})?),\\s*$`)
const constructorPattern = new RegExp(`^\\s*(${identifier}) := (${identifier}\\.${identifier})\\((?:${identifier}(?:, ${identifier})*)?\\)\\s*$`)
const handlersPattern = new RegExp(`^(\\s*handlers := handler\\.ProvideHandlers\\()(${identifier}(?:, ${identifier})*)(\\)\\s*)$`)

// Only additive changes to an ordered list are safe to combine automatically.
// Shared entries keep their original order; differing definitions are rejected.
function mergeAdditions(base, ours, theirs, key, equal = (left, right) => left === right) {
  const values = new Map()
  for (const item of [...base, ...ours, ...theirs]) {
    const name = key(item)
    if (values.has(name) && !equal(values.get(name), item)) {
      throw new Error(`Conflicting Wire definition for ${name}.`)
    }
    values.set(name, item)
  }
  for (const items of [base, ours, theirs]) {
    if (new Set(items.map(key)).size !== items.length) {
      throw new Error('Duplicate Wire entries cannot be merged automatically.')
    }
  }
  const gaps = (items) => {
    let position = 0
    const result = []
    for (const anchor of base) {
      const next = items.findIndex((item, index) => index >= position && key(item) === key(anchor))
      if (next < 0) throw new Error('Wire removals or replacements require manual resolution.')
      result.push(items.slice(position, next))
      position = next + 1
    }
    result.push(items.slice(position))
    return result
  }
  const ourGaps = gaps(ours)
  const theirGaps = gaps(theirs)
  const output = []
  const seen = new Set()
  for (let index = 0; index <= base.length; index += 1) {
    for (const item of [...ourGaps[index], ...theirGaps[index], ...(index < base.length ? [base[index]] : [])]) {
      if (!seen.has(key(item))) {
        seen.add(key(item))
        output.push(item)
      }
    }
  }
  // An entry inserted at different positions must not reorder either input.
  for (const items of [ours, theirs]) {
    let position = -1
    for (const item of items) {
      const next = output.findIndex((value) => key(value) === key(item))
      if (next <= position) throw new Error('Wire entry order conflicts require manual resolution.')
      position = next
    }
  }
  return output
}

function mergeProviderEntries({ ours, base, theirs }, prefix) {
  const opening = prefix.lastIndexOf('var ProviderSet = wire.NewSet(')
  if (opening < 0 || /\n\)/.test(prefix.slice(opening))) {
    throw new Error('Only provider-set entries can be merged automatically.')
  }
  const parse = (lines) => lines.filter((line) => line.trim()).map((line) => {
    const match = line.match(providerPattern)
    if (!match) throw new Error('Unrecognized provider conflict requires manual resolution.')
    return { name: match[1], line }
  })
  return mergeAdditions(parse(base), parse(ours), parse(theirs), (item) => item.name, (left, right) => left.name === right.name)
    .map((item) => item.line)
}

function mergeGeneratedHandlers({ ours, base, theirs }) {
  const parse = (lines) => {
    const handlers = lines.filter((line) => handlersPattern.test(line))
    if (handlers.length !== 1) throw new Error('Unrecognized generated Wire conflict requires manual resolution.')
    const constructors = lines.filter((line) => line.trim() && line !== handlers[0])
    for (const line of constructors) {
      if (!constructorPattern.test(line)) throw new Error('Unrecognized Wire constructor requires manual resolution.')
    }
    const handlerIndex = lines.indexOf(handlers[0])
    if (lines.slice(handlerIndex + 1).some((line) => line.trim())) {
      throw new Error('Wire statements after handler construction require manual resolution.')
    }
    return { constructors, match: handlers[0].match(handlersPattern) }
  }
  const original = parse(base)
  const local = parse(ours)
  const upstream = parse(theirs)
  const constructors = mergeAdditions(original.constructors, local.constructors, upstream.constructors,
    (line) => line.match(constructorPattern)[1])
  const args = mergeAdditions(original.match[2].split(', '), local.match[2].split(', '), upstream.match[2].split(', '), (value) => value)
  return [...constructors, `${upstream.match[1]}${args.join(', ')}${upstream.match[3]}`]
}

export function resolveWireConflict(file, text) {
  const lines = text.split(/\r?\n/)
  const output = []
  let index = 0
  while (index < lines.length) {
    if (!lines[index].startsWith('<<<<<<< ')) {
      output.push(lines[index++])
      continue
    }
    const conflict = { ours: [], base: [], theirs: [] }
    index += 1
    for (const [side, delimiter] of [['ours', '||||||| '], ['base', '======='], ['theirs', '>>>>>>> ']]) {
      while (index < lines.length && !lines[index].startsWith(delimiter)) {
        conflict[side].push(lines[index++])
      }
      if (index >= lines.length) throw new Error('Malformed merge conflict while synchronizing upstream source.')
      index += 1
    }
    const merged = file.endsWith('wire_gen.go')
      ? mergeGeneratedHandlers(conflict)
      : mergeProviderEntries(conflict, output.join('\n'))
    output.push(...merged)
  }
  return output.join('\n')
}
