// The persistent knowledge graph: propositions and the reasoning chains that
// derive them, accumulated across sessions and imported notes. The record
// format, merge rules and extraction prompts are ported from LearnHarness
// (skills/learnharness/references/data-format.md,
// src/agent/subagents/extraction.ts), AGPL-3.0. Pure: no `$`.

export interface Provenance {
  chatId: string // the source: a session id, or a notes source id (src_…)
  messageId: string // the passage within it; '' for notes
}

export interface NodeLine {
  id: string
  name: string
  statement: string
  aliases: string[]
  createdAt: string
  provenance: Provenance[]
}

export interface ChainLine {
  id: string
  premises: string[] // used TOGETHER
  conclusion: string
  createdAt: string
  provenance: Provenance[]
}

export interface Source {
  id: string
  kind: 'chat' | 'file'
  name: string
  note?: string // the session's lesson note, or the imported file
  createdAt: string
  updatedAt: string
}

export interface Graph {
  nodes: NodeLine[]
  chains: ChainLine[]
}

// --- reading the ledgers ---

export function parseJsonl<T>(text: string): T[] {
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // a torn last line from an interrupted write: skip it
    }
  }
  return out
}

const ptKey = (p: Provenance) => `${p.chatId}\u0000${p.messageId}`

function unionProvenance(into: Provenance[], from: readonly Provenance[]) {
  const seen = new Set(into.map(ptKey))
  for (const p of from ?? []) {
    if (!seen.has(ptKey(p))) {
      seen.add(ptKey(p))
      into.push(p)
    }
  }
}

// IDs repeat: the first line for an id defines name, statement and date;
// later statements and aliases join the aliases; provenance unions. Chains
// merge by their sorted premises plus conclusion, keeping the first id.
export function mergeGraph(nodeLines: readonly NodeLine[], chainLines: readonly ChainLine[]): Graph {
  const nodes = new Map<string, NodeLine>()
  for (const line of nodeLines) {
    if (!line?.id) continue
    const have = nodes.get(line.id)
    if (!have) {
      nodes.set(line.id, { ...line, aliases: [...(line.aliases ?? [])], provenance: [...(line.provenance ?? [])] })
      continue
    }
    for (const alias of [line.statement, ...(line.aliases ?? [])]) {
      if (alias?.trim() && alias !== have.statement && !have.aliases.includes(alias)) have.aliases.push(alias)
    }
    unionProvenance(have.provenance, line.provenance)
  }
  const chains = new Map<string, ChainLine>()
  for (const line of chainLines) {
    if (!line?.conclusion || !Array.isArray(line.premises)) continue
    const key = `${[...line.premises].sort().join('+')}=>${line.conclusion}`
    const have = chains.get(key)
    if (!have) chains.set(key, { ...line, premises: [...line.premises], provenance: [...(line.provenance ?? [])] })
    else unionProvenance(have.provenance, line.provenance)
  }
  return { nodes: [...nodes.values()], chains: [...chains.values()] }
}

// A node's birth source is its first surviving provenance point.
export const birthSource = (n: NodeLine) => n.provenance[0]?.chatId

// --- the readers the teacher and practice tools serve ---

export function globMatch(pattern: string, text: string): boolean {
  const raw = pattern.includes('*') ? pattern : `*${pattern}*`
  const re = new RegExp(`^${raw.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '*' ? '[\\s\\S]*' : `\\${ch}`))}$`, 'i')
  return re.test(text)
}

export function sessionIndex(graph: Graph, sources: Record<string, Source>): Array<Source & { propositions: number }> {
  const counts = new Map<string, number>()
  for (const n of graph.nodes) {
    const born = birthSource(n)
    if (born) counts.set(born, (counts.get(born) ?? 0) + 1)
  }
  return [...counts]
    .map(([id, propositions]) => {
      const s = sources[id]
      return { id, kind: s?.kind ?? (id.startsWith('src_') ? 'file' : 'chat'), name: s?.name ?? id, note: s?.note, createdAt: s?.createdAt ?? '', updatedAt: s?.updatedAt ?? '', propositions }
    })
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
}

export function listSessionsText(graph: Graph, sources: Record<string, Source>): string {
  const index = sessionIndex(graph, sources)
  if (!index.length) return 'The knowledge graph is empty: no session has contributed propositions yet.'
  const lines = index.map(
    (s, i) =>
      `${i + 1}. ${s.name} (${s.kind}, ${s.propositions} proposition${s.propositions === 1 ? '' : 's'}, born ${s.createdAt.slice(0, 10) || 'unknown date'}${s.updatedAt && s.updatedAt !== s.createdAt ? `, last active ${s.updatedAt.slice(0, 10)}` : ''}) — id: ${s.id}`,
  )
  return `${index.length} session(s) in the knowledge graph, most recent first:\n${lines.join('\n')}`
}

