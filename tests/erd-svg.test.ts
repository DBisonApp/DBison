import { describe, expect, it } from 'vitest'

import type { SchemaSnapshot } from '#shared/db-types'
import { buildGraph, tableKey } from '../app/utils/erd-graph'
import { FALLBACK_THEME, toSvg } from '../app/utils/erd-svg'

const snapshot: SchemaSnapshot = {
  database: 'shop',
  schemas: ['public'],
  objects: [
    {
      schema: 'public',
      name: 'customers',
      kind: 'table',
      path: { schema: 'public', table: 'customers' },
      columns: [
        { name: 'id', type: 'integer', primaryKey: true, nullable: false },
        { name: 'email', type: 'text' },
      ],
    },
    {
      schema: 'public',
      name: 'orders',
      kind: 'table',
      path: { schema: 'public', table: 'orders' },
      columns: [
        { name: 'id', type: 'integer', primaryKey: true, nullable: false },
        { name: 'customer_id', type: 'integer' },
        { name: 'placed_at', type: 'timestamp' },
      ],
    },
  ],
  relations: [
    { schema: 'public', table: 'orders', columns: ['customer_id'], refSchema: 'public', refTable: 'customers', refColumns: ['id'] },
  ],
  truncated: false,
}

describe('toSvg', () => {
  it('draws both tables and one line for the key between them', () => {
    const { nodes, edges } = buildGraph(snapshot, { schema: 'public', qualified: false, includeViews: false })
    const svg = toSvg(nodes, edges, FALLBACK_THEME)

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('>customers<')
    expect(svg).toContain('>orders<')
    // One line with an arrowhead; the marker's own path is not a key.
    expect(svg.match(/marker-end="url\(#erd-arrow\)"/g)).toHaveLength(1)
    // The theme's colours are inlined; nothing points outside the file.
    expect(svg).toContain(FALLBACK_THEME.bg)
    expect(svg).not.toContain('var(--')
  })

  it('marks key columns and escapes what it prints', () => {
    const { nodes, edges } = buildGraph(snapshot, { schema: 'public', qualified: false, includeViews: false })
    const named = nodes.map((node) => node.id === tableKey('public', 'orders')
      ? { ...node, data: { ...node.data, label: 'a<b>&"c"' } }
      : node)

    const svg = toSvg(named, edges)

    expect(svg).toContain('>PK<')
    expect(svg).toContain('>FK<')
    expect(svg).toContain('a&lt;b&gt;&amp;&quot;c&quot;')
  })

  it('draws an empty picture for an empty graph', () => {
    expect(toSvg([], [])).toMatch(/^<svg[^>]*><rect[^>]*\/><\/svg>$/)
  })
})
