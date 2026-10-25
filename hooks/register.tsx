import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  CONFIDENCE_OPTIONS,
  CONFIDENCE_QUESTION,
  DONT_KNOW_LABEL,
  EXPLAIN_DONT_KNOW,
  EXPLAIN_IN_CHAT,
  askAnswerCallout,
  assistantBlock,
  cleanUserText,
  concludeCallout,
  explainAnswerCallout,
  explainFeedbackLines,
  explainResultText,
  grade,
  healArguments,
  interpretAnswer,
  interpretExplain,
  isSilentCommand,
  noteSlug,
  normalizeOptions,
  parseConfidence,
  planCallout,
  probeCallout,
  problemCallout,
  questionCallout,
  quizAnswerCallout,
  quizFeedbackLines,
  quizResultText,
  resolveCorrect,
  shuffled,
  skillNote,
  userBlock,
  type AnswerExtras,
  type DisplayedOption,
  type ProbeStrand,
  type QuizInput,
} from './format'
import {
  applyFindings,
  batchPassages,
  extractorPrompt,
  extractorSystem,
  findText,
  linkCandidates,
  linkerPrompt,
  LINKER_SYSTEM,
  listPropositionsText,
  listSessionsText,
  mergeGraph,
  notePassages,
  noteNames,
  parseJsonl,
  parseJsonReply,
  propositionNote,
  sourceDigest,
  teachingTexts,
  validateFindings,
  validLinks,
  type ChainLine,
  type Findings,
  type Graph,
  type NodeLine,
  type Passage,
  type Source,
} from './graph'
import { parsePlan, planLines, planMermaid, planStatuses, planSummary, topoOrder, type PlanTree } from './plan'
import {
  CONCLUDE_DESCRIPTION,
  CONCLUDE_SCHEMA,
  CONCLUDE_TOOL,
  EXPLAIN_DESCRIPTION,
  EXPLAIN_SCHEMA,
  EXPLAIN_TOOL,
  GRAPH_EXTRACT_DESCRIPTION,
  GRAPH_EXTRACT_TOOL,
  GRAPH_FIND_DESCRIPTION,
  GRAPH_FIND_SCHEMA,
  GRAPH_FIND_TOOL,
  GRAPH_PROPOSITIONS_DESCRIPTION,
  GRAPH_PROPOSITIONS_SCHEMA,
  GRAPH_PROPOSITIONS_TOOL,
  GRAPH_SESSIONS_DESCRIPTION,
  GRAPH_SESSIONS_TOOL,
  PLAN_DESCRIPTION,
  PLAN_SCHEMA,
  PLAN_TOOL,
  PROBE_DESCRIPTION,
  PROBE_DONE_DESCRIPTION,
  PROBE_DONE_SCHEMA,
  PROBE_DONE_TOOL,
  PROBE_SCHEMA,
  PROBE_TOOL,
  PROBLEM_DESCRIPTION,
  PROBLEM_SCHEMA,
  PROBLEM_TOOL,
  QUIZ_DESCRIPTION,
  QUIZ_SCHEMA,
  QUIZ_TOOL,
  RECALL_DESCRIPTION,
  RECALL_SCHEMA,
  RECALL_TOOL,
  GRADED_TOOLS,
  MULTIPLE_CHOICE_TOOLS,
  TEACH_QUESTION_TOOLS,
  isPluginScript,
  offersTool,
  parseQuizType,
  type QuizType,
} from './tools'
import type { PlanView } from '../types'

const PLAN_PANE = 'plan'
const planView = atom({ plugin: 'learn', key: 'plan' } as const, null as PlanView | null)

// --- options: where the learning folder (the Obsidian vault) lives ---

let learnDirOption = '~/Desktop/learn'
let graphModel = 'sonnet'
let askConfidence = true
let quizType: QuizType = 'both'

// --- per-session lesson state, kept in $.store so a reload keeps it ---

interface Problem {
  id: string
  statement: string
  mode: string
  target?: string[]
  modelSolution: string
}

interface Lesson {
  topic?: string
  probe?: { strands: ProbeStrand[]; summary?: string }
  plan?: PlanTree
  tags: string[] // the nodeId of every tagged quiz/explain call, in order
  problem?: Problem
}

const lessonKey = async ($: EngineInterface) => `lesson:${await $.session.id()}`

async function getLesson($: EngineInterface): Promise<Lesson> {
  const saved = (await $.store.get(await lessonKey($))) as Lesson | undefined
  return { tags: [], ...(saved ?? {}) }
}

async function setLesson($: EngineInterface, lesson: Lesson): Promise<void> {
  await $.store.set(await lessonKey($), lesson)
}

// --- md-log state (module variables are rebuilt from $.store on every load) ---

let logFile: string | null = null
let planLine: string | undefined
let writeChain: Promise<void> = Promise.resolve()
let quizAsking = 0 // the quiz's own dialog is logged as a quiz, not as a question

const storeKey = async ($: EngineInterface) => `md-log:${await $.session.id()}`

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)

function showStatus($: EngineInterface) {
  const parts = [logFile ? `🗒 ${basename(logFile)}` : '', planLine ?? ''].filter(Boolean)
  $.ui.status(parts.length ? parts.join(' · ') : undefined)
}

// Appends are serialized so blocks land in the order the events fired.
function appendBlock($: EngineInterface, block: string): Promise<void> {
  const file = logFile
  if (!file || !block.trim()) return writeChain
  writeChain = writeChain.then(async () => {
    try {
      const current = (await $.fs.exists(file)) ? await $.fs.read(file) : ''
      const prefix = current.trim().length > 0 ? '\n\n' : ''
      await $.fs.write(file, current + prefix + block + '\n')
    } catch (err) {
      $.ui.log(`md-log: could not write ${file}: ${String(err)}`, { to: 'debug' })
    }
  })
  return writeChain
}

// A learn tool's note blocks, kept per call so /md-log can backfill them.
async function logBlocks($: EngineInterface, toolUseId: string | undefined, blocks: string[]): Promise<void> {
  if (toolUseId) {
    const key = `blocks:${toolUseId}`
    const have = ((await $.store.get(key)) as string[] | undefined) ?? []
    await $.store.set(key, [...have, ...blocks])
  }
  for (const block of blocks) await appendBlock($, block)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n')
}

