import { describe, expect, it } from 'vitest'

import {
  flattenPlan,
  parseMysqlAnalyzeTree,
  parseMysqlJsonPlan,
  parsePlanResult,
  parsePostgresJsonPlan,
  parseSqliteQueryPlan,
} from '../app/utils/plan-parse'

const PG_ANALYZE = JSON.stringify([{
  'Plan': {
    'Node Type': 'Hash Join',
    'Join Type': 'Left',
    'Startup Cost': 12.5,
    'Total Cost': 48.75,
    'Plan Rows': 100,
    'Actual Startup Time': 0.4,
    'Actual Total Time': 3.2,
    'Actual Rows': 1500,
    'Actual Loops': 1,
    'Hash Cond': '(o.customer_id = c.id)',
    'Shared Hit Blocks': 40,
    'Shared Read Blocks': 2,
    'Plans': [
      {
        'Node Type': 'Seq Scan',
        'Parent Relationship': 'Outer',
        'Parallel Aware': false,
        'Relation Name': 'orders',
        'Alias': 'o',
        'Total Cost': 20,
        'Plan Rows': 100,
        'Actual Total Time': 1.5,
        'Actual Rows': 1500,
        'Actual Loops': 1,
        'Filter': '(o.total > 10)',
        'Rows Removed by Filter': 3,
      },
      {
        'Node Type': 'Hash',
        'Parent Relationship': 'Inner',
        'Total Cost': 10,
        'Plan Rows': 50,
        'Actual Total Time': 0.5,
        'Actual Rows': 50,
        'Actual Loops': 1,
        'Plans': [{
          'Node Type': 'Index Scan',
          'Relation Name': 'customers',
          'Alias': 'c',
          'Index Name': 'customers_pkey',
          'Total Cost': 8,
          'Plan Rows': 50,
          'Actual Total Time': 0.1,
          'Actual Rows': 50,
          'Actual Loops': 1,
          'Index Cond': '(c.id > 0)',
        }],
      },
    ],
  },
  'Planning Time': 0.12,
  'Execution Time': 34.5,
}])

describe('parsePostgresJsonPlan', () => {
  it('lifts the columns and computes exclusive times', () => {
    const plan = parsePostgresJsonPlan(PG_ANALYZE)

    expect(plan.engine).toBe('postgres')
    expect(plan.analyzed).toBe(true)
    expect(plan.planningMs).toBe(0.12)
    expect(plan.executionMs).toBe(34.5)

    const root = plan.root
    expect(root.label).toBe('Hash Left Join')
    expect(root.detail).toBe('Hash Cond: (o.customer_id = c.id)')
    expect(root.estimatedRows).toBe(100)
    expect(root.actualRows).toBe(1500)
    expect(root.cost).toBe(48.75)
    expect(root.buffers).toEqual({ sharedHit: 40, sharedRead: 2, tempWritten: undefined })
    // 3.2 minus the two children's 1.5 and 0.5.
    expect(root.selfMs).toBeCloseTo(1.2)

    const [scan, hash] = root.children
    expect(scan!.label).toBe('Seq Scan')
    expect(scan!.detail).toBe('on orders o · Filter: (o.total > 10)')
    expect(scan!.extras['Rows Removed by Filter']).toBe(3)
    expect(scan!.extras).not.toHaveProperty('Plan Rows')

    expect(hash!.children[0]!.detail).toBe('using customers_pkey on customers c · Index Cond: (c.id > 0)')
    // A leaf's exclusive time is its whole time.
    expect(hash!.children[0]!.selfMs).toBeCloseTo(0.1)
  })

  it('weighs a child by its loops when subtracting it', () => {
    const plan = parsePostgresJsonPlan(JSON.stringify([{
      Plan: {
        'Node Type': 'Nested Loop',
        'Actual Total Time': 10,
        'Actual Loops': 1,
        'Plans': [
          { 'Node Type': 'Seq Scan', 'Actual Total Time': 2, 'Actual Loops': 1 },
          { 'Node Type': 'Index Scan', 'Actual Total Time': 0.5, 'Actual Loops': 10 },
        ],
      },
    }]))

    expect(plan.root.selfMs).toBeCloseTo(3)
  })

  it('reads a plan without actuals as estimates only', () => {
    const plan = parsePostgresJsonPlan('[{"Plan": {"Node Type": "Seq Scan", "Relation Name": "t", "Alias": "t", "Total Cost": 1.5, "Plan Rows": 3}}]')

    expect(plan.analyzed).toBe(false)
    expect(plan.root.selfMs).toBeUndefined()
    expect(plan.root.detail).toBe('on t')
    expect(plan.root.label).toBe('Seq Scan')
  })

  it('names parallel and partial nodes the way the text format does', () => {
    const plan = parsePostgresJsonPlan(JSON.stringify([{
      Plan: {
        'Node Type': 'Aggregate',
        'Partial Mode': 'Finalize',
        'Plans': [{ 'Node Type': 'Seq Scan', 'Parallel Aware': true, 'Relation Name': 't', 'Alias': 't' }],
      },
    }]))

    expect(plan.root.label).toBe('Finalize Aggregate')
    expect(plan.root.children[0]!.label).toBe('Parallel Seq Scan')
  })

  it('refuses something that is not a plan', () => {
    expect(() => parsePostgresJsonPlan('[{"rows": 1}]')).toThrow(/Not a Postgres JSON plan/)
    expect(() => parsePostgresJsonPlan('QUERY PLAN')).toThrow()
  })
})

