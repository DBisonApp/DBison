/**
 * The matcher behind the explorer's filter.
 *
 * A schema snapshot is already in memory, so the filter runs over every table,
 * view and column a database has on each keystroke. That rules out anything
 * clever: this is a single left-to-right pass per candidate, ranked so that the
 * name the user is most likely typing toward sorts first.
 *
 * Ranges come back with the score because a match nobody can see is only half
 * an answer — the row highlights the characters that earned the hit.
 */

export interface FuzzyMatch {
  /** Higher is better; only comparable between candidates of the same list. */
  score: number
  /** Half-open `[start, end)` slices of the original string, in order. */
  ranges: [number, number][]
}

/** Where a word starts: the head of the string, or a letter after a separator. */
function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true

  const previous = text[index - 1]!
  return previous === '_' || previous === '.' || previous === '-' || previous === ' '
}

/**
 * Scores `needle` against `text`, or returns null when it does not match at all.
 *
 * Three tiers, in the order a user expects them: a contiguous run beats
 * scattered letters, a run that starts a word beats one that starts mid-word,
 * and an earlier hit beats a later one.
 */
export function fuzzyMatch(text: string, needle: string): FuzzyMatch | null {
  if (!needle) return { score: 0, ranges: [] }

  const haystack = text.toLowerCase()
  const query = needle.toLowerCase()

  const at = haystack.indexOf(query)

  if (at !== -1) {
    return {
      score: 2000 - at + (isBoundary(haystack, at) ? 500 : 0),
      ranges: [[at, at + query.length]],
    }
  }

  // Subsequence: every letter in order, gaps allowed. Greedy from the left is
  // enough here — identifiers are short, and the tier above already caught the
  // cases where a smarter alignment would have mattered.
  const ranges: [number, number][] = []
  let cursor = 0
  let gaps = 0

  for (const letter of query) {
    const found = haystack.indexOf(letter, cursor)
    if (found === -1) return null

    const last = ranges.at(-1)

    if (last && last[1] === found) last[1] = found + 1
    else {
      if (last) gaps++
      ranges.push([found, found + 1])
    }

    cursor = found + 1
  }

  return { score: 1000 - ranges[0]![0] - gaps * 10, ranges }
}

/** Splits `text` into the alternating unmatched/matched runs a row renders. */
export function highlight(text: string, ranges: [number, number][]) {
  const parts: { text: string, hit: boolean }[] = []
  let cursor = 0

  for (const [start, end] of ranges) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false })
    parts.push({ text: text.slice(start, end), hit: true })
    cursor = end
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false })

  return parts
}
