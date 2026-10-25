import { expect, mock, test } from 'claude-code/testing'

import { healArguments, parseConfidence, quizResultText } from './format'
import { applyFindings, mergeGraph, noteNames, propositionNote, teachingTexts, validateFindings, type NodeLine } from './graph'
import { parsePlan, planStatuses, planSummary, type PlanTree } from './plan'
import { isPluginScript, offersTool, parseQuizType, QUIZ_SCHEMA } from './tools'

const PLAN = `graph TD
  limits[Limits] --> derivative[The derivative]
  derivative --> chain-rule[The chain rule]
  products[Products] --> chain-rule`

const QUIZ = {
  question: 'What is $\\frac{d}{dx}\\sin(2x)$?',
  options: [
    { label: '$2\\cos(2x)$', value: 'a' },
    { label: '$\\cos(2x)$', value: 'b' },
  ],
  explanation: 'Chain rule.',
  correctAnswer: 'a',
  shuffle: false,
}

// A session world: an in-memory file system and store, a fixed home.
function world(on: any, answers: Record<string, string> = {}, extraRead: (path: string) => string | undefined = () => undefined) {
  mock.store(on)
  const files: Record<string, string> = {}
  const asked: string[] = []
  const logs: string[] = []
  on('session.id', () => ({ value: 'S1' }) as any)
  on('session.cwd', () => ({ value: '/home/u/elsewhere' }) as any)
  on('fs.exists', ($: any, e: any) => ({ value: e.path in files }) as any)
  on('fs.read', ($: any, e: any) => {
    const extra = extraRead(e.path)
    if (extra !== undefined) return { value: extra } as any
    if (!(e.path in files)) throw new Error(`ENOENT ${e.path}`)
    return { value: files[e.path] } as any
  })
  on('fs.write', ($: any, e: any) => {
    files[e.path] = e.text
    return { value: undefined } as any
  })
  on('process.run', ($: any, e: any) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'printenv' ? '/home/u\n' : '', stderr: '' } }) as any)
  on('ui.status', () => ({ value: undefined }) as any)
  on('ui.toast', () => ({ value: undefined }) as any)
  on('ui.log', ($: any, e: any) => {
    logs.push(e.text)
    return { value: undefined } as any
  })
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'test' } }) as any)
  on('tool.call', { tool: 'AskUserQuestion' }, ($: any, e: any) => {
    const q = e.questions[0].question as string
    asked.push(q)
    const answer = Object.entries(answers).find(([k]) => q.startsWith(k))?.[1]
    return { result: { questions: e.questions, answers: answer === undefined ? {} : { [q]: answer } } } as any
  })
  return { files, asked, logs }
}

// --- the plan map ---

test('the plan parses mermaid, refuses bad slugs and cycles, and derives position from tags', async () => {
  const parsed = parsePlan(PLAN)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) return
  expect(parsed.nodes.map(n => n.id)).toEqual(['limits', 'derivative', 'chain-rule', 'products'])
  expect(parsed.edges).toContainEqual({ from: 'products', to: 'chain-rule' })

  const bad = parsePlan('graph TD\n  Bad Slug[x] --> b\n  a --> a')
  expect(bad.ok).toBe(false)
  if (!bad.ok) expect(bad.problems.join('\n')).toMatch(/line 3: self-loop/)
  const cyclic = parsePlan('graph TD\n  a --> b\n  b --> a')
  expect(cyclic.ok).toBe(false)

  const tree: PlanTree = { nodes: parsed.nodes, edges: parsed.edges, revision: 1 }
  const statuses = planStatuses(tree, ['limits', 'limits', 'derivative'])
  expect(statuses.get('derivative')).toBe('current')
  expect(statuses.get('limits')).toBe('visited')
  expect(statuses.get('chain-rule')).toBe('upcoming')
  expect(planSummary(tree, statuses)).toBe('plan 2/4: The derivative')
})

