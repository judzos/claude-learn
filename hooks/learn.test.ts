import { expect, mock, test } from 'claude-code/testing'

import { cleanUserText, grade, interpretAnswer, normalizeOptions, noteSlug, quizAnswerCallout, resolveCorrect } from './format'

const QUESTION = 'Which planet is closest to the Sun?'
const OPTIONS = [
  { label: 'Mercury', value: 'mercury' },
  { label: 'Venus', value: 'venus' },
  { label: 'Mars, the red one', value: 'mars' },
]

test('grading keys the correct answer by value and survives commas in labels', async () => {
  const options = normalizeOptions(OPTIONS)
  const labels = options.map(o => o.label)
  const correct = resolveCorrect('mercury', options)
  expect(correct).toEqual([1])
  expect(grade(interpretAnswer('Mercury', labels, false), correct)).toEqual({ kind: 'graded', picked: [1], correct: true })
  expect(grade(interpretAnswer('Venus', labels, false), correct)).toEqual({ kind: 'graded', picked: [2], correct: false })
  expect(interpretAnswer("I don't know", labels, false)).toEqual({ kind: 'dont-know' })
  expect(interpretAnswer('the hot one', labels, false)).toEqual({ kind: 'freeform', text: 'the hot one' })

  const multi = resolveCorrect('["venus","mars"]', options)
  expect(grade(interpretAnswer('Venus, Mars, the red one', labels, true), multi)).toEqual({ kind: 'graded', picked: [2, 3], correct: true })
})

test('option limits and bad answers are refused with a reason', async () => {
  expect(() => normalizeOptions([...OPTIONS, { label: 'Earth', value: 'earth' }])).toThrow(/at most 3/)
  expect(() => resolveCorrect('pluto', normalizeOptions(OPTIONS))).toThrow(/does not match/)
})

test('the log callout never leaks the answer before grading and matches pi format after', async () => {
  const shown = [{ index: 1, label: 'Mercury' }, { index: 2, label: 'Venus' }]
  const block = quizAnswerCallout({ kind: 'graded', picked: [2], correct: false }, shown, [1], 'Mercury orbits innermost.')
  expect(block).toStartWith('> [!failure] Quiz — incorrect ✗')
  expect(block).toContain('> Your answer: 2. Venus')
  expect(block).toContain('> Correct answer: 1')
})

test('command rows render as the typed command', async () => {
  expect(cleanUserText('<command-name>/teach</command-name>\n<command-message>teach</command-message>\n<command-args>TCP</command-args>')).toBe('`/teach TCP`')
  expect(cleanUserText('hello <system-reminder>x</system-reminder>')).toBe('hello')
})

test('the quiz tool asks through AskUserQuestion and grades the pick', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }) as any)
  let asked: any
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    asked ??= e
    return { result: { questions: (e as any).questions, answers: { [QUESTION]: 'Venus' } } } as any
  })
  const ran = await $.tool.call({
    tool: 'mcp__learn__probe',
    question: QUESTION,
    options: OPTIONS,
    correctAnswer: 'mercury',
    explanation: 'Mercury orbits innermost.',
    shuffle: false,
  } as any)
  expect(ran.deny).toBeUndefined()
  expect(asked.questions[0].options.map((o: any) => o.label)).toEqual(['Mercury', 'Venus', 'Mars, the red one', "I don't know"])
  expect(asked.questions[0].header).toBe("Quiz")
  expect(String(ran.result)).toStartWith('User answered incorrectly.')
  expect(String(ran.result)).toContain('Selected: 2. Venus')
  expect(String(ran.result)).toContain('Correct: 1. Mercury')
  expect(String(ran.result)).toContain('Explanation: Mercury orbits innermost.')
})

test("I don't know reaches the model as a knowledge gap, worded as pi's", async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }) as any)
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    return { result: { questions: (e as any).questions, answers: { [QUESTION]: "I don't know" } } } as any
  })
  const ran = await $.tool.call({
    tool: 'mcp__learn__probe',
    question: QUESTION,
    options: OPTIONS,
    correctAnswer: 'mercury',
    explanation: 'Mercury orbits innermost.',
    shuffle: false,
  } as any)
  expect(String(ran.result)).toContain('genuine knowledge gap, not a wrong guess')
  expect(String(ran.result)).toContain('Correct: 1. Mercury')
})

test('a malformed quiz is refused, not asked', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }) as any)
  let wasAsked = false
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    wasAsked = true
    return { result: {} } as any
  })
  const ran = await $.tool.call({ tool: 'mcp__learn__probe', question: 'Q?', options: OPTIONS, correctAnswer: 'pluto', explanation: 'x' } as any)
  expect(ran.deny).toMatch(/does not match/)
  expect(wasAsked).toBe(false)
})

