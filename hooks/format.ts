// Pure helpers for the learn mod: quiz grading and the md-log callout format.
// Kept free of `$` so tests can exercise them directly.

export const DONT_KNOW_LABEL = "I don't know"
export const MAX_QUIZ_OPTIONS = 3 // the dialog holds 4 choices; one is "I don't know"

export interface QuizOption {
  label: string
  value: string
  description?: string
}

export interface QuizInput {
  question: string
  details?: string
  options: Array<{ label: string; value?: string; description?: string }>
  multiSelect?: boolean
  correctAnswer: string | string[]
  explanation: string
  shuffle?: boolean
}

export interface DisplayedOption {
  index: number // 1-based, in display order
  label: string
}

export type QuizOutcome =
  | { kind: 'graded'; picked: number[]; correct: boolean }
  | { kind: 'dont-know' }
  | { kind: 'freeform'; text: string }
  | { kind: 'cancelled' }

export function normalizeOptions(options: QuizInput['options']): QuizOption[] {
  const seenValues = new Set<string>()
  const seenLabels = new Set<string>()
  const out: QuizOption[] = []
  for (const option of options ?? []) {
    const label = String(option.label ?? '').trim()
    if (!label) continue
    const value = String(option.value ?? '').trim() || label
    if (seenValues.has(value)) throw new Error(`duplicate option value "${value}"`)
    if (seenLabels.has(label)) throw new Error(`duplicate option label "${label}"`)
    if (label === DONT_KNOW_LABEL) throw new Error(`"${DONT_KNOW_LABEL}" is added automatically; don't pass it as an option`)
    seenValues.add(value)
    seenLabels.add(label)
    out.push({ label, value, description: option.description?.trim() || undefined })
  }
  if (out.length < 2) throw new Error('a quiz needs at least 2 options')
  if (out.length > MAX_QUIZ_OPTIONS) {
    throw new Error(`at most ${MAX_QUIZ_OPTIONS} options per quiz (the dialog shows 4 choices and one is "I don't know"); cut the weakest distractor`)
  }
  return out
}

// The harness may deliver a multi-select array JSON-stringified; parse it back.
export function coerceCorrectAnswer(correctAnswer: string | string[]): string[] {
  if (Array.isArray(correctAnswer)) return correctAnswer.map(String)
  const trimmed = String(correctAnswer ?? '').trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      // a literal value that happens to look like an array
    }
  }
  return [trimmed]
}

// Resolve correct values to 1-based indices of `options` (already in display order).
export function resolveCorrect(correctAnswer: string | string[], options: QuizOption[]): number[] {
  const values = coerceCorrectAnswer(correctAnswer).map(v => v.trim())
  if (values.length === 0 || values.every(v => !v)) throw new Error('correctAnswer is required')
  const byValue = new Map(options.map((o, i) => [o.value, i + 1]))
  const indices = values.map(v => {
    const idx = byValue.get(v)
    if (idx === undefined) {
      throw new Error(`correctAnswer "${v}" does not match any option value (${options.map(o => `"${o.value}"`).join(', ')})`)
    }
    return idx
  })
  return [...new Set(indices)].sort((a, b) => a - b)
}

// Fisher-Yates over a copy; `random` is injectable for tests.
export function shuffled<T>(items: T[], random: () => number = Math.random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = out[i] as T
    out[i] = out[j] as T
    out[j] = tmp
  }
  return out
}

// Turn the dialog's answer string back into picks. Multi-select answers are
// comma-joined and labels may hold commas, so match whole labels instead of
// splitting: find the subset of labels whose join reproduces the answer.
export function interpretAnswer(answer: string | undefined, labels: string[], multiSelect: boolean): QuizOutcome {
  if (answer === undefined) return { kind: 'cancelled' }
  const text = answer.trim()
  if (!text) return { kind: 'cancelled' }
  if (text === DONT_KNOW_LABEL) return { kind: 'dont-know' }
  const single = labels.indexOf(text)
  if (single !== -1) return { kind: 'graded', picked: [single + 1], correct: false }
  if (multiSelect) {
    const all = [...labels, DONT_KNOW_LABEL]
    const n = all.length
    for (let mask = 1; mask < 1 << n; mask++) {
      const chosen = all.filter((_, i) => mask & (1 << i))
      for (const sep of [', ', ',']) {
        if (chosen.join(sep) === text) {
          if (chosen.includes(DONT_KNOW_LABEL)) return { kind: 'dont-know' }
          return { kind: 'graded', picked: chosen.map(l => labels.indexOf(l) + 1), correct: false }
        }
      }
    }
  }
  return { kind: 'freeform', text }
}