test('once a plan exists, quizzes must name their node and role', async ($, on) => {
  world(on, { 'What is': '$2\\cos(2x)$', 'How sure': 'Likely (75%)' })
  const planned = await $.tool.call({ tool: 'mcp__learn__plan', mermaid: PLAN } as any)
  expect(String(planned.result)).toContain('"nodeIds":["limits","derivative","chain-rule","products"]')

  const untagged = await $.tool.call({ tool: 'mcp__learn__quiz', ...QUIZ } as any)
  expect(untagged.deny).toMatch(/`type` is required/)
  const wrong = await $.tool.call({ tool: 'mcp__learn__quiz', type: 'check', nodeId: 'nope', ...QUIZ } as any)
  expect(wrong.deny).toMatch(/"nope" is not a node of the plan. Valid ids: limits, derivative/)

  const ok = await $.tool.call({ tool: 'mcp__learn__quiz', type: 'check', nodeId: 'chain-rule', ...QUIZ } as any)
  expect(String(ok.result)).toContain('User answered correctly.')
  expect(String(ok.result)).toContain('Confidence: 75%')
  const shown = await $.command.run({ command: 'map' } as any)
  expect(shown.text).toContain('● The chain rule')
})

test('probe and recall serve the probe; quiz and explain serve the plan', async ($, on) => {
  world(on, { 'What is': '$2\\cos(2x)$', 'How sure': 'Likely (75%)', Why: 'Rates compose.' })
  const early = await $.tool.call({ tool: 'mcp__learn__quiz', type: 'check', nodeId: 'limits', ...QUIZ } as any)
  expect(early.deny).toMatch(/no plan exists yet. While probing \(or outside a lesson\) use probe/)
  const earlyExplain = await $.tool.call({ tool: 'mcp__learn__explain', type: 'check', nodeId: 'limits', question: 'Why?', correctAnswer: 'x' } as any)
  expect(earlyExplain.deny).toMatch(/use recall/)
  const probed = await $.tool.call({ tool: 'mcp__learn__probe', ...QUIZ } as any)
  expect(String(probed.result)).toContain('User answered correctly.')

  await $.tool.call({ tool: 'mcp__learn__plan', mermaid: PLAN } as any)
  const late = await $.tool.call({ tool: 'mcp__learn__probe', ...QUIZ } as any)
  expect(late.deny).toMatch(/this session has a plan, so graded questions go through quiz, with `type`/)
  expect(late.deny).toMatch(/limits, derivative, chain-rule, products/)
  const lateRecall = await $.tool.call({ tool: 'mcp__learn__recall', question: 'Why?', correctAnswer: 'x' } as any)
  expect(lateRecall.deny).toMatch(/go through explain/)
})

test('the quiz-type setting arms one mechanic or both', async () => {
  expect(parseQuizType(undefined)).toBe('both')
  expect(parseQuizType(' Free ')).toBe('free')
  expect(parseQuizType('nonsense')).toBe('both')
  expect(['probe', 'recall', 'quiz', 'explain'].filter(t => offersTool('choice', `mcp__learn__${t}`))).toEqual(['probe', 'quiz'])
  expect(['probe', 'recall', 'quiz', 'explain'].filter(t => offersTool('free', `mcp__learn__${t}`))).toEqual(['recall', 'explain'])
  expect(['probe', 'recall', 'quiz', 'explain'].filter(t => offersTool('both', `mcp__learn__${t}`))).toEqual(['probe', 'recall', 'quiz', 'explain'])
})

// --- the quiz: confidence and thinking ---

test('confidence comes from a level or a typed percentage with thinking', async () => {
  expect(parseConfidence('Certain (95%)')).toEqual({ confidence: 95 })
  expect(parseConfidence('60 the sign flips, I think')).toEqual({ confidence: 60, thinking: 'the sign flips, I think' })
  expect(parseConfidence('the sign flips')).toEqual({ thinking: 'the sign flips' })
  expect(parseConfidence(undefined)).toEqual({})
  const text = quizResultText({ kind: 'dont-know' }, [{ index: 1, label: 'A' }], [1], 'x', { confidence: 50 })
  expect(text).not.toContain('Confidence') // no confidence on "I don't know"
})

test('a graded pick is followed by the confidence question; "I don\'t know" is not', async ($, on) => {
  const { asked } = world(on, { 'What is': "I don't know" })
  const ran = await $.tool.call({ tool: 'mcp__learn__probe', ...QUIZ } as any)
  expect(String(ran.result)).toContain('genuine knowledge gap')
  expect(asked.length).toBe(1)
})

test('typed thinking on the confidence question reaches the model', async ($, on) => {
  world(on, { 'What is': '$\\cos(2x)$', 'How sure': '80 inner derivative is 1?' })
  const ran = await $.tool.call({ tool: 'mcp__learn__probe', ...QUIZ } as any)
  expect(String(ran.result)).toContain('User answered incorrectly.')
  expect(String(ran.result)).toContain('Confidence: 80%')
  expect(String(ran.result)).toContain('His thinking: inner derivative is 1?')
})