const MYSQL_JSON = JSON.stringify({
  query_block: {
    select_id: 1,
    cost_info: { query_cost: '2.55' },
    ordering_operation: {
      using_filesort: true,
      nested_loop: [
        {
          table: {
            table_name: 'c',
            access_type: 'ALL',
            rows_examined_per_scan: 3,
            rows_produced_per_join: 3,
            filtered: '100.00',
            cost_info: { read_cost: '0.25', eval_cost: '0.30', prefix_cost: '0.55', data_read_per_join: '48' },
            used_columns: ['id', 'name'],
          },
        },
        {
          table: {
            table_name: 'o',
            access_type: 'ref',
            possible_keys: ['customer_id'],
            key: 'customer_id',
            used_key_parts: ['customer_id'],
            ref: ['shop.c.id'],
            rows_examined_per_scan: 2,
            filtered: '50.00',
            cost_info: { read_cost: '1.00', eval_cost: '0.60', prefix_cost: '2.55', data_read_per_join: '96' },
            attached_condition: '(`shop`.`o`.`total` > 10)',
          },
        },
      ],
    },
  },
})

describe('parseMysqlJsonPlan', () => {
  it('walks query block, operations and tables into a tree', () => {
    const plan = parseMysqlJsonPlan(MYSQL_JSON)

    expect(plan.engine).toBe('mysql')
    expect(plan.analyzed).toBe(false)
    expect(plan.root.label).toBe('Query block #1')
    expect(plan.root.cost).toBe(2.55)

    const sort = plan.root.children[0]!
    expect(sort.label).toBe('Sort')
    expect(sort.extras['using_filesort']).toBe(true)

    const loop = sort.children[0]!
    expect(loop.label).toBe('Nested loop')
    expect(loop.children.map((node) => node.label)).toEqual(['c (ALL)', 'o (ref)'])

    const orders = loop.children[1]!
    expect(orders.detail).toBe('using customer_id · ref shop.c.id · where (`shop`.`o`.`total` > 10)')
    expect(orders.estimatedRows).toBe(2)
    expect(orders.cost).toBeCloseTo(1.6)
    expect(orders.extras['filtered']).toBe('50.00')
    expect(orders.extras['possible_keys']).toBe('customer_id')
    expect(orders.extras['cost_info.prefix_cost']).toBe('2.55')
    expect(orders.extras).not.toHaveProperty('table_name')
  })

  it('reads the actual figures of a MariaDB ANALYZE', () => {
    const plan = parseMysqlJsonPlan(JSON.stringify({
      query_block: {
        select_id: 1,
        r_loops: 1,
        r_total_time_ms: 0.8,
        table: {
          table_name: 't',
          access_type: 'ALL',
          r_loops: 1,
          rows: 100,
          r_rows: 250,
          r_total_time_ms: 0.5,
          filtered: '100.00',
          r_filtered: '100.00',
        },
      },
    }))

    expect(plan.analyzed).toBe(true)
    expect(plan.root.totalMs).toBe(0.8)
    expect(plan.root.selfMs).toBeCloseTo(0.3)
    expect(plan.root.children[0]!.actualRows).toBe(250)
  })

  it('hangs a materialized subquery under its table', () => {
    const plan = parseMysqlJsonPlan(JSON.stringify({
      query_block: {
        table: {
          table_name: '<derived2>',
          access_type: 'ALL',
          materialized_from_subquery: {
            using_temporary_table: true,
            query_block: { select_id: 2, table: { table_name: 'u', access_type: 'index' } },
          },
        },
      },
    }))

    const derived = plan.root.children[0]!
    expect(derived.label).toBe('<derived2> (ALL)')
    expect(derived.children[0]!.label).toBe('Materialize')
    expect(derived.children[0]!.children[0]!.label).toBe('Query block #2')
    expect(derived.children[0]!.children[0]!.children[0]!.label).toBe('u (index)')
  })

  it('refuses something that is not a plan', () => {
    expect(() => parseMysqlJsonPlan('{"a": 1}')).toThrow(/Not a MySQL JSON plan/)
  })
})

const MYSQL_TREE = [
  '-> Nested loop inner join  (cost=1.05 rows=2) (actual time=0.054..0.061 rows=2 loops=1)',
  '    -> Filter: (t1.a > 1)  (cost=0.35 rows=2) (actual time=0.037..0.040 rows=2 loops=1)',
  '        -> Table scan on t1  (cost=0.35 rows=3) (actual time=0.030..0.035 rows=3 loops=1)',
  '    -> Index lookup on t2 using idx (a=t1.a)  (cost=0.35 rows=1) (actual time=0.008..0.009 rows=1 loops=2)',
].join('\n')