function nodeText(n: NodeLine): string {
  return `- ${n.id} :: ${n.name}\n  statement: ${n.statement.replace(/\s+/g, ' ')}`
}

export function listPropositionsText(graph: Graph, session: string): string {
  const born = graph.nodes.filter(n => birthSource(n) === session)
  if (!born.length) return `No propositions born in session "${session}". Call graph_sessions for the current ids.`
  return `${born.length} proposition(s) born in this session:\n${born.map(nodeText).join('\n')}`
}

export function findText(graph: Graph, query: string): string {
  const hits = graph.nodes.filter(n => globMatch(query, n.name) || globMatch(query, n.statement) || n.aliases.some(a => globMatch(query, a)))
  if (!hits.length) return `No proposition matches "${query}".`
  const names = new Map(graph.nodes.map(n => [n.id, n.name]))
  const lines = hits.slice(0, 60).map(n => {
    const derived = graph.chains.filter(c => c.conclusion === n.id).map(c => c.premises.map(p => names.get(p) ?? p).join(' + '))
    return `${nodeText(n)}\n  born in: ${birthSource(n) ?? '(none)'}${derived.length ? `\n  follows from: ${derived.join(' | ')}` : ''}`
  })
  return `${hits.length} match(es)${hits.length > 60 ? ' (first 60)' : ''}:\n${lines.join('\n')}`
}

// --- extraction ---

export interface Passage {
  messageId: string
  text: string
}

const SESSION_PREAMBLE =
  'You are the extraction stage of a learning application. You read one stretch of a source — a teaching ' +
  "session, rendered as the teacher's prose in reading order — and report what it teaches as findings " +
  "for the learner's global knowledge graph, building on everything already extracted from this source."

const NOTES_PREAMBLE =
  'You are the extraction stage of a learning application. You read one stretch of a source — the ' +
  "author's personal notes, rendered in reading order — and report what it teaches as findings for the " +
  "learner's global knowledge graph, building on everything already extracted from this source."

const EXTRACTION_CORE = `THE GOAL: uncover the source's CORE IDEAS and show how everything derives from the foundations. The
source teaches by arguing — ideas worked out from other ideas, down to a foundation the rest stands on.
Your deliverable is twofold: the core ideas themselves, and the chains of reasoning that derive them.
Each chain is premises that JOINTLY entail a conclusion. Entailment is the only link that earns a
chain — where the real connection is historical or narrative (who argued what, how a debate or
exposition unfolds), there is no chain; keep the pieces as bare ideas or drop them. The direction of
the graph is upward: foundational ideas at the bottom, derived ideas above them, each chain showing
how its conclusion follows from what is more established — do not submit connections that carry no
derivation.

The graph holds TRUE ideas about the world, nothing else — never anything about the learner, the
teacher, or this reading: not "the learner understands X" but X. A misconception enters as its TRUE
correction. Each statement is one self-contained idea at full precision.

Extract the load-bearing ideas of the subject — what a reference on it would teach — not the full run
of the discourse. An idea earns its place only when the source's arguments run through it — examples,
notation glosses, and restatements that no argument needs are not core ideas. Every idea must stand
alone for a reader who never saw this source: names and statements may not lean on the source's own
scaffolding (claim numbering, axiom tags, arc labels); a claim that only matters as part of how this
document is organized is not knowledge — drop it.

When the prompt carries THE GRAPH SO FAR, you are continuing a source already partly extracted: build
on it. Reference an existing idea by its id ("n_…") instead of restating it, and prefer chains that
lean on established conclusions as premises — derive new material from what is already derived. Do
not re-derive a conclusion the graph already holds unless the route is genuinely different.

Premises within one chain are used TOGETHER — independent arguments for the same conclusion are
separate chains. A conclusion may reappear, by id, as a premise of later chains. A bare idea that no
argument uses rides the propositions list alone. Write math in LaTeX ($...$).`