export function grade(outcome: QuizOutcome, correctIndices: number[]): QuizOutcome {
  if (outcome.kind !== 'graded') return outcome
  const picked = [...outcome.picked].sort((a, b) => a - b)
  const correct = picked.length === correctIndices.length && picked.every((p, i) => p === correctIndices[i])
  return { ...outcome, picked, correct }
}

const numbered = (indices: number[], options: DisplayedOption[]) =>
  indices.map(i => `${i}. ${options[i - 1]?.label ?? '?'}`).join(', ')

// What the learner adds beside a pick: a confidence and his thinking.
export interface AnswerExtras {
  confidence?: number // 0-100, his stated probability that his pick is right
  thinking?: string
}

// Asked right after his pick, before he sees the verdict.
export const CONFIDENCE_QUESTION = 'How sure are you of that answer? Or type a percentage under Other.'
export const CONFIDENCE_OPTIONS = [
  { label: 'Certain (95%)', percent: 95 },
  { label: 'Likely (75%)', percent: 75 },
  { label: 'Coin flip (50%)', percent: 50 },
  { label: 'Doubtful (25%)', percent: 25 },
] as const

// A confidence label, or typed text: a leading number is the percentage and
// the rest his thinking ("60 the sign flips"); text without one is thinking.
export function parseConfidence(answer: string | undefined): AnswerExtras {
  const text = answer?.trim()
  if (!text) return {}
  const named = CONFIDENCE_OPTIONS.find(o => o.label === text)
  if (named) return { confidence: named.percent }
  const m = /^(\d{1,3}(?:\.\d+)?)\s*%?(?:[\s,.:;-]+([\s\S]*))?$/.exec(text)
  if (m) {
    const confidence = Math.max(0, Math.min(100, Math.round(Number(m[1]))))
    const thinking = m[2]?.trim()
    return thinking ? { confidence, thinking } : { confidence }
  }
  return { thinking: text }
}

// Asked after every answer, before the verdict, whatever he picked: his
// thinking typed under Other, or one of two quick answers.
export const THINKING_QUESTION = 'What were you thinking? Type it under Other — half-formed is fine.'
export const THINKING_NONE = 'Nothing to add'
export const THINKING_GUESSED = 'I was guessing'

export function parseThinking(answer: string | undefined): string | undefined {
  const text = answer?.trim()
  if (!text || text === THINKING_NONE) return undefined
  if (text === THINKING_GUESSED) return 'I was guessing.'
  return text
}

export function mergeThinking(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.map(p => p?.trim()).filter((p): p is string => !!p)
  return kept.length ? kept.join('\n\n') : undefined
}

function extrasLines(outcome: QuizOutcome, extras: AnswerExtras): string[] {
  const lines: string[] = []
  // No confidence on "I don't know": he declined to guess.
  if (extras.confidence !== undefined && outcome.kind !== 'dont-know') lines.push(`Confidence: ${extras.confidence}%`)
  if (extras.thinking) lines.push(`His thinking: ${extras.thinking}`)
  return lines
}

// What the model reads, worded as pi's quiz result.
export function quizResultText(
  outcome: QuizOutcome,
  options: DisplayedOption[],
  correctIndices: number[],
  explanation: string,
  extras: AnswerExtras = {},
): string {
  if (outcome.kind === 'cancelled') return 'User cancelled the quiz'
  const lines: string[] = []
  if (outcome.kind === 'dont-know') {
    lines.push(`User selected "I don't know" — they did not attempt an answer (a genuine knowledge gap, not a wrong guess).`)
  } else if (outcome.kind === 'freeform') {
    lines.push(`User typed their own answer instead of picking an option (ungraded — grade it yourself).`, `Typed: ${outcome.text}`)
  } else {
    lines.push(`User answered ${outcome.correct ? 'correctly' : 'incorrectly'}.`, `Selected: ${numbered(outcome.picked, options)}`)
  }
  lines.push(...extrasLines(outcome, extras))
  lines.push(`Correct: ${numbered(correctIndices, options)}`)
  if (explanation) lines.push(`Explanation: ${explanation}`)
  return lines.join('\n')
}