test('/md-log links a note, then mirrors prompts, replies and quizzes into it', async ($, on) => {
  mock.store(on)
  const files: Record<string, string> = { '/vault/lesson.md': '' }
  on('session.id', () => ({ value: 'S1' }) as any)
  on('session.cwd', () => ({ value: '/vault' }) as any)
  on('session.messages', () => ({ value: [] }) as any)
  on('fs.stat', ($, e: any) => {
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } } as any
  })
  on('fs.exists', ($, e: any) => ({ value: e.path in files }) as any)
  on('fs.read', ($, e: any) => ({ value: files[e.path] ?? '' }) as any)
  on('fs.write', ($, e: any) => {
    files[e.path] = e.text
    return { value: undefined } as any
  })
  on('ui.status', () => ({ value: undefined }) as any)
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({ result: { questions: (e as any).questions, answers: { [QUESTION]: 'Mercury' } } }) as any)

  const linked = await $.command.run({ command: 'md-log', args: 'lesson.md' } as any)
  expect(linked.text).toBe('Linked: /vault/lesson.md (0 blocks backfilled)')

  await $.session.append({ door: 'prompt', origin: { kind: 'composer' }, uuid: 'u1', message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'teach me orbits' }] } } as any)
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'a1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Start from gravity.' }] } } as any)
  await $.tool.call({ tool: 'mcp__learn__probe', question: QUESTION, options: OPTIONS, correctAnswer: 'mercury', explanation: 'Innermost.', shuffle: false } as any)

  const log = files['/vault/lesson.md']!
  expect(log).toContain('> [!quote] YOU\n\nteach me orbits')
  expect(log).toContain('> [!abstract] CLAUDE\n\nStart from gravity.')
  expect(log).toContain(`> [!question] Quiz\n> ${QUESTION}\n>\n> 1. Mercury`)
  expect(log).toContain('> [!success] Quiz — correct ✓')
  expect(log.indexOf('[!question] Quiz')).toBeLessThan(log.indexOf('[!success]'))
})

function autoLogWorld(on: any, cwd: string, existing: Record<string, string> = {}) {
  const files: Record<string, string> = {
    '/home/u/.config/obsidian/obsidian.json': JSON.stringify({ vaults: { a: { path: '/home/u/Desktop/learn' } } }),
    ...existing,
  }
  const runs: string[][] = []
  on('session.id', () => ({ value: 'S1' }) as any)
  on('session.cwd', () => ({ value: cwd }) as any)
  on('session.messages', () => ({ value: [] }) as any)
  on('fs.exists', ($: any, e: any) => ({ value: e.path in files }) as any)
  on('fs.read', ($: any, e: any) => ({ value: files[e.path] ?? '' }) as any)
  on('fs.write', ($: any, e: any) => {
    files[e.path] = e.text
    return { value: undefined } as any
  })
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv)
    const out = e.argv[0] === 'printenv' ? '/home/u\n' : e.argv[0] === 'uname' ? 'Linux\n' : ''
    return { value: { exitCode: 0, stdout: out, stderr: '' } } as any
  })
  on('ui.status', () => ({ value: undefined }) as any)
  on('ui.toast', () => ({ value: undefined }) as any)
  on('ui.log', () => ({ value: undefined }) as any)
  return { files, runs }
}

test('noteSlug kebab-cases the topic and falls back to the date', async () => {
  expect(noteSlug('TCP Congestion Control!', '2026-10-21')).toBe('tcp-congestion-control')
  expect(noteSlug('  ', '2026-10-21')).toBe('lesson-2026-10-21')
})

test('/teach in a vault folder starts a new note there and opens it in Obsidian', async ($, on) => {
  mock.store(on)
  const { files, runs } = autoLogWorld(on, '/home/u/Desktop/learn', { '/home/u/Desktop/learn/orbits.md': 'old' })
  on('command.run', { command: 'teach' }, () => ({ text: '' }) as any)
  await $.command.run({ command: 'teach', args: 'Orbits' } as any)
  expect('/home/u/Desktop/learn/orbits-2.md' in files).toBe(true)
  expect(files['/home/u/Desktop/learn/orbits.md']).toBe('old')
  expect(runs).toContainEqual(['setsid', '-f', 'xdg-open', 'obsidian://open?path=%2Fhome%2Fu%2FDesktop%2Flearn%2Forbits-2.md'])
})

test('outside any vault the note goes to the learn vault logs folder', async ($, on) => {
  mock.store(on)
  const { files } = autoLogWorld(on, '/tmp/elsewhere')
  on('tool.call', { tool: 'Skill' }, () => ({ result: { success: true, commandName: 'teach' } }) as any)
  await $.tool.call({ tool: 'Skill', skill: 'teach', args: 'Linear algebra' } as any)
  expect('/home/u/Desktop/learn/logs/linear-algebra.md' in files).toBe(true)
})

test('an already linked note is kept and no new one is made', async ($, on) => {
  mock.store(on)
  const { files, runs } = autoLogWorld(on, '/home/u/Desktop/learn', { '/home/u/Desktop/learn/mine.md': '' })
  on('fs.stat', () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }) as any)
  on('command.run', { command: 'teach' }, () => ({ text: '' }) as any)
  await $.command.run({ command: 'md-log', args: 'mine.md' } as any)
  await $.command.run({ command: 'teach', args: 'Orbits' } as any)
  expect('/home/u/Desktop/learn/orbits.md' in files).toBe(false)
  expect(runs.some(r => r.includes('xdg-open'))).toBe(false)
})
