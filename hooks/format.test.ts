import { expect, test } from 'claude-code/testing'

import {
  askAnswerCallout,
  callout,
  cleanUserText,
  coerceCorrectAnswer,
  concludeCallout,
  explainAnswerCallout,
  explainFeedbackLines,
  explainResultText,
  grade,
  interpretAnswer,
  interpretExplain,
  isSilentCommand,
  mergeThinking,
  normalizeOptions,
  noteSlug,
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
} from './format'

const SHOWN = [
  { index: 1, label: 'Mercury' },
  { index: 2, label: 'Venus' },
  { index: 3, label: 'Mars' },
]

test('options are trimmed, default their value to the label, and skip blanks', async () => {
  expect(normalizeOptions([{ label: '  Mercury ' }, { label: '' }, { label: 'Venus', value: ' v ', description: '  ' }])).toEqual([
    { label: 'Mercury', value: 'Mercury', description: undefined },
    { label: 'Venus', value: 'v', description: undefined },
  ])
})

test('duplicate, reserved or too few options are refused', async () => {
  expect(() => normalizeOptions([{ label: 'A', value: 'x' }, { label: 'B', value: 'x' }])).toThrow(/duplicate option value "x"/)
  expect(() => normalizeOptions([{ label: 'A', value: '1' }, { label: 'A', value: '2' }])).toThrow(/duplicate option label "A"/)
  expect(() => normalizeOptions([{ label: 'A' }, { label: "I don't know" }])).toThrow(/added automatically/)
  expect(() => normalizeOptions([{ label: 'A' }])).toThrow(/at least 2 options/)
})

test('a correct answer may arrive as an array, a JSON string or a plain value', async () => {
  expect(coerceCorrectAnswer(['a', 'b'])).toEqual(['a', 'b'])
  expect(coerceCorrectAnswer(' ["a","b"] ')).toEqual(['a', 'b'])
  expect(coerceCorrectAnswer('[not json]')).toEqual(['[not json]'])
  expect(coerceCorrectAnswer(' a ')).toEqual(['a'])

  const options = normalizeOptions([{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'C', value: 'c' }])
  expect(resolveCorrect(['c', 'a', 'c'], options)).toEqual([1, 3])
  expect(() => resolveCorrect('  ', options)).toThrow(/correctAnswer is required/)
})

test('shuffling copies the list and uses the injected random', async () => {
  const items = ['a', 'b', 'c']
  expect(shuffled(items, () => 0)).toEqual(['b', 'c', 'a'])
  expect(shuffled(items, () => 0.99)).toEqual(['a', 'b', 'c'])
  expect(items).toEqual(['a', 'b', 'c'])
})

test('answers: cancelled, multi-select joins, and I-don\'t-know inside a multi pick', async () => {
  const labels = SHOWN.map(o => o.label)
  expect(interpretAnswer(undefined, labels, false)).toEqual({ kind: 'cancelled' })
  expect(interpretAnswer('   ', labels, false)).toEqual({ kind: 'cancelled' })
  expect(interpretAnswer('Mercury,Mars', labels, true)).toEqual({ kind: 'graded', picked: [1, 3], correct: false })
  expect(interpretAnswer("Venus, I don't know", labels, true)).toEqual({ kind: 'dont-know' })
  expect(interpretAnswer('Mercury, Mars', labels, false)).toEqual({ kind: 'freeform', text: 'Mercury, Mars' })
})

test('grading needs the exact set and passes other outcomes through', async () => {
  expect(grade({ kind: 'graded', picked: [3, 1], correct: false }, [1, 3])).toEqual({ kind: 'graded', picked: [1, 3], correct: true })
  expect(grade({ kind: 'graded', picked: [1], correct: true }, [1, 3])).toEqual({ kind: 'graded', picked: [1], correct: false })
  expect(grade({ kind: 'dont-know' }, [1])).toEqual({ kind: 'dont-know' })
})