// What the learner sees under the quiz row, as pi's renderResult draws it:
// every option in display order with ✓/✗, the verdict, the explanation.
export function quizFeedbackLines(
  outcome: QuizOutcome,
  options: DisplayedOption[],
  correctIndices: number[],
  explanation: string,
  extras: AnswerExtras = {},
): string[] {
  if (outcome.kind === 'cancelled') return ['Cancelled']
  const picked = new Set(outcome.kind === 'graded' ? outcome.picked : [])
  const key = new Set(correctIndices)
  const lines = options.map(o => {
    // No guess (I don't know, or typed): reveal the key only, never a ✗.
    const mark = key.has(o.index) ? '✓' : picked.has(o.index) ? '✗' : ' '
    return `${mark} ${o.index}. ${o.label}`
  })
  lines.push('')
  if (outcome.kind === 'dont-know') lines.push("**I don't know**")
  else if (outcome.kind === 'freeform') lines.push(`**Your answer (ungraded):** ${outcome.text}`)
  else lines.push(outcome.correct ? '**Correct!**' : '**Incorrect**')
  const said = extrasLines(outcome, extras).map(l => l.replace(/^His thinking:/, 'Your thinking:'))
  if (said.length) lines.push('', ...said.map(l => `*${l}*`))
  if (explanation) lines.push('', explanation)
  return lines
}

// --- md-log callouts (same shapes as the pi md-log extension) ---

export function callout(type: string, title: string, bodyLines: string[]): string {
  return [`> [!${type}] ${title}`, ...bodyLines.map(line => (line.length === 0 ? '>' : `> ${line}`))].join('\n')
}

export const userBlock = (text: string) => `> [!quote] YOU\n\n${text}`
export const assistantBlock = (text: string) => `> [!abstract] CLAUDE\n\n${text}`

export function questionCallout(label: string, question: string, context: string | undefined, options: string[]): string {
  const body = question.split('\n')
  if (context) body.push('', ...context.split('\n'))
  if (options.length > 0) body.push('', ...options.map((o, i) => `${i + 1}. ${o}`))
  return callout('question', label, body)
}

export function quizAnswerCallout(
  outcome: QuizOutcome,
  options: DisplayedOption[],
  correctIndices: number[],
  explanation: string,
  extras: AnswerExtras = {},
  label = 'Quiz',
): string {
  if (outcome.kind === 'cancelled') return callout('warning', `${label} — cancelled`, ['(user skipped)'])
  const correctLine = `Correct answer: ${correctIndices.join(', ')}`
  const body: string[] = []
  let type: string
  let title: string
  if (outcome.kind === 'dont-know') {
    type = 'question'
    title = `${label} — I don't know`
    body.push("Your answer: I don't know")
  } else if (outcome.kind === 'freeform') {
    type = 'question'
    title = `${label} — own words`
    body.push(`Your answer: ${outcome.text}`)
  } else {
    type = outcome.correct ? 'success' : 'failure'
    title = outcome.correct ? `${label} — correct ✓` : `${label} — incorrect ✗`
    body.push(`Your answer: ${outcome.picked.map(i => `${i}. ${options[i - 1]?.label ?? '?'}`).join(', ')}`)
  }
  body.push(correctLine)
  if (extras.confidence !== undefined && outcome.kind !== 'dont-know') body.push(`Confidence: ${extras.confidence}%`)
  if (extras.thinking) body.push(`Your thinking: ${extras.thinking.replace(/\n+/g, ' ')}`)
  if (explanation) body.push('', ...explanation.split('\n'))
  return callout(type, title, body)
}

export function askAnswerCallout(answers: string[] | undefined): string {
  if (!answers) return callout('warning', 'Question — cancelled', ['(user skipped)'])
  return callout('example', 'Answer', answers.length ? answers : ['(no answer)'])
}

// --- explain: free recall graded against a committed answer ---

export const EXPLAIN_DONT_KNOW = "I don't know"
export const EXPLAIN_IN_CHAT = 'Answer in chat'

export type ExplainOutcome =
  | { kind: 'answered'; text: string }
  | { kind: 'dont-know' }
  | { kind: 'in-chat' }
  | { kind: 'cancelled' }

export function interpretExplain(answer: string | undefined): ExplainOutcome {
  const text = answer?.trim()
  if (!text) return { kind: 'cancelled' }
  if (text === EXPLAIN_DONT_KNOW) return { kind: 'dont-know' }
  if (text === EXPLAIN_IN_CHAT) return { kind: 'in-chat' }
  return { kind: 'answered', text }
}