function userRowBlock(raw: string): string | undefined {
  const note = skillNote(raw)
  if (note) return note
  const cleaned = cleanUserText(raw)
  if (!cleaned || isSilentCommand(cleaned)) return undefined
  return userBlock(cleaned)
}

function askQuestionBlocks(input: any): string[] {
  const questions: any[] = Array.isArray(input?.questions) ? input.questions : []
  return questions.map(q =>
    questionCallout(
      'Question',
      String(q.question ?? ''),
      q.description?.trim() || undefined,
      Array.isArray(q.options) ? q.options.map((o: any) => String(o.label ?? '')) : [],
    ),
  )
}

function askAnswerBlock(input: any, result: any): string {
  const answers = result?.answers
  if (!answers || typeof answers !== 'object' || Object.keys(answers).length === 0) {
    return result?.response ? askAnswerCallout([`Other: ${result.response}`]) : askAnswerCallout(undefined)
  }
  const questions: any[] = Array.isArray(input?.questions) ? input.questions : []
  const lines = questions.map(q => String((answers as any)[q.question] ?? '(no answer)'))
  return askAnswerCallout(lines.length ? lines : Object.values(answers).map(String))
}

const LEARN_TOOLS = new Set([...GRADED_TOOLS, PROBE_DONE_TOOL, PLAN_TOOL, PROBLEM_TOOL, CONCLUDE_TOOL])

// Rebuild the whole log from the transcript, as pi's /md-log did on link.
async function backfill($: EngineInterface): Promise<number> {
  const file = logFile
  if (!file) return 0
  const rows = await $.session.messages()
  const blocks: string[] = []
  for (const row of rows) {
    if (row.role === 'user') {
      if (row.toolResults?.length && !row.text.trim()) continue
      const block = userRowBlock(row.text)
      if (block) blocks.push(block)
      continue
    }
    if (row.text.trim()) blocks.push(assistantBlock(row.text.trim()))
    for (const use of row.toolUses) {
      if (LEARN_TOOLS.has(use.tool)) {
        const saved = (await $.store.get(`blocks:${use.tool_use_id}`)) as string[] | undefined
        if (saved) blocks.push(...saved)
        else if (MULTIPLE_CHOICE_TOOLS.has(use.tool)) {
          // quizzes logged before blocks were kept per call
          const old = (await $.store.get(`quiz:${use.tool_use_id}`)) as { question?: string; answer?: string } | undefined
          if (old?.question) blocks.push(old.question)
          if (old?.answer) blocks.push(old.answer)
        }
      } else if (use.tool === 'AskUserQuestion') {
        blocks.push(...askQuestionBlocks(use.input))
        if (use.result !== undefined || use.text !== undefined) blocks.push(askAnswerBlock(use.input, use.result))
      }
    }
  }
  await (writeChain = writeChain.then(() => $.fs.write(file, blocks.length ? blocks.join('\n\n') + '\n' : '')))
  return blocks.length
}

async function linkLog($: EngineInterface, path: string): Promise<number> {
  logFile = path
  await $.store.set(await storeKey($), path)
  const written = await backfill($)
  showStatus($)
  return written
}

// --- paths ---

async function homeDir($: EngineInterface): Promise<string> {
  const { stdout } = await $.process.run(['printenv', 'HOME'])
  return stdout.trim()
}

async function learnDir($: EngineInterface): Promise<string> {
  const dir = learnDirOption.trim() || '~/Desktop/learn'
  const expanded = dir.startsWith('~/') || dir === '~' ? `${await homeDir($)}${dir.slice(1)}` : dir
  return expanded.replace(/\/+$/, '')
}

const graphDir = async ($: EngineInterface) => `${await learnDir($)}/graph`

async function mkdirs($: EngineInterface, dir: string): Promise<void> {
  const mk = await $.process.run(['mkdir', '-p', dir])
  if (mk.exitCode !== 0) throw new Error(mk.stderr.trim() || `mkdir ${dir} failed`)
}

// --- auto-log on /teach ---

// Obsidian's own list of vaults (Linux, then macOS).
async function vaultPaths($: EngineInterface, home: string): Promise<string[]> {
  for (const file of [`${home}/.config/obsidian/obsidian.json`, `${home}/Library/Application Support/obsidian/obsidian.json`]) {
    try {
      if (!(await $.fs.exists(file))) continue
      const vaults = JSON.parse(await $.fs.read(file))?.vaults ?? {}
      return Object.values(vaults).map((v: any) => String(v?.path ?? '')).filter(Boolean)
    } catch {
      // unreadable: try the next
    }
  }
  return []
}

// A new note in the vault holding the session's folder, or in the learning
// folder's logs/ when the folder is in none (so embedded diagrams resolve).
async function newLessonNote($: EngineInterface, topic: string): Promise<string> {
  const home = await homeDir($)
  const cwd = await $.session.cwd()
  const inVault = (await vaultPaths($, home)).some(v => cwd === v || cwd.startsWith(`${v}/`))
  const dir = inVault ? cwd : `${await learnDir($)}/logs`
  await mkdirs($, dir)
  const base = noteSlug(topic, new Date().toISOString().slice(0, 10))
  let path = `${dir}/${base}.md`
  for (let n = 2; await $.fs.exists(path); n++) path = `${dir}/${base}-${n}.md`
  await $.fs.write(path, '')
  return path
}

// obsidian:// launches Obsidian when it is closed and shows the note when open.
async function openInObsidian($: EngineInterface, path: string): Promise<void> {
  const uri = `obsidian://open?path=${encodeURIComponent(path)}`
  const { stdout } = await $.process.run(['uname', '-s'])
  const argv = stdout.trim() === 'Darwin' ? ['open', uri] : ['setsid', '-f', 'xdg-open', uri]
  const ran = await $.process.run(argv, { timeoutMs: 10_000 })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `${argv[0]} failed`)
}

async function autoLog($: EngineInterface, topic: string): Promise<void> {
  if (topic) {
    const lesson = await getLesson($)
    if (!lesson.topic) await setLesson($, { ...lesson, topic })
  }
  if (logFile) return // already mirroring: keep that note
  try {
    const path = await newLessonNote($, topic)
    await linkLog($, path)
    $.ui.toast(`Logging to ${basename(path)}`)
    await openInObsidian($, path).catch(err => $.ui.log(`md-log: could not open Obsidian: ${String(err)}`))
  } catch (err) {
    $.ui.log(`md-log: could not start the lesson note: ${String(err)}`)
  }
}