test('confidence is clamped and rounded, and thinking is merged', async () => {
  expect(parseConfidence('150')).toEqual({ confidence: 100 })
  expect(parseConfidence('75.6%')).toEqual({ confidence: 76 })
  expect(parseConfidence('80%: because')).toEqual({ confidence: 80, thinking: 'because' })
  expect(parseConfidence('   ')).toEqual({})
  expect(mergeThinking(' a ', undefined, '', 'b')).toBe('a\n\nb')
  expect(mergeThinking(undefined, ' ')).toBeUndefined()
})

test('the model reads the result of every kind of answer', async () => {
  expect(quizResultText({ kind: 'cancelled' }, SHOWN, [1], 'x')).toBe('User cancelled the quiz')
  expect(quizResultText({ kind: 'graded', picked: [1], correct: true }, SHOWN, [1], 'Innermost.', { confidence: 75, thinking: 'hot' })).toBe(
    ['User answered correctly.', 'Selected: 1. Mercury', 'Confidence: 75%', 'His thinking: hot', 'Correct: 1. Mercury', 'Explanation: Innermost.'].join('\n'),
  )
  const typed = quizResultText({ kind: 'freeform', text: 'the hot one' }, SHOWN, [1], '')
  expect(typed).toContain('Typed: the hot one')
  expect(typed).not.toContain('Explanation')
})

test('the learner sees ✓ on the key and ✗ only on a wrong pick', async () => {
  expect(quizFeedbackLines({ kind: 'graded', picked: [2], correct: false }, SHOWN, [1], 'Innermost.', { thinking: 'hot' })).toEqual([
    '✓ 1. Mercury',
    '✗ 2. Venus',
    '\u2003 3. Mars', // an em space keeps the column
    '',
    '**Incorrect**',
    '',
    '*Your thinking: hot*',
    '',
    'Innermost.',
  ])
  const unsure = quizFeedbackLines({ kind: 'dont-know' }, SHOWN, [1], '')
  expect(unsure).not.toContain('✗')
  expect(unsure.at(-1)).toBe("**I don't know**")
  expect(quizFeedbackLines({ kind: 'cancelled' }, SHOWN, [1], '')).toEqual(['Cancelled'])
})

test('callouts quote every line and mark blank ones', async () => {
  expect(callout('note', 'Title', ['a', '', 'b'])).toBe('> [!note] Title\n> a\n>\n> b')
  expect(questionCallout('Quiz 1', 'Which?', 'Context', ['A', 'B'])).toBe('> [!question] Quiz 1\n> Which?\n>\n> Context\n>\n> 1. A\n> 2. B')
  expect(askAnswerCallout(undefined)).toBe('> [!warning] Question — cancelled\n> (user skipped)')
  expect(askAnswerCallout([])).toBe('> [!example] Answer\n> (no answer)')
})

test('quiz log callouts for each outcome', async () => {
  expect(quizAnswerCallout({ kind: 'cancelled' }, SHOWN, [1], 'x')).toBe('> [!warning] Quiz — cancelled\n> (user skipped)')
  const right = quizAnswerCallout({ kind: 'graded', picked: [1], correct: true }, SHOWN, [1], '', { confidence: 95, thinking: 'one\n\ntwo' }, 'Quiz 2')
  expect(right).toBe('> [!success] Quiz 2 — correct ✓\n> Your answer: 1. Mercury\n> Correct answer: 1\n> Confidence: 95%\n> Your thinking: one two')
  const unsure = quizAnswerCallout({ kind: 'dont-know' }, SHOWN, [1], '', { confidence: 50 })
  expect(unsure).toStartWith("> [!question] Quiz — I don't know")
  expect(unsure).not.toContain('Confidence')
  expect(quizAnswerCallout({ kind: 'freeform', text: 'hot' }, SHOWN, [1], '')).toStartWith('> [!question] Quiz — own words\n> Your answer: hot')
})