// --- explain, probe_done ---

test('explain grades free text against the committed answer', async ($, on) => {
  world(on, { 'Why does': 'because the inner function scales the rate' })
  const ran = await $.tool.call({ tool: 'mcp__learn__recall', question: 'Why does the chain rule multiply?', correctAnswer: 'Rates compose: dy/dx = dy/du · du/dx.' } as any)
  expect(String(ran.result)).toContain('because the inner function scales the rate')
  expect(String(ran.result)).toContain('Committed answer (he sees it now): Rates compose')
  const empty = await $.tool.call({ tool: 'mcp__learn__recall', question: 'Why?', correctAnswer: ' ' } as any)
  expect(empty.deny).toMatch(/commit to the full correct answer/)
})

test('probe_done records the assessment once', async ($, on) => {
  world(on)
  const input = { tool: 'mcp__learn__probe_done', assessment: { strands: [{ strand: 'derivatives', assessment: 'floor: power rule; ceiling: chain rule' }] } }
  const first = await $.tool.call(input as any)
  expect(String(first.result)).toContain('Plan now')
  const second = await $.tool.call(input as any)
  expect(second.deny).toMatch(/already concluded/)
})

// --- the argument heal ---

test('JSON-encoded arguments and quoted enum values are healed; free text is not', async () => {
  const raw = { type: '"check"', options: JSON.stringify(QUIZ.options), question: '["not", "parsed"]', shuffle: 'false' }
  const healed = healArguments(raw, QUIZ_SCHEMA)
  expect(healed.type).toBe('check')
  expect(healed.options).toEqual(QUIZ.options)
  expect(healed.question).toBe('["not", "parsed"]')
  expect(healed.shuffle).toBe(false)
  const fine = { type: 'predict' }
  expect(healArguments(fine, QUIZ_SCHEMA)).toBe(fine)
  expect(healArguments({ type: 'guess' }, QUIZ_SCHEMA).type).toBe('guess')
})

test('a quiz with stringified options and a quoted type is served, not refused', async ($, on) => {
  world(on, { 'What is': '$2\\cos(2x)$', 'How sure': 'Likely (75%)' })
  await $.tool.call({ tool: 'mcp__learn__plan', mermaid: PLAN } as any)
  const call = { tool: 'mcp__learn__quiz', ...QUIZ, type: '"check"', nodeId: 'chain-rule', options: JSON.stringify(QUIZ.options) }
  const ok = await $.tool.call(call as any)
  expect(String(ok.result)).toContain('User answered correctly.')
})

// --- practice ---

test('one problem at a time; conclude reveals the committed solution', async ($, on) => {
  world(on)
  const none = await $.tool.call({ tool: 'mcp__learn__conclude', outcome: 'solved', verdict: 'x', rung: null, missClass: null, retest: false } as any)
  expect(none.deny).toMatch(/No active problem/)
  const posed = await $.tool.call({ tool: 'mcp__learn__problem', statement: 'Differentiate $\\sin(x^2)$.', mode: 'recall', modelSolution: '$2x\\cos(x^2)$' } as any)
  expect(String(posed.result)).toContain('END YOUR TURN')
  const again = await $.tool.call({ tool: 'mcp__learn__problem', statement: 'x', mode: 'recall', modelSolution: 'y' } as any)
  expect(again.deny).toMatch(/already active/)
  const unknown = await $.tool.call({ tool: 'mcp__learn__problem', statement: 'x', mode: 'recall', modelSolution: 'y', target: ['n_missing'] } as any)
  expect(unknown.deny).toMatch(/already active/)
  const done = await $.tool.call({ tool: 'mcp__learn__conclude', outcome: '"solvedWithHints"', verdict: 'Right after an R1 nudge.', rung: 'R1', missClass: 'cue', retest: 'true' } as any)
  expect(String(done.result)).toContain('he now sees the committed model solution')
  expect(String(done.result)).toContain('retest')
  const target = await $.tool.call({ tool: 'mcp__learn__problem', statement: 'x', mode: 'recall', modelSolution: 'y', target: ['n_missing'] } as any)
  expect(target.deny).toMatch(/not a known proposition/)
})