const OUTPUT_RULES = (withMessageIds: boolean) => `OUTPUT: reply with exactly one JSON object in a \`\`\`json fenced block and nothing else:
{"propositions":[{"id":"p1","name":"Short name","statement":"The full self-contained claim."${withMessageIds ? ',"messageId":"m_…"' : ''}}],
 "chains":[{"premises":["p1","n_…"],"conclusion":"p2"}]}
- "id" is a local id you choose ("p1", "p2", …), unique in this reply. Existing ideas from THE GRAPH SO FAR are referenced by their "n_…" id verbatim and never declared again.
- A chain's premises and conclusion are local ids from this reply or existing "n_…" ids; the conclusion is never one of its own premises.${
  withMessageIds ? '\n- "messageId" is the [m_…] tag of the passage that teaches the idea, copied exactly; every passage tag in this stretch is valid.' : ''
}
- Include both arrays even when empty: "chains": [] when the source makes no arguments. JSON strings escape LaTeX backslashes as \\\\.`

export function extractorSystem(kind: 'chat' | 'file'): string {
  return [kind === 'chat' ? SESSION_PREAMBLE : NOTES_PREAMBLE, EXTRACTION_CORE, OUTPUT_RULES(kind === 'chat')].join('\n\n')
}

// Everything already extracted from this source, so a later stretch builds on it.
export function sourceDigest(graph: Graph, sourceId: string): string {
  const names = new Map(graph.nodes.map(n => [n.id, n.name]))
  const ours = graph.nodes.filter(n => n.provenance.some(p => p.chatId === sourceId))
  const chains = graph.chains.filter(c => c.provenance.some(p => p.chatId === sourceId))
  if (!ours.length && !chains.length) return ''
  const lines = ['THE GRAPH SO FAR — everything already extracted from this source (reference these ids verbatim):']
  for (const n of ours) lines.push(`  ${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, ' ')}`)
  if (chains.length) {
    lines.push('DERIVATIONS ALREADY RECORDED (build on these; do not re-derive them):')
    for (const c of chains) {
      lines.push(`  [${c.premises.join(' + ')} ⇒ ${c.conclusion}]  ${c.premises.map(p => names.get(p) ?? p).join(' ∧ ')} ⇒ ${names.get(c.conclusion) ?? c.conclusion}`)
    }
  }
  return lines.join('\n')
}

export function extractorPrompt(digest: string, passages: readonly Passage[], kind: 'chat' | 'file'): string {
  const body = kind === 'chat' ? passages.map(p => `[${p.messageId}]\n${p.text}`).join('\n\n') : passages.map(p => p.text).join('\n\n')
  const heading = kind === 'chat' ? "THE STRETCH — the teacher's prose in reading order, each passage under its tag:" : 'THE STRETCH — the notes in reading order:'
  return [digest, heading, body].filter(Boolean).join('\n\n')
}

// Batches of passages under a character budget, in order.
export function batchPassages(passages: readonly Passage[], budget = 60_000): Passage[][] {
  const batches: Passage[][] = []
  let cur: Passage[] = []
  let size = 0
  for (const p of passages) {
    if (cur.length && size + p.text.length > budget) {
      batches.push(cur)
      cur = []
      size = 0
    }
    cur.push(p)
    size += p.text.length
  }
  if (cur.length) batches.push(cur)
  return batches
}

export interface Findings {
  propositions: Array<{ id: string; name: string; statement: string; messageId?: string }>
  chains: Array<{ premises: string[]; conclusion: string }>
}

// The reply's JSON: the fenced block if there is one, else the outermost braces.
export function parseJsonReply(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(text)
  const raw = fenced?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  return JSON.parse(raw)
}

export function validateFindings(value: unknown, existingIds: ReadonlySet<string>, messageIds?: ReadonlySet<string>): { findings?: Findings; problems: string[] } {
  const problems: string[] = []
  const v = value as Partial<Findings> | null
  if (!v || typeof v !== 'object' || !Array.isArray(v.propositions) || !Array.isArray(v.chains)) {
    return { problems: ['the reply must be an object with "propositions" and "chains" arrays'] }
  }
  const local = new Set<string>()
  for (const [i, p] of v.propositions.entries()) {
    if (!p || typeof p.id !== 'string' || !p.id.trim()) problems.push(`propositions[${i}] has no "id"`)
    else if (existingIds.has(p.id)) problems.push(`propositions[${i}] re-declares existing id "${p.id}"; reference it from chains instead`)
    else if (local.has(p.id)) problems.push(`propositions[${i}] repeats id "${p.id}"`)
    else local.add(p.id)
    if (!p?.name?.trim?.() || !p?.statement?.trim?.()) problems.push(`propositions[${i}] needs a non-empty "name" and "statement"`)
    if (messageIds && !messageIds.has(String(p?.messageId ?? ''))) problems.push(`propositions[${i}] "messageId" ${JSON.stringify(p?.messageId ?? null)} is not one of this stretch's passage tags`)
  }
  const known = (id: unknown) => typeof id === 'string' && (local.has(id) || existingIds.has(id))
  for (const [i, c] of v.chains.entries()) {
    if (!c || !Array.isArray(c.premises) || !c.premises.length) {
      problems.push(`chains[${i}] needs a non-empty "premises" array`)
      continue
    }
    for (const id of [...c.premises, c.conclusion]) if (!known(id)) problems.push(`chains[${i}] names unknown id ${JSON.stringify(id)}`)
    if (c.premises.includes(c.conclusion)) problems.push(`chains[${i}] lists its conclusion among its premises`)
  }
  return problems.length ? { problems } : { findings: v as Findings, problems }
}