const isTeachSkill = (name: unknown) => name === 'teach' || name === 'learn:teach'
const isPracticeSkill = (name: unknown) => name === 'practice' || name === 'learn:practice'

async function teachCommand($: EngineInterface, e: any, next: any) {
  await autoLog($, String(e.args ?? '').trim())
  return next(e)
}

async function practiceCommand($: EngineInterface, e: any, next: any) {
  await autoLog($, `practice ${String(e.args ?? '').trim()}`.trim())
  return next(e)
}

// --- the plan map: pane, status line, note ---

async function refreshPlan($: EngineInterface, lesson: Lesson): Promise<void> {
  if (!lesson.plan) {
    planLine = undefined
    await update($, planView, () => null)
    showStatus($)
    return
  }
  const statuses = planStatuses(lesson.plan, lesson.tags)
  const titles = new Map(lesson.plan.nodes.map(n => [n.id, n.title]))
  const rows = topoOrder(lesson.plan).map(n => ({
    title: n.title,
    status: statuses.get(n.id) ?? 'upcoming',
    needs: lesson.plan!.edges.filter(e => e.to === n.id).map(e => titles.get(e.from) ?? e.from),
  }))
  planLine = planSummary(lesson.plan, statuses)
  await update($, planView, () => ({ topic: lesson.topic ?? '', summary: planLine!, rows }))
  showStatus($)
}

// The phase decides the tool: probe/recall before the plan, quiz/explain (with
// a node and a role, which move the map) once it exists.
function checkPhase(lesson: Lesson, input: { type?: unknown; nodeId?: unknown }, tool: string): string | undefined {
  const name = tool.replace('mcp__learn__', '')
  const teachName = MULTIPLE_CHOICE_TOOLS.has(tool) ? 'quiz' : 'explain'
  const probeName = MULTIPLE_CHOICE_TOOLS.has(tool) ? 'probe' : 'recall'
  if (!TEACH_QUESTION_TOOLS.has(tool)) {
    if (!lesson.plan) return undefined
    const ids = lesson.plan.nodes.map(n => n.id)
    return `${name}: this session has a plan, so graded questions go through ${teachName}, with \`type\` ("predict" or "check") and \`nodeId\` (${ids.join(', ')}). For an off-map question use AskUserQuestion.`
  }
  if (!lesson.plan) {
    return `${name}: no plan exists yet. While probing (or outside a lesson) use ${probeName}, with no type or nodeId; ${name} is for teaching against the plan.`
  }
  const ids = lesson.plan.nodes.map(n => n.id)
  const problems: string[] = []
  if (input.type !== 'predict' && input.type !== 'check') {
    problems.push('`type` is required: "predict" before teaching a step, "check" after it.')
  }
  if (typeof input.nodeId !== 'string' || !ids.includes(input.nodeId)) {
    problems.push(
      `\`nodeId\` ${typeof input.nodeId === 'string' ? `"${input.nodeId}" is not a node of the plan` : 'is required'}. Valid ids: ${ids.join(', ')}. For an off-map question use AskUserQuestion.`,
    )
  }
  return problems.length ? `${name}: ${problems.join(' ')}` : undefined
}

const roleLabel = (type: unknown, fallback: string) => (type === 'predict' ? 'Prediction' : type === 'check' ? 'Check' : fallback)

async function tagNode($: EngineInterface, nodeId: unknown): Promise<void> {
  const lesson = await getLesson($)
  if (!lesson.plan || typeof nodeId !== 'string') return
  lesson.tags = [...lesson.tags, nodeId]
  await setLesson($, lesson)
  await refreshPlan($, lesson)
}

// --- the question dialog ---

// The engine's own AskUserQuestion dialog, one question at a time (a mod
// reaches it only through $.ui.ask): the label chosen, the labels joined for
// a multi-select, or the text typed under "Other"; undefined when dismissed.
async function ask($: EngineInterface, question: string, options: string[], header: string, multiSelect = false): Promise<string | undefined> {
  quizAsking++
  try {
    return await $.ui.ask(question, { options, header, ...(multiSelect ? { multiSelect: true as const } : {}) })
  } catch {
    return undefined // dismissed
  } finally {
    quizAsking--
  }
}

// --- quiz ---

async function runQuiz($: EngineInterface, input: QuizInput & { tool: string; type?: string; nodeId?: string }, toolUseId: string | undefined): Promise<string> {
  const roleProblem = checkPhase(await getLesson($), input, input.tool)
  if (roleProblem) throw new Error(roleProblem)
  const authored = normalizeOptions(input.options)
  const options = input.shuffle === false ? authored : shuffled(authored)
  const correctIndices = resolveCorrect(input.correctAnswer, options)
  const multiSelect = input.multiSelect === true || correctIndices.length > 1
  const explanation = String(input.explanation ?? '').trim()
  const displayed: DisplayedOption[] = options.map((o, i) => ({ index: i + 1, label: o.label }))
  const details = input.details?.trim() || undefined
  const label = roleLabel(input.type, 'Quiz')
  await tagNode($, input.nodeId)

  // Written before the learner answers, in the order they see — never the answer.
  const questionBlock = questionCallout(label, input.question, details, options.map(o => o.label))
  if (toolUseId) await $.store.set(`blocks:${toolUseId}`, [questionBlock])
  await appendBlock($, questionBlock)

  // The engine's dialog takes labels only, so a description rides in its
  // label and the details under the question. A typed "Other" is his own
  // answer, ungraded.
  const labels = options.map(o => (o.description ? `${o.label} — ${o.description}` : o.label))
  const answer = await ask($, details ? `${input.question}\n\n${details}` : input.question, [...labels, DONT_KNOW_LABEL], label, multiSelect)
  const picked = interpretAnswer(answer, labels, multiSelect)
  // Then how sure he was, before he sees the verdict: a level, or a typed
  // percentage and/or his thinking. Not after "I don't know" (no guess) or
  // his own words (they carry his thinking already).
  let extras: AnswerExtras = {}
  if (askConfidence && picked.kind === 'graded') {
    extras = parseConfidence(await ask($, CONFIDENCE_QUESTION, CONFIDENCE_OPTIONS.map(o => o.label), 'Confidence'))
  }

  const outcome = grade(picked, correctIndices)
  const answerBlock = quizAnswerCallout(outcome, displayed, correctIndices, explanation, extras, label)
  const feedback = quizFeedbackLines(outcome, displayed, correctIndices, explanation, extras)
  if (toolUseId) {
    await $.store.set(`blocks:${toolUseId}`, [questionBlock, answerBlock])
    await $.store.set(`feedback:${toolUseId}`, feedback)
  }
  await appendBlock($, answerBlock)

  return quizResultText(outcome, displayed, correctIndices, explanation, extras)
}