test('the call row hides answers and model solutions', async ($, on) => {
  world(on)
  let drawn: any
  on('ui.render', { component: 'ToolUse' }, ($: any, e: any) => {
    drawn = e.props.input
    const { Text } = $.ui.resolve(e)
    return h(Text, null, 'row') as any
  })
  await $.ui.render({ component: 'ToolUse', surface: 'terminal', requestId: 't1', props: { tool_use_id: 't1', tool: 'mcp__learn__problem', input: { statement: 'S', mode: 'recall', modelSolution: 'SECRET' }, isRunning: true, isErrored: false, isInterrupted: false } } as any)
  expect(drawn).toEqual({ statement: 'S', mode: 'recall' })
})

// --- the knowledge graph ---

test('graph lines merge by id and chains by premises', async () => {
  const pt = (chatId: string, messageId = '') => ({ chatId, messageId })
  const nodes: NodeLine[] = [
    { id: 'n_1', name: 'Limit', statement: 'A limit is…', aliases: [], createdAt: '1', provenance: [pt('S1', 'm1')] },
    { id: 'n_1', name: 'Other name', statement: 'A limit, restated', aliases: [], createdAt: '2', provenance: [pt('S2', 'm9'), pt('S1', 'm1')] },
  ]
  const chains = [
    { id: 'c_1', premises: ['n_1', 'n_2'], conclusion: 'n_3', createdAt: '1', provenance: [pt('S1')] },
    { id: 'c_2', premises: ['n_2', 'n_1'], conclusion: 'n_3', createdAt: '2', provenance: [pt('S2')] },
  ]
  const g = mergeGraph(nodes, chains)
  expect(g.nodes.length).toBe(1)
  expect(g.nodes[0]!.name).toBe('Limit')
  expect(g.nodes[0]!.aliases).toEqual(['A limit, restated'])
  expect(g.nodes[0]!.provenance.length).toBe(2)
  expect(g.chains.length).toBe(1)
  expect(g.chains[0]!.id).toBe('c_1')
})

test('findings are validated and applied with links', async () => {
  const existing = new Set(['n_old'])
  const bad = validateFindings({ propositions: [{ id: 'n_old', name: 'x', statement: 'y' }], chains: [{ premises: ['p9'], conclusion: 'p1' }] }, existing)
  expect(bad.problems.join(' ')).toMatch(/re-declares existing id/)
  expect(bad.problems.join(' ')).toMatch(/unknown id "p9"/)
  const good = validateFindings(
    { propositions: [{ id: 'p1', name: 'A', statement: 'a', messageId: 'm_1' }, { id: 'p2', name: 'B', statement: 'b', messageId: 'm_1' }], chains: [{ premises: ['p1', 'n_old'], conclusion: 'p2' }] },
    existing,
    new Set(['m_1']),
  )
  expect(good.findings).toBeDefined()
  let n = 0
  const { nodeLines, chainLines } = applyFindings(good.findings!, new Map([['p1', 'n_old']]), 'S1', 'now', p => `${p}_${++n}`)
  expect(nodeLines.map(l => l.id)).toEqual(['n_old', 'n_1'])
  expect(chainLines[0]!.premises).toEqual(['n_old'])
  expect(chainLines[0]!.conclusion).toBe('n_1')
})

test('proposition notes link their premises and the lesson they came from', async () => {
  const g = mergeGraph(
    [
      { id: 'n_a', name: 'Limits', statement: 'L', aliases: [], createdAt: '', provenance: [{ chatId: 'S1', messageId: 'm' }] },
      { id: 'n_b', name: 'The derivative', statement: 'D', aliases: [], createdAt: '', provenance: [{ chatId: 'S1', messageId: 'm' }] },
    ],
    [{ id: 'c', premises: ['n_a'], conclusion: 'n_b', createdAt: '', provenance: [] }],
  )
  const names = noteNames(g)
  const note = propositionNote(g.nodes[1]!, g, names, { S1: { id: 'S1', kind: 'chat', name: 'Calc', note: '/v/logs/calc.md', createdAt: '2026-10-24T00:00:00Z', updatedAt: '' } })
  expect(note).toContain('**Follows from**\n- [[Limits]]')
  expect(note).toContain('**Learned in**\n- [[calc]] · 2026-10-24')
})

test('teaching texts take prose and quiz reasoning, not the learner', async () => {
  const texts = teachingTexts([
    { role: 'user', text: 'teach me', toolUses: [] },
    { role: 'assistant', text: 'All derivatives are limits.', toolUses: [{ tool: 'mcp__learn__quiz', input: { ...QUIZ } }] },
  ])
  expect(texts[0]).toBe('All derivatives are limits.')
  expect(texts[1]).toContain('Answer: $2\\cos(2x)$')
  expect(texts[1]).toContain('Why: Chain rule.')
})