test('explain answers are read, graded against the commitment, and logged', async () => {
  expect(interpretExplain(undefined)).toEqual({ kind: 'cancelled' })
  expect(interpretExplain("I don't know")).toEqual({ kind: 'dont-know' })
  expect(interpretExplain('Answer in chat')).toEqual({ kind: 'in-chat' })
  expect(interpretExplain(' because ')).toEqual({ kind: 'answered', text: 'because' })

  expect(explainResultText({ kind: 'cancelled' }, 'C')).toBe('User cancelled the question')
  expect(explainResultText({ kind: 'dont-know' }, 'C')).toContain('Committed answer: C')
  expect(explainResultText({ kind: 'in-chat' }, 'C')).toMatch(/never revise the commitment/)
  expect(explainResultText({ kind: 'answered', text: 'mine' }, 'C').split('\n').slice(1)).toEqual(['mine', 'Committed answer (he sees it now): C'])

  expect(explainFeedbackLines({ kind: 'answered', text: 'mine' }, 'C')).toEqual(['**Your answer:** mine', '', '**Committed answer:**', '', 'C'])
  expect(explainFeedbackLines({ kind: 'in-chat' }, 'C')).toEqual(['*Answer in chat; the committed answer is shown after Claude grades it.*'])

  expect(explainAnswerCallout({ kind: 'answered', text: 'a\nb' }, 'C')).toBe('> [!question] Explain — own words\n> Your answer:\n> a\n> b\n>\n> Committed answer:\n> C')
  expect(explainAnswerCallout({ kind: 'in-chat' }, 'C')).toBe('> [!note] Explain — answering in chat\n> (his answer is the next message)')
  expect(explainAnswerCallout({ kind: 'cancelled' }, 'C', 'Recall')).toStartWith('> [!warning] Recall — cancelled')
})

test('probe, plan and problem callouts', async () => {
  expect(probeCallout([{ strand: 'Limits', assessment: 'solid\nfast' }, { strand: 'Series', assessment: 'shaky' }], 'Overall ok')).toBe(
    '> [!info] Probe — where you stand\n> Overall ok\n>\n> **Limits**: solid fast\n>\n> **Series**: shaky',
  )
  expect(planCallout('graph TD\n  a', 1)).toBe('> [!tip] Plan\n> graph TD\n>   a')
  expect(planCallout('graph TD', 3)).toStartWith('> [!tip] Plan — revised (v3)')
  expect(problemCallout('Find x', 'guided')).toBe('> [!example] Problem — guided\n> Find x')
  expect(concludeCallout('solved', 'Clean.', undefined)).toBe('> [!success] Problem — solved\n> Clean.')
  expect(concludeCallout('solvedWithHints', 'Ok.', 'x = 2')).toBe('> [!tip] Problem — solved with hints\n> Ok.\n>\n> **Model solution**\n>\n> x = 2')
  expect(concludeCallout('gaveUp', 'Hm.', undefined)).toStartWith('> [!failure] Problem — gaveUp')
})

test('long topics are cut at 60 characters without a trailing hyphen', async () => {
  const slug = noteSlug(`${'a'.repeat(59)} bcd`, '2026-10-25')
  expect(slug).toBe('a'.repeat(59))
})

test('engine wrappers are stripped and silent commands recognised', async () => {
  expect(cleanUserText('<local-command-stdout>out</local-command-stdout> hi <local-command-caveat>c</local-command-caveat>')).toBe('hi')
  expect(cleanUserText('<command-name>learn:teach</command-name>')).toBe('`/learn:teach`')
  expect(isSilentCommand('`/md-log`')).toBe(true)
  expect(isSilentCommand('`/teach TCP`')).toBe(false)
  expect(isSilentCommand('/md-log')).toBe(false)
  expect(skillNote('Base directory for this skill: /x/skills/practice\n\nbody')).toBe('> [!note] SKILL loaded: practice')
  expect(skillNote('hello')).toBeUndefined()
})