// --- explain (free recall) ---

async function runExplain($: EngineInterface, input: any, toolUseId: string | undefined): Promise<string> {
  const roleProblem = checkPhase(await getLesson($), input, input.tool)
  if (roleProblem) throw new Error(roleProblem)
  const committed = String(input.correctAnswer ?? '').trim()
  if (!input.question?.trim()) throw new Error('question is required')
  if (!committed) throw new Error('correctAnswer is required: commit to the full correct answer BEFORE posing the question.')
  const details = String(input.details ?? '').trim() || undefined
  const label = roleLabel(input.type, 'Explain')
  await tagNode($, input.nodeId)

  const questionBlock = questionCallout(label, input.question, details, [])
  await logBlocks($, toolUseId, [questionBlock])
  const answer = await ask($, details ? `${input.question}\n\n${details}` : input.question, [EXPLAIN_DONT_KNOW, EXPLAIN_IN_CHAT], label)
  const outcome = interpretExplain(answer)
  if (toolUseId) await $.store.set(`feedback:${toolUseId}`, explainFeedbackLines(outcome, committed))
  await logBlocks($, toolUseId, [explainAnswerCallout(outcome, committed, label)])
  return explainResultText(outcome, committed)
}

// --- probe and plan ---

async function runProbeDone($: EngineInterface, input: any, toolUseId: string | undefined): Promise<string> {
  const lesson = await getLesson($)
  if (lesson.probe) throw new Error('The probe is already concluded: probe_done fires exactly once per session.')
  const strands: ProbeStrand[] = (input?.assessment?.strands ?? [])
    .filter((s: any) => s?.strand?.trim() && s?.assessment?.trim())
    .map((s: any) => ({ strand: String(s.strand).trim(), assessment: String(s.assessment).trim() }))
  if (!strands.length) throw new Error('assessment.strands needs at least one { strand, assessment }.')
  const summary = String(input?.assessment?.summary ?? '').trim() || undefined
  await setLesson($, { ...lesson, probe: { strands, summary } })
  await logBlocks($, toolUseId, [probeCallout(strands, summary)])
  return 'Assessment recorded and shown to him. Plan now, in this same turn: write the map with the plan tool, present the approach in prose, and end your turn for his go-ahead.'
}

async function runPlan($: EngineInterface, input: any, toolUseId: string | undefined): Promise<string> {
  const parsed = parsePlan(String(input?.mermaid ?? ''))
  if (!parsed.ok) throw new Error(`plan: fix and call again:\n${parsed.problems.join('\n')}`)
  const lesson = await getLesson($)
  const plan: PlanTree = { nodes: parsed.nodes, edges: parsed.edges, revision: (lesson.plan?.revision ?? 0) + 1 }
  const next = { ...lesson, plan }
  await setLesson($, next)
  await refreshPlan($, next)
  await logBlocks($, toolUseId, [planCallout(planMermaid(plan, planStatuses(plan, next.tags)), plan.revision)])
  void $.ui.open({ id: PLAN_PANE, title: 'Lesson plan' }).catch(() => undefined)
  return JSON.stringify({
    ok: true,
    nodeIds: plan.nodes.map(n => n.id),
    reminder: "These are the plan's node ids: the only valid nodeId values for every quiz and explain call from here on. Reference them exactly.",
  })
}

// --- practice ---

async function runProblem($: EngineInterface, input: any, toolUseId: string | undefined): Promise<string> {
  const lesson = await getLesson($)
  if (lesson.problem) throw new Error('A problem is already active: call conclude on it before posing the next one.')
  const statement = String(input?.statement ?? '').trim()
  const modelSolution = String(input?.modelSolution ?? '').trim()
  const mode = String(input?.mode ?? '')
  if (!statement || !modelSolution) throw new Error('statement and modelSolution are required.')
  if (!['recall', 'discrimination', 'composition'].includes(mode)) throw new Error('mode must be recall, discrimination, or composition.')
  let target: string[] | undefined
  if (Array.isArray(input?.target) && input.target.length) {
    const graph = await loadGraph($)
    const resolved = input.target.map((t: unknown) => {
      const s = String(t)
      return graph.nodes.find(n => n.id === s)?.id ?? graph.nodes.find(n => n.name.toLowerCase() === s.toLowerCase())?.id ?? null
    })
    const unknown = input.target.filter((_: unknown, i: number) => resolved[i] === null)
    if (unknown.length) {
      throw new Error(`target ${JSON.stringify(unknown)} is not a known proposition: targets are ids from the knowledge graph; if the material is not in the graph, omit target entirely.`)
    }
    target = resolved as string[]
  }
  await setLesson($, { ...lesson, problem: { id: toolUseId ?? '', statement, mode, ...(target ? { target } : {}), modelSolution } })
  await logBlocks($, toolUseId, [problemCallout(statement, mode)])
  return 'Problem posed; the model solution stays hidden from him. END YOUR TURN now. His work arrives as his messages: a working trace or a request for help gets the hint ladder (one rung per request); a claimed answer gets a verdict.'
}

async function runConclude($: EngineInterface, input: any, toolUseId: string | undefined): Promise<string> {
  const lesson = await getLesson($)
  const problem = lesson.problem
  if (!problem) throw new Error('No active problem to conclude: pose one first.')
  const outcome = String(input?.outcome ?? '')
  const verdict = String(input?.verdict ?? '').trim()
  if (!['solved', 'solvedWithHints', 'movedOn', 'surrendered', 'dismissed'].includes(outcome)) {
    throw new Error('outcome must be solved, solvedWithHints, movedOn, surrendered, or dismissed.')
  }
  if (!verdict) throw new Error('verdict is required.')
  const { problem: _done, ...rest } = lesson
  await setLesson($, { ...rest, tags: lesson.tags })
  if (toolUseId) await $.store.set(`feedback:${toolUseId}`, [verdict, '', '**Model solution**', '', problem.modelSolution])
  await logBlocks($, toolUseId, [concludeCallout(outcome, verdict, problem.modelSolution)])
  const retest = input?.retest === true ? ' It is marked for a fresh-surface retest before the session ends.' : ''
  return `Concluded (${outcome}); he now sees the committed model solution.${retest} Say your closing words about his work if useful, then END YOUR TURN. The next problem waits for his explicit go-ahead.`
}