test('/graph extracts the session in the background, then skips what it covered', async ($, on) => {
  const { files, logs } = world(on)
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'A derivative is a limit of difference quotients.', toolUses: [] }] }) as any)
  let calls = 0
  on('model.complete', ($: any, e: any) => {
    calls++
    const tag = /\[(m_[0-9a-f]{10})\]/.exec(e.prompt)?.[1]
    const json = { propositions: [{ id: 'p1', name: 'Derivative as a limit', statement: 'The derivative is the limit of difference quotients.', messageId: tag }], chains: [] }
    return { value: { isAnswered: true, text: '```json\n' + JSON.stringify(json) + '\n```', usage: {} } } as any
  })
  const started = await $.command.run({ command: 'graph' } as any)
  expect(started.text).toContain('background')
  for (let i = 0; i < 20 && !logs.some(l => l.startsWith('Knowledge graph:')); i++) await clock.advance(10)
  expect(logs.find(l => l.startsWith('Knowledge graph:'))).toContain('1 new proposition')
  expect(files['/home/u/Desktop/learn/graph/nodes.jsonl']).toContain('Derivative as a limit')
  expect(Object.keys(files).some(f => f.startsWith('/home/u/Desktop/learn/graph/propositions/Derivative as a limit'))).toBe(true)

  await $.command.run({ command: 'graph' } as any)
  for (let i = 0; i < 20 && logs.filter(l => l.startsWith('Knowledge graph:')).length < 2; i++) await clock.advance(10)
  expect(logs.at(-1)).toContain('nothing new')
  expect(calls).toBe(1)

  const found = await $.tool.call({ tool: 'mcp__learn__graph_find', query: 'difference quotient' } as any)
  expect(String(found.result)).toContain(':: Derivative as a limit')
})

// --- permissions ---

test('only the plugin scripts with plain arguments are pre-allowed', async () => {
  expect(isPluginScript('/p', '/p/bin/render-viz /v/viz/.src/a.mmd chain-rule')).toBe(true)
  expect(isPluginScript('/p', "/p/bin/test-demo '/v/viz/.src/my demo.html'")).toBe(true)
  expect(isPluginScript('/p', '/p/bin/render-viz a.mmd; rm -rf ~')).toBe(false)
  expect(isPluginScript('/p', '/p/bin/render-viz $(whoami)')).toBe(false)
  expect(isPluginScript('/p', '/p/bin/other a')).toBe(false)
})

test('session start registers the tools, commands and agents, with the plugin path filled in', async ($, on) => {
  world(on, {}, path =>
    path.endsWith('/prompts/agents/demo-maker.md')
      ? '---\nname: demo-maker\ndescription: Builds a demo: tested\ntools: Read, Bash\nmodel: inherit\n---\nRun {{PLUGIN_ROOT}}/bin/test-demo x.html'
      : undefined,
  )
  const tools: string[] = []
  const commands: string[] = []
  const agents: any[] = []
  on('command.register', ($: any, e: any) => {
    commands.push(e.name)
    return { value: {} } as any
  })
  on('tool.register', ($: any, e: any) => {
    tools.push(e.name)
    return { value: { tool: `mcp__learn__${e.name}` } } as any
  })
  on('agent.register', ($: any, e: any) => {
    agents.push(e)
    return { value: { agent: `learn:${e.name}` } } as any
  })
  on('fs.list', () => ({ value: [{ name: 'demo-maker.md', kind: 'file' }, { name: 'notes.txt', kind: 'file' }] }) as any)
  on('session.messages', () => ({ value: [] }) as any)
  on('session.start', ($: any, e: any) => e)
  await $.session.start({ cwd: '/home/u/elsewhere', surface: null, isInteractive: false } as any)
  expect(tools).toEqual(expect.arrayContaining(['probe', 'recall', 'quiz', 'explain']))
  expect(tools).toContain('graph_extract')
  expect(commands).toEqual(['learn', 'md-log', 'md-unlog', 'map', 'graph', 'graph-import'])
  expect(agents.length).toBe(1)
  expect(agents[0].description).toBe('Builds a demo: tested')
  expect(agents[0].tools).toEqual(['Read', 'Bash'])
  expect(agents[0].prompt).toMatch(/^Run \/\S+\/bin\/test-demo x\.html$/)
})