export function explainResultText(outcome: ExplainOutcome, committed: string): string {
  switch (outcome.kind) {
    case 'cancelled':
      return 'User cancelled the question'
    case 'dont-know':
      return `User said "I don't know": a genuine gap, not a wrong answer. He has now seen your committed answer.\nCommitted answer: ${committed}`
    case 'in-chat':
      return 'He will answer in his next message, in his own words. Grade that message strictly against your committed answer (never revise the commitment after seeing his words), then show him the committed answer.'
    case 'answered':
      return [
        'His answer, in his own words (grade it strictly against your committed answer; name what he got and what he missed):',
        outcome.text,
        `Committed answer (he sees it now): ${committed}`,
      ].join('\n')
  }
}

export function explainFeedbackLines(outcome: ExplainOutcome, committed: string): string[] {
  if (outcome.kind === 'cancelled') return ['Cancelled']
  if (outcome.kind === 'in-chat') return ['*Answer in chat; the committed answer is shown after Claude grades it.*']
  const head = outcome.kind === 'dont-know' ? "**I don't know**" : `**Your answer:** ${outcome.text}`
  return [head, '', '**Committed answer:**', '', committed]
}

export function explainAnswerCallout(outcome: ExplainOutcome, committed: string, label = 'Explain'): string {
  if (outcome.kind === 'cancelled') return callout('warning', `${label} — cancelled`, ['(user skipped)'])
  if (outcome.kind === 'in-chat') return callout('note', `${label} — answering in chat`, ['(his answer is the next message)'])
  const body = outcome.kind === 'dont-know' ? ["Your answer: I don't know"] : ['Your answer:', ...outcome.text.split('\n')]
  body.push('', 'Committed answer:', ...committed.split('\n'))
  return callout('question', `${label} — ${outcome.kind === 'dont-know' ? "I don't know" : 'own words'}`, body)
}

// --- probe, plan and practice callouts ---

export interface ProbeStrand {
  strand: string
  assessment: string
}

export function probeCallout(strands: ProbeStrand[], summary?: string): string {
  const body: string[] = []
  if (summary) body.push(...summary.split('\n'), '')
  for (const s of strands) body.push(`**${s.strand}**: ${s.assessment.replace(/\n+/g, ' ')}`, '')
  if (body.at(-1) === '') body.pop()
  return callout('info', 'Probe — where you stand', body)
}

export function planCallout(mermaid: string, revision: number): string {
  return callout('tip', revision > 1 ? `Plan — revised (v${revision})` : 'Plan', mermaid.split('\n'))
}

export function problemCallout(statement: string, mode: string): string {
  return callout('example', `Problem — ${mode}`, statement.split('\n'))
}

export const OUTCOME_LABELS: Record<string, string> = {
  solved: 'solved',
  solvedWithHints: 'solved with hints',
  movedOn: 'moved on',
  surrendered: 'surrendered',
  dismissed: 'dismissed',
}

export function concludeCallout(outcome: string, verdict: string, modelSolution: string | undefined): string {
  const type = outcome === 'solved' ? 'success' : outcome === 'solvedWithHints' ? 'tip' : 'failure'
  const body = [...verdict.split('\n')]
  if (modelSolution) body.push('', '**Model solution**', '', ...modelSolution.split('\n'))
  return callout(type, `Problem — ${OUTCOME_LABELS[outcome] ?? outcome}`, body)
}

// The lesson note's file name: the topic in kebab case, or the date.
export function noteSlug(topic: string, today: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return slug || `lesson-${today}`
}

// --- cleaning transcript text for the log ---

// Engine-injected wrappers that are not the learner's prose.
export function cleanUserText(text: string): string {
  let out = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(out)?.[1]?.trim()
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(out)?.[1]?.trim()
    return `\`${name.startsWith('/') ? name : '/' + name}${args ? ' ' + args : ''}\``
  }
  out = out.replace(/<local-command-(stdout|stderr|caveat)>[\s\S]*?<\/local-command-\1>/g, '')
  return out.trim()
}

export const SILENT_COMMANDS = new Set(['/md-log', '/md-unlog', '/learn', '/map', '/graph', '/graph-import'])

export function isSilentCommand(cleaned: string): boolean {
  const m = /^`(\/[\w:-]+)/.exec(cleaned)
  return !!m?.[1] && SILENT_COMMANDS.has(m[1])
}

// A skill's body arrives as a user row; log a one-line note instead.
export function skillNote(text: string): string | undefined {
  const m = /^Base directory for this skill: .*\/skills\/([^/\s]+)/.exec(text.trim())
  return m ? `> [!note] SKILL loaded: ${m[1]}` : undefined
}