// --- the knowledge graph store ---

let graphChain: Promise<unknown> = Promise.resolve()
let extracting = false

// Serialize every read-modify-write of the ledgers.
function withGraph<T>(fn: () => Promise<T>): Promise<T> {
  const run = graphChain.then(fn, fn)
  graphChain = run.catch(() => undefined)
  return run
}

async function readText($: EngineInterface, path: string): Promise<string> {
  return (await $.fs.exists(path)) ? await $.fs.read(path) : ''
}

async function loadGraph($: EngineInterface): Promise<Graph> {
  const dir = await graphDir($)
  return mergeGraph(parseJsonl<NodeLine>(await readText($, `${dir}/nodes.jsonl`)), parseJsonl<ChainLine>(await readText($, `${dir}/chains.jsonl`)))
}

async function loadSources($: EngineInterface): Promise<Record<string, Source>> {
  try {
    return JSON.parse((await readText($, `${await graphDir($)}/sources.json`)) || '{}')
  } catch {
    return {}
  }
}

async function appendJsonl($: EngineInterface, path: string, lines: unknown[]): Promise<void> {
  if (!lines.length) return
  const current = await readText($, path)
  const sep = current && !current.endsWith('\n') ? '\n' : ''
  await $.fs.write(path, current + sep + lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

async function sha($: EngineInterface, text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomId(prefix: 'n' | 'c'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  return `${prefix}_${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}`
}

async function complete($: EngineInterface, system: string, prompt: string, maxTokens: number): Promise<string> {
  const reply = await $.model.complete({ model: graphModel, system, prompt, maxTokens, timeoutMs: 600_000 } as any)
  if (!reply.isAnswered) throw new Error(`the model did not answer (${(reply as any).reason}${(reply as any).status ? ` ${(reply as any).status}` : ''})`)
  return (reply as any).text as string
}

// The extractor, with one retry that names every problem in its first reply.
async function extractFindings($: EngineInterface, kind: 'chat' | 'file', prompt: string, existing: Set<string>, messageIds?: Set<string>): Promise<Findings> {
  const system = extractorSystem(kind)
  let problems: string[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const retry = problems.length ? `\n\nYOUR PREVIOUS REPLY WAS REJECTED. Fix every problem and reply again:\n- ${problems.join('\n- ')}` : ''
    const text = await complete($, system, prompt + retry, 32_000)
    let value: unknown
    try {
      value = parseJsonReply(text)
    } catch {
      problems = ['the reply was not one JSON object in a ```json block']
      continue
    }
    const checked = validateFindings(value, existing, messageIds)
    if (checked.findings) return checked.findings
    problems = checked.problems
  }
  throw new Error(`the extractor's findings were invalid twice: ${problems.slice(0, 3).join('; ')}`)
}

async function linkFindings($: EngineInterface, graph: Graph, findings: Findings): Promise<Map<string, string>> {
  if (!findings.propositions.length || !graph.nodes.length) return new Map()
  const existing = new Set(graph.nodes.map(n => n.id))
  try {
    const text = await complete($, LINKER_SYSTEM, linkerPrompt(findings, linkCandidates(graph, findings)), 8_000)
    return validLinks(parseJsonReply(text), findings, existing)
  } catch (err) {
    $.ui.log(`graph: linking skipped (${String(err)}); the new propositions stay unlinked`, { to: 'debug' })
    return new Map()
  }
}

// One source through the pipeline: skip covered passages, extract each batch
// against the source's digest, link, append, and rewrite the notes.
async function extractSource($: EngineInterface, source: Source, kind: 'chat' | 'file', texts: string[]): Promise<{ added: number; linked: number; chains: number; skipped: boolean }> {
  return withGraph(async () => {
    const dir = await graphDir($)
    await mkdirs($, dir)
    const coverage = parseJsonl<{ source: string; hash: string }>(await readText($, `${dir}/coverage.jsonl`))
    const covered = new Set(coverage.filter(c => c.source === source.id).map(c => c.hash))
    const passages: Array<Passage & { hash: string }> = []
    for (const text of texts) {
      const hash = await sha($, text)
      if (!covered.has(hash) && !passages.some(p => p.hash === hash)) passages.push({ hash, messageId: `m_${hash.slice(0, 10)}`, text })
    }
    if (!passages.length) return { added: 0, linked: 0, chains: 0, skipped: true }

    const sources = await loadSources($)
    sources[source.id] = { ...source, createdAt: sources[source.id]?.createdAt ?? source.createdAt }
    await $.fs.write(`${dir}/sources.json`, JSON.stringify(sources, null, 2) + '\n')
    if (!(await $.fs.exists(`${dir}/format.json`))) await $.fs.write(`${dir}/format.json`, '{"version":1}\n')

    let added = 0
    let linked = 0
    let chains = 0
    for (const batch of batchPassages(passages)) {
      const graph = await loadGraph($)
      const existing = new Set(graph.nodes.map(n => n.id))
      const prompt = extractorPrompt(sourceDigest(graph, source.id), batch, kind)
      const findings = await extractFindings($, kind, prompt, existing, kind === 'chat' ? new Set(batch.map(p => p.messageId)) : undefined)
      const links = await linkFindings($, graph, findings)
      const { nodeLines, chainLines } = applyFindings(findings, links, source.id, new Date().toISOString(), randomId)
      await appendJsonl($, `${dir}/nodes.jsonl`, nodeLines)
      await appendJsonl($, `${dir}/chains.jsonl`, chainLines)
      await appendJsonl($, `${dir}/coverage.jsonl`, (batch as Array<Passage & { hash: string }>).map(p => ({ source: source.id, hash: p.hash })))
      added += nodeLines.length - links.size
      linked += links.size
      chains += chainLines.length
    }
    await writeNotes($)
    return { added, linked, chains, skipped: false }
  })
}

// One Obsidian note per proposition, under graph/propositions/.
async function writeNotes($: EngineInterface): Promise<void> {
  const dir = `${await graphDir($)}/propositions`
  await mkdirs($, dir)
  const graph = await loadGraph($)
  const sources = await loadSources($)
  const names = noteNames(graph)
  const written = ((await $.store.get('graph-notes')) as Record<string, string> | undefined) ?? {}
  const now: Record<string, string> = {}
  for (const node of graph.nodes) {
    const file = `${dir}/${names.get(node.id)}.md`
    now[node.id] = file
    const text = propositionNote(node, graph, names, sources)
    if ((await readText($, file)) !== text) await $.fs.write(file, text)
    // A rename (a second node took the same name): drop the note we wrote before.
    if (written[node.id] && written[node.id] !== file) await $.process.run(['rm', '-f', written[node.id]!])
  }
  await $.store.set('graph-notes', now)
}

async function sessionSource($: EngineInterface): Promise<Source> {
  const id = await $.session.id()
  const lesson = await getLesson($)
  const stamp = new Date().toISOString()
  const name = lesson.topic || (logFile ? basename(logFile).replace(/\.md$/, '') : `Session ${stamp.slice(0, 10)}`)
  return { id, kind: 'chat', name, ...(logFile ? { note: logFile } : {}), createdAt: stamp, updatedAt: stamp }
}

function report(text: string, $: EngineInterface) {
  $.ui.toast(text)
  $.ui.log(text)
}

// Background: the dispatch that asked returns at once.
function startExtraction($: EngineInterface): string {
  if (extracting) return 'An extraction is already running; it reports when done.'
  extracting = true
  $.clock.after(0, async () => {
    try {
      const rows = await $.session.messages()
      const result = await extractSource($, await sessionSource($), 'chat', teachingTexts(rows as any))
      report(
        result.skipped
          ? 'Knowledge graph: nothing new to extract from this session.'
          : `Knowledge graph: ${result.added} new proposition(s), ${result.linked} linked to existing ones, ${result.chains} chain(s).`,
        $,
      )
    } catch (err) {
      report(`Knowledge graph: extraction failed: ${err instanceof Error ? err.message : String(err)}`, $)
    } finally {
      extracting = false
    }
  })
  return 'Extraction started in the background; it reports to him when done. Carry on.'
}

async function importNotes($: EngineInterface, path: string): Promise<string> {
  const text = await $.fs.read(path)
  const id = `src_${(await sha($, path)).slice(0, 10)}`
  const stamp = new Date().toISOString()
  const source: Source = { id, kind: 'file', name: basename(path).replace(/\.md$/, ''), note: path, createdAt: stamp, updatedAt: stamp }
  const result = await extractSource($, source, 'file', notePassages(text))
  return result.skipped
    ? `Nothing new in ${basename(path)}: every passage was already imported.`
    : `Imported ${basename(path)}: ${result.added} new proposition(s), ${result.linked} linked to existing ones, ${result.chains} chain(s).`
}

async function resolvePath($: EngineInterface, arg: string): Promise<string> {
  const clean = arg.trim().replace(/^["']|["']$/g, '')
  if (clean.startsWith('/')) return clean
  if (clean.startsWith('~/')) return `${await homeDir($)}${clean.slice(1)}`
  return `${await $.session.cwd()}/${clean}`
}

// --- agents: prompts ship in prompts/agents, the plugin's path filled in ---

function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: m[2]! }
}

async function registerAgents($: EngineInterface): Promise<void> {
  const dir = `${$.plugin.root}/prompts/agents`
  for (const entry of await $.fs.list(dir)) {
    if (!entry.name.endsWith('.md')) continue
    try {
      const { meta, body } = frontmatter(await $.fs.read(`${dir}/${entry.name}`))
      await $.agent.register({
        name: meta.name || entry.name.replace(/\.md$/, ''),
        description: meta.description ?? '',
        prompt: body.replaceAll('{{PLUGIN_ROOT}}', $.plugin.root),
        ...(meta.tools ? { tools: meta.tools.split(',').map(t => t.trim()).filter(Boolean) } : {}),
        ...(meta.model ? { model: meta.model } : {}),
      })
    } catch (err) {
      $.ui.log(`learn: could not register agent ${entry.name}: ${String(err)}`, { to: 'debug' })
    }
  }
}

// --- serving the tools ---

async function runTool($: EngineInterface, e: any): Promise<string> {
  const id: string | undefined = e.tool_use_id
  switch (e.tool) {
    case QUIZ_TOOL:
    case PROBE_TOOL:
      return runQuiz($, e, id)
    case EXPLAIN_TOOL:
    case RECALL_TOOL:
      return runExplain($, e, id)
    case PROBE_DONE_TOOL:
      return runProbeDone($, e, id)
    case PLAN_TOOL:
      return runPlan($, e, id)
    case PROBLEM_TOOL:
      return runProblem($, e, id)
    case CONCLUDE_TOOL:
      return runConclude($, e, id)
    case GRAPH_SESSIONS_TOOL:
      return listSessionsText(await loadGraph($), await loadSources($))
    case GRAPH_PROPOSITIONS_TOOL:
      return listPropositionsText(await loadGraph($), String(e.session ?? ''))
    case GRAPH_FIND_TOOL:
      return findText(await loadGraph($), String(e.query ?? '*'))
    case GRAPH_EXTRACT_TOOL:
      return startExtraction($)
    default:
      throw new Error(`unknown tool ${e.tool}`)
  }
}

// Each learn tool's schema, for the argument heal.
const SCHEMAS: Record<string, { properties?: Record<string, any> }> = {
  [QUIZ_TOOL]: QUIZ_SCHEMA,
  [EXPLAIN_TOOL]: EXPLAIN_SCHEMA,
  [PROBE_TOOL]: PROBE_SCHEMA,
  [RECALL_TOOL]: RECALL_SCHEMA,
  [PROBE_DONE_TOOL]: PROBE_DONE_SCHEMA,
  [PLAN_TOOL]: PLAN_SCHEMA,
  [PROBLEM_TOOL]: PROBLEM_SCHEMA,
  [CONCLUDE_TOOL]: CONCLUDE_SCHEMA,
  [GRAPH_PROPOSITIONS_TOOL]: GRAPH_PROPOSITIONS_SCHEMA,
  [GRAPH_FIND_TOOL]: GRAPH_FIND_SCHEMA,
}

async function serveTool($: EngineInterface, e: any) {
  try {
    const schema = SCHEMAS[e.tool]
    return { result: await runTool($, schema ? healArguments(e, schema) : e) }
  } catch (err) {
    return { deny: fail(err) }
  }
}

function toolFailed($: EngineInterface, e: any, next: any) {
  return next.called ? next(e) : { deny: `${String(e.tool).replace('mcp__learn__', '')}: the tool failed; ask in chat instead.` }
}

// The call rows never show what he must not see yet: no correct answers,
// explanations or model solutions while he works.
const HIDDEN: Record<string, string[]> = {
  [QUIZ_TOOL]: ['correctAnswer', 'explanation'],
  [EXPLAIN_TOOL]: ['correctAnswer'],
  [PROBE_TOOL]: ['correctAnswer', 'explanation'],
  [RECALL_TOOL]: ['correctAnswer'],
  [PROBLEM_TOOL]: ['modelSolution'],
}

async function hideAnswers($: EngineInterface, e: any, next: any) {
  const props = e.props
  const drop = HIDDEN[props?.tool] ?? []
  if (!props?.input || typeof props.input !== 'object') return next(e)
  const input = Object.fromEntries(Object.entries(props.input).filter(([k, v]) => !drop.includes(k) && v !== undefined))
  return next({ ...e, props: { ...props, input } })
}

// Under a question or a concluded problem: the feedback he has earned.
async function drawFeedback($: EngineInterface, e: any, next: any) {
  const props = e.props
  if (props.isErrored || typeof props.output !== 'string') return next(e)
  const id = props.tool_use_id
  const lines =
    ((await $.store.get(`feedback:${id}`)) as string[] | undefined) ?? ((await $.store.get(`quiz:${id}`)) as { feedback?: string[] } | undefined)?.feedback
  const { Markdown } = $.ui.resolve(e)
  const text = lines?.length ? lines.map(l => (l ? `${l}  ` : '')).join('\n') : props.output
  return <Markdown text={text} />
}

const HELP = [
  'The learning setup is built in:',
  '- /learn:teach <topic> — probe what you know, plan, and teach; opens a lesson note in Obsidian',
  '- /learn:practice [topic] — practice problems on what you have learned',
  '- /map — show the lesson plan map',
  '- /graph — extract this session into your knowledge graph; /graph-import <note.md> imports notes',
  '- /md-log <note.md>, /md-unlog — mirror the session into a note, or stop',
].join('\n')

const fail = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const register: Register = (on, options) => {
  learnDirOption = String(options?.learnDir ?? '~/Desktop/learn')
  graphModel = String(options?.graphModel ?? '').trim() || 'sonnet'
  askConfidence = options?.askConfidence !== false
  quizType = parseQuizType(options?.quizType)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'learn', description: 'How to use the learning setup' })
    await $.command.register({ name: 'md-log', description: 'Mirror the session to a markdown file (backfills history)', argumentHint: '<file.md>' })
    await $.command.register({ name: 'md-unlog', description: 'Stop mirroring the session to a markdown file' })
    await $.command.register({ name: 'map', description: "Show this lesson's plan map" })
    await $.command.register({ name: 'graph', description: 'Extract this session into the knowledge graph' })
    await $.command.register({ name: 'graph-import', description: 'Import a markdown note into the knowledge graph', argumentHint: '<note.md>' })

    // Only the mechanics the quiz-type setting arms are offered. The
    // probe-phase tool is always loaded: it opens every lesson and serves a
    // graded question outside one.
    const questionTools = [
      { tool: PROBE_TOOL, name: 'probe', description: PROBE_DESCRIPTION, inputSchema: PROBE_SCHEMA, isDeferred: false },
      { tool: RECALL_TOOL, name: 'recall', description: RECALL_DESCRIPTION, inputSchema: RECALL_SCHEMA, isDeferred: quizType !== 'free' },
      { tool: QUIZ_TOOL, name: 'quiz', description: QUIZ_DESCRIPTION, inputSchema: QUIZ_SCHEMA, isDeferred: true },
      { tool: EXPLAIN_TOOL, name: 'explain', description: EXPLAIN_DESCRIPTION, inputSchema: EXPLAIN_SCHEMA, isDeferred: true },
    ]
    for (const { tool, ...spec } of questionTools) if (offersTool(quizType, tool)) await $.tool.register(spec)
    await $.tool.register({ name: 'probe_done', description: PROBE_DONE_DESCRIPTION, inputSchema: PROBE_DONE_SCHEMA })
    await $.tool.register({ name: 'plan', description: PLAN_DESCRIPTION, inputSchema: PLAN_SCHEMA })
    await $.tool.register({ name: 'problem', description: PROBLEM_DESCRIPTION, inputSchema: PROBLEM_SCHEMA })
    await $.tool.register({ name: 'conclude', description: CONCLUDE_DESCRIPTION, inputSchema: CONCLUDE_SCHEMA })
    await $.tool.register({ name: 'graph_sessions', description: GRAPH_SESSIONS_DESCRIPTION, inputSchema: { type: 'object', properties: {} } })
    await $.tool.register({ name: 'graph_propositions', description: GRAPH_PROPOSITIONS_DESCRIPTION, inputSchema: GRAPH_PROPOSITIONS_SCHEMA })
    await $.tool.register({ name: 'graph_find', description: GRAPH_FIND_DESCRIPTION, inputSchema: GRAPH_FIND_SCHEMA })
    await $.tool.register({ name: 'graph_extract', description: GRAPH_EXTRACT_DESCRIPTION, inputSchema: { type: 'object', properties: {} } })
    await registerAgents($)

    const saved = (await $.store.get(await storeKey($))) as string | null | undefined
    logFile = typeof saved === 'string' ? saved : null
    await refreshPlan($, await getLesson($))
    return next(e)
  })

  // --- commands ---

  on('command.run', { command: 'learn' }, async () => ({ text: HELP }))

  on('command.run', { command: 'md-log' }, async ($, e) => {
    const arg = e.args.trim().replace(/^["']|["']$/g, '')
    if (!arg) return { text: 'Usage: /md-log <file.md>' }
    const resolved = await resolvePath($, arg)
    // Links into an existing note only; a typo never scatters new files around the vault.
    let kind: string
    try {
      kind = (await $.fs.stat(resolved)).kind
    } catch {
      return { text: `File does not exist: ${resolved}` }
    }
    if (kind !== 'file') return { text: `Not a file: ${resolved}` }
    const written = await linkLog($, resolved)
    return { text: `Linked: ${resolved} (${written} blocks backfilled)` }
  })

  on('command.run', { command: 'md-unlog' }, async $ => {
    if (!logFile) return { text: 'No file linked' }
    const name = basename(logFile)
    logFile = null
    await $.store.set(await storeKey($), null)
    showStatus($)
    return { text: `Unlinked: ${name}` }
  })

  on('command.run', { command: 'map' }, async $ => {
    const lesson = await getLesson($)
    if (!lesson.plan) return { text: 'No plan yet: the teacher writes one after the probe.' }
    const opened = await $.ui.open({ id: PLAN_PANE, title: 'Lesson plan' })
    if (opened.isPlaced) return { text: 'Plan pane opened.' }
    return { text: planLines(lesson.plan, planStatuses(lesson.plan, lesson.tags)).join('\n') }
  })

  on('command.run', { command: 'graph' }, async $ => ({ text: startExtraction($) }))

  on('command.run', { command: 'graph-import' }, async ($, e) => {
    if (!e.args.trim()) return { text: 'Usage: /graph-import <note.md>' }
    const path = await resolvePath($, e.args)
    if (!(await $.fs.exists(path))) return { text: `File does not exist: ${path}` }
    $.clock.after(0, async () => {
      try {
        report(await importNotes($, path), $)
      } catch (err) {
        report(`Import failed: ${fail(err)}`, $)
      }
    })
    return { text: `Importing ${basename(path)} in the background; it reports when done.` }
  })

  // --- auto-log: /teach opens a new lesson note in Obsidian ---

  on('command.run', { command: 'teach' }, teachCommand).catch(($, e, next) => next(e))
  on('command.run', { command: 'learn:teach' }, teachCommand).catch(($, e, next) => next(e))
  on('command.run', { command: 'practice' }, practiceCommand).catch(($, e, next) => next(e))
  on('command.run', { command: 'learn:practice' }, practiceCommand).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (isTeachSkill(e.skill)) await autoLog($, String(e.args ?? '').trim())
    else if (isPracticeSkill(e.skill)) await autoLog($, `practice ${String(e.args ?? '').trim()}`.trim())
    return next(e)
  }).catch(($, e, next) => next(e))

  // --- the learn tools ---

  on('tool.call', { tool: QUIZ_TOOL }, serveTool).catch(toolFailed)
  on('tool.call', { tool: EXPLAIN_TOOL }, serveTool).catch(toolFailed)
  on('tool.call', { tool: PROBE_TOOL }, serveTool).catch(toolFailed)
  on('tool.call', { tool: RECALL_TOOL }, serveTool).catch(toolFailed)
  on('tool.call', { tool: PROBE_DONE_TOOL }, serveTool).catch(toolFailed)
  on('tool.call', { tool: PLAN_TOOL }, serveTool).catch(toolFailed)
  on('tool.call', { tool: PROBLEM_TOOL }, serveTool).catch(toolFailed)
  on('tool.call', { tool: CONCLUDE_TOOL }, serveTool).catch(toolFailed)
  on('tool.call', { tool: GRAPH_SESSIONS_TOOL }, serveTool).catch(toolFailed)
  on('tool.call', { tool: GRAPH_PROPOSITIONS_TOOL }, serveTool).catch(toolFailed)
  on('tool.call', { tool: GRAPH_FIND_TOOL }, serveTool).catch(toolFailed)
  on('tool.call', { tool: GRAPH_EXTRACT_TOOL }, serveTool).catch(toolFailed)

  // The call rows never show what he must not see yet: no correct answers,
  // explanations or model solutions while he works.
  on('ui.render', { component: 'ToolUse', props: { tool: QUIZ_TOOL } }, hideAnswers)
  on('ui.render', { component: 'ToolUse', props: { tool: EXPLAIN_TOOL } }, hideAnswers)
  on('ui.render', { component: 'ToolUse', props: { tool: PROBE_TOOL } }, hideAnswers)
  on('ui.render', { component: 'ToolUse', props: { tool: RECALL_TOOL } }, hideAnswers)
  on('ui.render', { component: 'ToolUse', props: { tool: PROBLEM_TOOL } }, hideAnswers)

  // Under a question or a concluded problem: the feedback he has earned.
  on('ui.render', { component: 'ToolResult', props: { tool: QUIZ_TOOL } }, drawFeedback)
  on('ui.render', { component: 'ToolResult', props: { tool: EXPLAIN_TOOL } }, drawFeedback)
  on('ui.render', { component: 'ToolResult', props: { tool: PROBE_TOOL } }, drawFeedback)
  on('ui.render', { component: 'ToolResult', props: { tool: RECALL_TOOL } }, drawFeedback)
  on('ui.render', { component: 'ToolResult', props: { tool: CONCLUDE_TOOL } }, drawFeedback)

  // --- the plan pane ---

  on('ui.render', { component: 'Pane', requestId: PLAN_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = await read($, planView)
    if (!view) return <Text dimColor>No plan yet.</Text>
    const mark = { current: '●', visited: '✓', upcoming: '○' } as const
    return (
      <Box flexDirection="column">
        <Text bold>{view.topic ? `${view.topic} · ${view.summary}` : view.summary}</Text>
        {view.rows.map(row => (
          <Text bold={row.status === 'current'} dimColor={row.status === 'upcoming'}>
            {mark[row.status]} {row.title}
            {row.needs.length ? <Text dimColor>{`  ← ${row.needs.join(', ')}`}</Text> : ''}
          </Text>
        ))}
      </Box>
    )
  })

  // --- the plugin's own render scripts run without a prompt ---

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const command = String((e.input as any)?.command ?? '').trim()
    return isPluginScript($.plugin.root, command) ? { decision: 'allow' as const, reason: 'learn: its own render script' } : next(e)
  })

  // --- md-log mirroring ---

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!logFile || quizAsking > 0) return next(e)
    for (const block of askQuestionBlocks(e)) await appendBlock($, block)
    const ran = await next(e)
    await appendBlock($, ran.deny !== undefined || ran.isError ? askAnswerCallout(undefined) : askAnswerBlock(e, ran.result))
    return ran
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (!logFile || e.agentId) return stored
    const msg = e.message
    if ((e.door === 'prompt' || e.door === 'command') && msg.type === 'user' && !msg.isMeta) {
      const block = userRowBlock(textOf(msg.content))
      if (block) await appendBlock($, block)
    } else if (e.door === 'response' && msg.role === 'assistant') {
      const text = textOf(msg.content).trim()
      if (text) await appendBlock($, assistantBlock(text))
    }
    return stored
  }).catch(($, e, next) => next(e))
}