// --- linking new findings to the graph (identity, never relations) ---

export const LINKER_SYSTEM = `You are the linking stage of a learning application's extraction pipeline. An extractor has read a
source (a teaching session, or the author's personal notes) and reported findings: propositions. You
never see the source itself: the extractor is fully trusted, and you do not re-check its work. Your
job is IDENTITY: connecting those findings to the CURRENT knowledge graph, preparing the merge.

For each new proposition: does an EXISTING node in the candidate list already state this same
proposition? If yes, add { "id": <the new proposition's id>, "linkTo": <that node's id> } to "links";
the new phrasing joins the node's aliases and provenance. If no, add nothing: a new node is created.

EQUIVALENCE BIAS: paraphrases, rewordings, and compressions of the same claim MERGE. When two
statements are the same claim at different precision or from different angles, LINK them. Only
genuinely distinct propositions — different claims about the world — stay apart. You are not
guarding against wrong merges; you are hunting for right ones.

Your deliverable is ONLY the identity verdicts. Never restate the propositions and never create
relations between them. Reply with exactly one JSON object in a \`\`\`json fenced block:
{"links":[{"id":"p1","linkTo":"n_…"}]}, with "links": [] when nothing links.`

// The existing nodes worth showing the linker: all of them while the graph is
// small, else the ones sharing the most words with the new findings.
export function linkCandidates(graph: Graph, findings: Findings, limit = 250): NodeLine[] {
  if (graph.nodes.length <= limit) return graph.nodes
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? [])
  const wanted = words(findings.propositions.map(p => `${p.name} ${p.statement}`).join(' '))
  return graph.nodes
    .map(n => ({ n, score: [...words(`${n.name} ${n.statement} ${n.aliases.join(' ')}`)].filter(w => wanted.has(w)).length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.n)
}

export function linkerPrompt(findings: Findings, candidates: readonly NodeLine[]): string {
  return [
    'NEW PROPOSITIONS:',
    ...findings.propositions.map(p => `  ${p.id} | ${p.name} | ${p.statement.replace(/\s+/g, ' ')}`),
    '',
    'EXISTING NODES (the candidates):',
    ...(candidates.length ? candidates.map(n => `  ${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, ' ')}`) : ['  (none: the graph is empty)']),
  ].join('\n')
}

export function validLinks(value: unknown, findings: Findings, existingIds: ReadonlySet<string>): Map<string, string> {
  const local = new Set(findings.propositions.map(p => p.id))
  const out = new Map<string, string>()
  const links = (value as { links?: unknown })?.links
  if (!Array.isArray(links)) return out
  for (const l of links) {
    if (l && local.has(l.id) && existingIds.has(l.linkTo) && !out.has(l.id)) out.set(l.id, l.linkTo)
  }
  return out
}

// The lines a batch appends: linked findings join their node; the rest get new ids.
export function applyFindings(
  findings: Findings,
  links: ReadonlyMap<string, string>,
  sourceId: string,
  now: string,
  newId: (prefix: 'n' | 'c') => string,
): { nodeLines: NodeLine[]; chainLines: ChainLine[] } {
  const finalId = new Map<string, string>()
  const nodeLines: NodeLine[] = []
  for (const p of findings.propositions) {
    const id = links.get(p.id) ?? newId('n')
    finalId.set(p.id, id)
    nodeLines.push({ id, name: p.name.trim(), statement: p.statement.trim(), aliases: [], createdAt: now, provenance: [{ chatId: sourceId, messageId: p.messageId ?? '' }] })
  }
  const resolve = (id: string) => finalId.get(id) ?? id
  const chainLines: ChainLine[] = []
  for (const c of findings.chains) {
    const conclusion = resolve(c.conclusion)
    const premises = [...new Set(c.premises.map(resolve))].filter(p => p !== conclusion)
    if (!premises.length) continue
    const messageId = findings.propositions.find(p => p.id === c.conclusion)?.messageId ?? ''
    chainLines.push({ id: newId('c'), premises, conclusion, createdAt: now, provenance: [{ chatId: sourceId, messageId }] })
  }
  return { nodeLines, chainLines }
}

// --- Obsidian notes: one per proposition, linked to its premises ---

export function noteNames(graph: Graph): Map<string, string> {
  const clean = (s: string) =>
    s
      .replace(/\$+/g, '')
      .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .trim() || 'proposition'
  const byName = new Map<string, number>()
  for (const n of graph.nodes) byName.set(clean(n.name).toLowerCase(), (byName.get(clean(n.name).toLowerCase()) ?? 0) + 1)
  return new Map(graph.nodes.map(n => {
    const base = clean(n.name)
    return [n.id, byName.get(base.toLowerCase())! > 1 ? `${base} (${n.id.slice(2, 8)})` : base]
  }))
}

export function propositionNote(node: NodeLine, graph: Graph, names: ReadonlyMap<string, string>, sources: Record<string, Source>): string {
  const link = (id: string) => (names.has(id) ? `[[${names.get(id)}]]` : id)
  const lines = ['---', `id: ${node.id}`, 'tags:', '  - proposition', '---', '', node.statement, '']
  const derivations = graph.chains.filter(c => c.conclusion === node.id)
  if (derivations.length) lines.push('**Follows from**', ...derivations.map(c => `- ${c.premises.map(link).join(' + ')}`), '')
  if (node.aliases.length) lines.push('**Also stated as**', ...node.aliases.map(a => `- ${a.replace(/\n+/g, ' ')}`), '')
  const seen = new Set<string>()
  const learned: string[] = []
  for (const p of node.provenance) {
    if (seen.has(p.chatId)) continue
    seen.add(p.chatId)
    const s = sources[p.chatId]
    const where = s?.note ? `[[${s.note.slice(s.note.lastIndexOf('/') + 1).replace(/\.md$/, '')}]]` : (s?.name ?? p.chatId)
    learned.push(`- ${where}${s?.createdAt ? ` · ${s.createdAt.slice(0, 10)}` : ''}`)
  }
  if (learned.length) lines.push('**Learned in**', ...learned, '')
  return lines.join('\n')
}

// --- what a session teaches: the teacher's prose, in reading order ---

interface Row {
  role: 'user' | 'assistant'
  text: string
  toolUses: Array<{ tool: string; input: Record<string, unknown> }>
}

const QUIZ_TOOLS = new Set(['mcp__learn__quiz', 'mcp__learn__explain', 'mcp__learn__probe', 'mcp__learn__recall'])
const FREE_RECALL = new Set(['mcp__learn__explain', 'mcp__learn__recall'])

// Assistant prose, plus the reasoning committed in quiz explanations and
// explain answers (teaching too). Practice sessions add nothing: practice
// exercises held knowledge, it never teaches new propositions.
export function teachingTexts(rows: readonly Row[]): string[] {
  const out: string[] = []
  for (const row of rows) {
    if (row.role !== 'assistant') continue
    if (row.text.trim()) out.push(row.text.trim())
    for (const use of row.toolUses ?? []) {
      if (!QUIZ_TOOLS.has(use.tool)) continue
      const i = use.input as { question?: string; explanation?: string; correctAnswer?: unknown; options?: Array<{ label?: string; value?: string }> }
      const reasoning = FREE_RECALL.has(use.tool) ? String(i.correctAnswer ?? '') : String(i.explanation ?? '')
      if (!i.question || !reasoning.trim()) continue
      const values = Array.isArray(i.correctAnswer) ? i.correctAnswer.map(String) : [String(i.correctAnswer ?? '')]
      const answer =
        FREE_RECALL.has(use.tool)
          ? ''
          : (i.options ?? []).filter(o => values.includes(String(o.value ?? o.label ?? ''))).map(o => o.label).join('; ')
      out.push([`Question: ${i.question}`, answer ? `Answer: ${answer}` : '', `Why: ${reasoning}`].filter(Boolean).join('\n'))
    }
  }
  return out
}

// Imported notes in passages: split at headings, then at blank lines past the budget.
export function notePassages(text: string, budget = 4_000): string[] {
  const sections = text.replace(/^---\n[\s\S]*?\n---\n/, '').split(/\n(?=#{1,6}\s)/)
  const out: string[] = []
  for (const section of sections) {
    let cur = ''
    for (const para of section.split(/\n{2,}/)) {
      if (cur && cur.length + para.length > budget) {
        out.push(cur.trim())
        cur = ''
      }
      cur += (cur ? '\n\n' : '') + para
    }
    if (cur.trim()) out.push(cur.trim())
  }
  return out
}