describe('parseMysqlAnalyzeTree', () => {
  it('builds the tree from indentation and reads both parentheses', () => {
    const plan = parseMysqlAnalyzeTree(MYSQL_TREE)

    expect(plan.analyzed).toBe(true)
    const root = plan.root
    expect(root.label).toBe('Nested loop inner join')
    expect(root.cost).toBe(1.05)
    expect(root.estimatedRows).toBe(2)
    expect(root.actualRows).toBe(2)
    expect(root.startupMs).toBe(0.054)
    expect(root.totalMs).toBe(0.061)
    expect(root.children).toHaveLength(2)

    const filter = root.children[0]!
    expect(filter.label).toBe('Filter')
    expect(filter.detail).toBe('(t1.a > 1)')
    expect(filter.children[0]!.label).toBe('Table scan')
    expect(filter.children[0]!.detail).toBe('on t1')

    const lookup = root.children[1]!
    expect(lookup.label).toBe('Index lookup')
    expect(lookup.detail).toBe('on t2 using idx (a=t1.a)')
    expect(lookup.loops).toBe(2)
    // Two loops of 0.009 come off the parent's 0.061, as does the filter's 0.040.
    expect(root.selfMs).toBeCloseTo(0.061 - 0.040 - 0.018)
  })

  it('marks a branch that never ran', () => {
    const plan = parseMysqlAnalyzeTree('-> Table scan on t  (cost=0.35 rows=3) (never executed)')
    expect(plan.root.actualRows).toBe(0)
    expect(plan.root.extras['never executed']).toBe(true)
    expect(plan.root.totalMs).toBeUndefined()
  })

  it('refuses text with no plan lines', () => {
    expect(() => parseMysqlAnalyzeTree('id\tselect_type\ttable')).toThrow(/Not a MySQL EXPLAIN ANALYZE tree/)
  })
})

const SQLITE_ROWS = [
  [3, 0, 0, 'SCAN o'],
  [8, 0, 0, 'SEARCH c USING INTEGER PRIMARY KEY (rowid=?)'],
  [20, 0, 0, 'USE TEMP B-TREE FOR ORDER BY'],
]

describe('parseSqliteQueryPlan', () => {
  it('groups several top-level rows under a synthetic root', () => {
    const plan = parseSqliteQueryPlan(SQLITE_ROWS)

    expect(plan.engine).toBe('sqlite')
    expect(plan.analyzed).toBe(false)
    expect(plan.root.label).toBe('Query')
    expect(plan.root.children.map((node) => node.label)).toEqual([
      'SCAN o',
      'SEARCH c USING INTEGER PRIMARY KEY (rowid=?)',
      'USE TEMP B-TREE FOR ORDER BY',
    ])
    expect(plan.root.children[0]!.extras['id']).toBe(3)
    expect(plan.raw).toContain('3  0  0  SCAN o')
  })

  it('nests by parent id and uses a lone top-level row as the root', () => {
    const plan = parseSqliteQueryPlan([
      [2, 0, 0, 'CO-ROUTINE sub'],
      [5, 2, 0, 'SCAN t'],
      [9, 0, 0, 'SCAN sub'],
    ])

    expect(plan.root.label).toBe('Query')
    expect(plan.root.children[0]!.children[0]!.label).toBe('SCAN t')

    const single = parseSqliteQueryPlan([[2, 0, 0, 'SCAN t']])
    expect(single.root.label).toBe('SCAN t')
  })

  it('refuses rows without ids', () => {
    expect(() => parseSqliteQueryPlan([['addr', 'opcode']])).toThrow(/Not a SQLite query plan/)
  })
})

describe('parsePlanResult', () => {
  it('routes each engine and mode to its reader', () => {
    expect(parsePlanResult('postgres', true, [[PG_ANALYZE]]).root.label).toBe('Hash Left Join')
    expect(parsePlanResult('mysql', false, [[MYSQL_JSON]]).root.label).toBe('Query block #1')
    expect(parsePlanResult('mysql', true, [[MYSQL_TREE]]).root.label).toBe('Nested loop inner join')
    expect(parsePlanResult('mariadb', true, [[MYSQL_JSON]]).engine).toBe('mysql')
    expect(parsePlanResult('sqlite', false, SQLITE_ROWS).root.label).toBe('Query')
    expect(() => parsePlanResult('oracle', false, [])).toThrow(/No plan reader/)
  })

  it('joins a plan that came back as one row per line', () => {
    const plan = parsePlanResult('mysql', true, MYSQL_TREE.split('\n').map((line) => [line]))
    expect(plan.root.children).toHaveLength(2)
  })
})

describe('flattenPlan', () => {
  it('lists parents before children, in document order', () => {
    const plan = parsePostgresJsonPlan(PG_ANALYZE)
    expect(flattenPlan(plan.root).map((node) => node.label)).toEqual(['Hash Left Join', 'Seq Scan', 'Hash', 'Index Scan'])
  })
})
