// The session's plan map: a mermaid `graph TD` block the teacher writes with
// the plan tool, parsed into a dependency tree. Statuses are derived from the
// nodeId tags on quiz/explain calls, never declared. Ported from LearnHarness
// (src/agent/tools/mermaid-plan.ts, src/core/contracts/plan.ts), AGPL-3.0.
// Pure: no `$`, so tests exercise it directly.

export interface PlanNode {
  id: string
  title: string
}

export interface PlanEdge {
  from: string // prerequisite
  to: string
}

export interface PlanTree {
  nodes: PlanNode[]
  edges: PlanEdge[]
  revision: number
}

export type PlanStatus = 'current' | 'visited' | 'upcoming'

const HEADER_RE = /^(graph|flowchart)\s+(td|tb|lr|rl|bt)\s*;?$/i
const SLUG_RE = /^[a-z0-9]+([_-][a-z0-9]+)*$/
const ARROW_RE = /-->|==>|-\.->/
const ENDPOINT_RE = /^([^\s()[\]]+)\s*(?:\[([^[\]]*)\]|\(\s*"([^"]*)"\s*\)|\(([^()]*)\))?$/

interface Endpoint {
  id: string
  label: string
}

function parseEndpoint(text: string): Endpoint | null {
  const m = text.trim().replace(/;$/, '').match(ENDPOINT_RE)
  if (!m?.[1]) return null
  let label = (m[2] ?? m[3] ?? m[4] ?? '').trim()
  if (label.length >= 2 && /^(["']).*\1$/.test(label)) label = label.slice(1, -1).trim()
  return { id: m[1], label }
}

// Every problem is collected, each with its line number, so one retry fixes all.
export function parsePlan(mermaid: string): { ok: true; nodes: PlanNode[]; edges: PlanEdge[] } | { ok: false; problems: string[] } {
  const text = mermaid.replace(/^\s*```(?:mermaid)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '')
  const lines = text.split(/\r?\n/)
  const problems: string[] = []
  const first = lines.findIndex(l => l.trim() && !l.trim().startsWith('%%'))
  if (first === -1) return { ok: false, problems: ['The plan is empty: expected a `graph TD` block with nodes and `-->` edges.'] }
  const header = lines[first]!.trim()
  if (!HEADER_RE.test(header)) problems.push(`line ${first + 1}: expected the header \`graph TD\` first, got \`${header}\`.`)

  const titles = new Map<string, string>()
  const edges: PlanEdge[] = []
  const seen = new Set<string>()
  const register = ({ id, label }: Endpoint, no: number): boolean => {
    if (!SLUG_RE.test(id)) {
      problems.push(`line ${no}: node id \`${id}\` must be a lowercase slug (a-z, 0-9, joined by hyphens or underscores, e.g. \`chain-rule\`); quizzes reference it by nodeId.`)
      return false
    }
    if (!titles.has(id) || (label && titles.get(id) === id)) titles.set(id, label || titles.get(id) || id)
    return true
  }

  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    const no = i + 1
    if (!line || line.startsWith('%%')) continue
    if (/^(classDef|class|style|linkStyle|click|subgraph|end)\b/.test(line)) {
      problems.push(`line ${no}: \`${line.split(/\s/)[0]}\` is not part of the plan subset; use only node lines and \`-->\` edges.`)
      continue
    }
    const segments = line.split(ARROW_RE)
    if (segments.length >= 2) {
      const ends = segments.map(parseEndpoint)
      if (ends.some(e => !e)) {
        problems.push(`line ${no}: can't read the edge \`${line}\`; expected \`a[title] --> b[title]\` (chains like \`a --> b --> c\` are fine).`)
        continue
      }
      const ok = (ends as Endpoint[]).map(e => register(e, no))
      for (let k = 0; k + 1 < ends.length; k++) {
        if (!ok[k] || !ok[k + 1]) continue
        const from = ends[k]!.id
        const to = ends[k + 1]!.id
        if (from === to) {
          problems.push(`line ${no}: self-loop \`${from} --> ${to}\`; a node can't require itself.`)
          continue
        }
        if (!seen.has(`${from}>${to}`)) {
          seen.add(`${from}>${to}`)
          edges.push({ from, to })
        }
      }
    } else {
      const node = parseEndpoint(line)
      if (!node) {
        problems.push(`line ${no}: can't parse \`${line}\`; use node lines (\`slug[Title]\`) and edges (\`a --> b\`).`)
        continue
      }
      register(node, no)
    }
  }

  const nodes = [...titles].map(([id, title]) => ({ id, title }))
  if (!problems.length && !nodes.length) problems.push('No nodes found; the plan needs at least one.')
  if (!problems.length) {
    const cycle = findCycle(nodes, edges)
    if (cycle) problems.push(`the edges form a cycle (${cycle.join(' --> ')}); a requires-graph must be acyclic.`)
  }
  return problems.length ? { ok: false, problems } : { ok: true, nodes, edges }
}

function findCycle(nodes: PlanNode[], edges: PlanEdge[]): string[] | null {
  const out = new Map<string, string[]>(nodes.map(n => [n.id, []]))
  for (const e of edges) out.get(e.from)!.push(e.to)
  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    state.set(id, 1)
    stack.push(id)
    for (const next of out.get(id) ?? []) {
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next]
      if (!state.has(next)) {
        const found = visit(next)
        if (found) return found
      }
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const n of nodes) {
    if (!state.has(n.id)) {
      const found = visit(n.id)
      if (found) return found
    }
  }
  return null
}

// Position comes from calls, never results: current is the node of the most
// recent tagged question, visited every node left before it. Tags on nodes a
// rewrite dropped move nothing.
export function planStatuses(tree: PlanTree, tags: readonly string[]): Map<string, PlanStatus> {
  const ids = new Set(tree.nodes.map(n => n.id))
  const runs: string[] = []
  for (const tag of tags) if (ids.has(tag) && runs.at(-1) !== tag) runs.push(tag)
  const current = runs.at(-1)
  const visited = new Set(runs.slice(0, -1))
  return new Map(tree.nodes.map(n => [n.id, n.id === current ? 'current' : visited.has(n.id) ? 'visited' : 'upcoming']))
}

// Nodes in dependency order (roots first), stable on the authored order.
export function topoOrder(tree: PlanTree): PlanNode[] {
  const indegree = new Map(tree.nodes.map(n => [n.id, 0]))
  for (const e of tree.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
  const order: PlanNode[] = []
  const done = new Set<string>()
  while (order.length < tree.nodes.length) {
    const next = tree.nodes.find(n => !done.has(n.id) && indegree.get(n.id) === 0)
    if (!next) break // a cycle; parsePlan never stores one
    order.push(next)
    done.add(next.id)
    for (const e of tree.edges) if (e.from === next.id) indegree.set(e.to, indegree.get(e.to)! - 1)
  }
  return order
}

const MARK: Record<PlanStatus, string> = { current: '●', visited: '✓', upcoming: '○' }

// The plan as text lines: one node per line with its status and prerequisites.
export function planLines(tree: PlanTree, statuses: Map<string, PlanStatus>): string[] {
  const titles = new Map(tree.nodes.map(n => [n.id, n.title]))
  return topoOrder(tree).map(n => {
    const needs = tree.edges.filter(e => e.to === n.id).map(e => titles.get(e.from) ?? e.from)
    return `${MARK[statuses.get(n.id) ?? 'upcoming']} ${n.title}${needs.length ? `  ← ${needs.join(', ')}` : ''}`
  })
}

// The plan as a mermaid block for the Obsidian note, statuses as classes.
export function planMermaid(tree: PlanTree, statuses: Map<string, PlanStatus>): string {
  const quote = (s: string) => `"${s.replace(/"/g, '#quot;')}"`
  const lines = ['graph TD']
  for (const n of tree.nodes) lines.push(`  ${n.id}[${quote(n.title)}]:::${statuses.get(n.id) ?? 'upcoming'}`)
  for (const e of tree.edges) lines.push(`  ${e.from} --> ${e.to}`)
  lines.push(
    '  classDef current fill:#fde68a,stroke:#b45309,stroke-width:2px',
    '  classDef visited fill:#d1fae5,stroke:#047857',
    '  classDef upcoming fill:#f3f4f6,stroke:#9ca3af',
  )
  return ['```mermaid', ...lines, '```'].join('\n')
}

export function planSummary(tree: PlanTree, statuses: Map<string, PlanStatus>): string {
  const current = tree.nodes.find(n => statuses.get(n.id) === 'current')
  const passed = [...statuses.values()].filter(s => s !== 'upcoming').length
  return current ? `plan ${passed}/${tree.nodes.length}: ${current.title}` : `plan 0/${tree.nodes.length}`
}
