import { expect, test } from 'claude-code/testing'

import { parsePlan, planLines, planMermaid, planStatuses, planSummary, topoOrder, type PlanTree } from './plan'

function tree(mermaid: string): PlanTree {
  const parsed = parsePlan(mermaid)
  if (!parsed.ok) throw new Error(parsed.problems.join('\n'))
  return { nodes: parsed.nodes, edges: parsed.edges, revision: 1 }
}

function problems(mermaid: string): string[] {
  const parsed = parsePlan(mermaid)
  if (parsed.ok) throw new Error('expected the plan to be refused')
  return parsed.problems
}

test('a fenced block, any direction header and comments are accepted', async () => {
  const t = tree('```mermaid\n%% the plan\nflowchart LR;\n  a[Alpha] --> b[Beta]\n```')
  expect(t.nodes).toEqual([{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }])
  expect(t.edges).toEqual([{ from: 'a', to: 'b' }])
})

test('an empty plan or a missing header is refused', async () => {
  expect(problems('')).toEqual(['The plan is empty: expected a `graph TD` block with nodes and `-->` edges.'])
  expect(problems('%% only a comment')[0]).toMatch(/empty/)
  expect(problems('a --> b')[0]).toMatch(/^line 1: expected the header `graph TD` first/)
  expect(problems('graph TD')).toEqual(['No nodes found; the plan needs at least one.'])
})

test('labels come in brackets, quotes or parentheses, and the first real label wins', async () => {
  const t = tree('graph TD\n  a --> b\n  a[Alpha]\n  b("Beta, quoted")\n  c(Gamma)\n  d["Delta"]\n  a[Ignored]')
  expect(t.nodes).toEqual([
    { id: 'a', title: 'Alpha' },
    { id: 'b', title: 'Beta, quoted' },
    { id: 'c', title: 'Gamma' },
    { id: 'd', title: 'Delta' },
  ])
  expect(tree('graph TD\n  lone').nodes).toEqual([{ id: 'lone', title: 'lone' }])
})

test('chains, arrow styles and repeated edges', async () => {
  const t = tree('graph TD\n  a --> b --> c\n  c ==> d\n  d -.-> e\n  a --> b')
  expect(t.edges).toEqual([
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
    { from: 'd', to: 'e' },
  ])
})

test('every problem is reported at once, each with its line', async () => {
  const found = problems('graph TD\n  Chain-Rule --> b\n  style b fill:#f00\n  subgraph x\n  a -->\n  a --> a')
  expect(found).toHaveLength(5)
  expect(found[0]).toMatch(/^line 2: node id `Chain-Rule` must be a lowercase slug/)
  expect(found[1]).toMatch(/^line 3: `style` is not part of the plan subset/)
  expect(found[2]).toMatch(/^line 4: `subgraph` is not part of the plan subset/)
  expect(found[3]).toMatch(/^line 5: can't read the edge `a -->`/)
  expect(found[4]).toMatch(/^line 6: self-loop `a --> a`/)
})

test('a cycle is refused with its path', async () => {
  expect(problems('graph TD\n  a --> b\n  b --> c\n  c --> a')).toEqual([
    'the edges form a cycle (a --> b --> c --> a); a requires-graph must be acyclic.',
  ])
})

test('statuses ignore unknown tags and follow a return to an earlier node', async () => {
  const t = tree('graph TD\n  a --> b --> c')
  const none = planStatuses(t, [])
  expect([...none.values()]).toEqual(['upcoming', 'upcoming', 'upcoming'])
  expect(planSummary(t, none)).toBe('plan 0/3')

  const back = planStatuses(t, ['a', 'dropped-node', 'b', 'b', 'a'])
  expect(back.get('a')).toBe('current')
  expect(back.get('b')).toBe('visited')
  expect(back.get('c')).toBe('upcoming')
  expect(planSummary(t, back)).toBe('plan 2/3: a')
})

test('topological order puts prerequisites first and keeps the authored order otherwise', async () => {
  const t = tree('graph TD\n  z[Zed]\n  b --> c\n  a --> c\n  a --> b')
  expect(topoOrder(t).map(n => n.id)).toEqual(['z', 'a', 'b', 'c'])
})

test('plan lines mark each status and name the prerequisites', async () => {
  const t = tree('graph TD\n  limits[Limits] --> derivative[The derivative]\n  products[Products] --> chain[Chain rule]\n  derivative --> chain')
  const lines = planLines(t, planStatuses(t, ['limits', 'derivative']))
  expect(lines).toEqual(['✓ Limits', '● The derivative  ← Limits', '○ Products', '○ Chain rule  ← Products, The derivative'])
})

test('the note mermaid carries statuses as classes and escapes quotes', async () => {
  const t = tree('graph TD\n  a[Say "hi"] --> b[Beta]')
  expect(t.nodes[0]!.title).toBe('Say "hi"')
  const block = planMermaid(t, planStatuses(t, ['a']))
  const lines = block.split('\n')
  expect(lines[0]).toBe('```mermaid')
  expect(lines.at(-1)).toBe('```')
  expect(lines).toContain('  a["Say #quot;hi#quot;"]:::current')
  expect(lines).toContain('  b["Beta"]:::upcoming')
  expect(lines).toContain('  a --> b')
  expect(block).toContain('classDef current')
})
