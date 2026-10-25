// The tools the model calls: descriptions and input schemas. Mechanics only;
// what the questions should BE lives in the teach and practice skills. Wording
// ported from LearnHarness (src/agent/tools.ts, src/agent/tools/*.ts), AGPL-3.0.

export const QUIZ_TOOL = 'mcp__learn__quiz'
export const EXPLAIN_TOOL = 'mcp__learn__explain'
export const PROBE_DONE_TOOL = 'mcp__learn__probe_done'
export const PLAN_TOOL = 'mcp__learn__plan'
export const PROBLEM_TOOL = 'mcp__learn__problem'
export const CONCLUDE_TOOL = 'mcp__learn__conclude'
export const GRAPH_SESSIONS_TOOL = 'mcp__learn__graph_sessions'
export const GRAPH_PROPOSITIONS_TOOL = 'mcp__learn__graph_propositions'
export const GRAPH_FIND_TOOL = 'mcp__learn__graph_find'
export const GRAPH_EXTRACT_TOOL = 'mcp__learn__graph_extract'

const ROLE_FIELDS = {
  type: {
    type: 'string',
    enum: ['predict', 'check'],
    description:
      "The question's role in the teaching cycle. Required once the session has a plan. predict: posed BEFORE you teach the step, about the untaught next step (an attempt at discovery). check: posed AFTER the step's teaching, to verify it landed. Omit both fields while probing (before any plan).",
  },
  nodeId: {
    type: 'string',
    description: "The plan node this question is about, an exact id from this session's plan. Required once the session has a plan; validated against it. For off-map questions use AskUserQuestion.",
  },
}

export const QUIZ_DESCRIPTION = `Ask the learner a GRADED multiple-choice question with a known correct answer, then instantly grade and give feedback. Unlike AskUserQuestion (which collects preferences/decisions with no right answer), quiz always has a correct answer supplied by you, marks his selection right/wrong (✓/✗), reveals the correct answer, and shows your explanation. Single-select or multi-select, plus an automatic "I don't know" choice so he can signal a genuine gap instead of guessing.

Right after a graded pick, a second short dialog asks how sure he is (95 / 75 / 50 / 25%, or a typed percentage). Then, after every answer ("I don't know" and typed answers included), a third asks what he was thinking: typed out, "I was guessing", or nothing to add. The result gives you the verdict, his confidence and his thinking.

Mechanics:
- correctAnswer is the option value, not a position. Single-select: one string; multi-select: an array, graded as an exact-set match. A value that matches no option is a hard error. Write explanation (why the correct option is correct) BEFORE correctAnswer: reason it out first, then commit.
- 2 or 3 options (the dialog holds 4 and one is "I don't know", added automatically; never add your own opt-out option). Options are shuffled unless shuffle is false.
- He may type his own answer instead of picking; it comes back ungraded for you to grade.
- Once the session has a plan (the plan tool), every call carries type and nodeId; before that, omit them.
- ONE question per turn: call a single quiz, then end your turn; his answer determines the next.
- Every field renders markdown and LaTeX. Inside JSON strings a LaTeX backslash is \\\\ and a newline is \\n.

Example arguments:
{"type":"check","nodeId":"chain-rule","question":"A signal is $y=\\\\sin(2x)$ and $\\\\frac{dx}{dt}=3$. What is $\\\\frac{dy}{dt}$?","options":[{"label":"$6\\\\cos(2x)$","value":"a"},{"label":"$2\\\\cos(2x)$","value":"b"},{"label":"$3\\\\cos(2x)$","value":"c"}],"explanation":"The phase changes twice as fast as $x$; multiply by the sine's slope:\\n$$\\n\\\\frac{dy}{dt}=\\\\cos(2x)\\\\cdot2\\\\cdot3=6\\\\cos(2x)\\n$$","correctAnswer":"a"}
(The nodeId is illustrative: copy an exact id from this session's plan.)`

export const QUIZ_SCHEMA = {
  type: 'object',
  properties: {
    ...ROLE_FIELDS,
    question: { type: 'string', description: 'The single question to ask. Exactly one question per call.' },
    details: { type: 'string', description: 'Optional extra context shown under the question.' },
    options: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      description: 'The answer options (2 or 3). Give each a stable `value`; correctAnswer references it.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Display label: a bare claim, no justification.' },
          value: { type: 'string', description: 'Stable value correctAnswer refers to. Defaults to the label.' },
          description: { type: 'string', description: 'Optional extra detail shown below the option.' },
        },
        required: ['label'],
      },
    },
    multiSelect: { type: 'boolean', description: 'True when more than one option is correct and he must select all of them.' },
    explanation: {
      type: 'string',
      description: 'REQUIRED. Why the correct answer is correct, revealed after he answers. Written BEFORE correctAnswer by design: reason it out, then commit.',
    },
    correctAnswer: {
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      description: 'REQUIRED. The correct option value (single-select) or values (multi-select, exact set).',
    },
    shuffle: { type: 'boolean', description: 'Defaults to true. False only when option order is meaningful.' },
  },
  required: ['question', 'options', 'explanation', 'correctAnswer'],
}

export const EXPLAIN_DESCRIPTION = `Ask the learner to EXPLAIN something in his own words: a graded check with NO options; he types a free-text answer (or chooses to answer in chat, or says "I don't know"). Unlike AskUserQuestion (no right answer), explain always has one.

THE COMMITMENT RULE: correctAnswer is the FULL correct answer in your own words, reasoning included, COMMITTED before he ever sees the question. When his answer returns, grade it strictly against the commitment; never revise it after seeing his words. He sees the committed answer once he has answered.

Once the session has a plan, every call carries type and nodeId; before that, omit them. ONE question per turn: call a single explain, then end your turn.`

export const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    ...ROLE_FIELDS,
    question: { type: 'string', description: 'What he should explain. Markdown and LaTeX render.' },
    details: { type: 'string', description: 'Optional extra context shown under the question.' },
    correctAnswer: { type: 'string', description: 'REQUIRED. The full committed answer, reasoning included, written before he sees the question.' },
  },
  required: ['question', 'correctAnswer'],
}

export const PROBE_DONE_DESCRIPTION = `Conclude the probing phase and hand off to planning. Call this ONCE, when the probe is complete: every strand the lesson depends on is bracketed (a floor he reliably gets right AND a ceiling where it runs out), and his learning goal is concrete. The input IS the learner assessment: one strand per dependency the lesson will rest on, with your read of where his edge sits on it (floor, ceiling, misconceptions, what to build from), written from the evidence. It is shown to him and logged. Refused after the probe is already concluded. After it succeeds, plan in the same turn.`

export const PROBE_DONE_SCHEMA = {
  type: 'object',
  properties: {
    assessment: {
      type: 'object',
      description: "The learner assessment: the probe's distilled output.",
      properties: {
        strands: {
          type: 'array',
          minItems: 1,
          description: 'Every strand the planned lesson will depend on, each with your read of his edge on it.',
          items: {
            type: 'object',
            properties: {
              strand: { type: 'string', description: "The dependency strand (e.g. 'the derivative as a limit'): a name the plan can hang a node on." },
              assessment: {
                type: 'string',
                description: 'Where his edge sits on this strand: the floor (what he reliably gets right), the ceiling (where it runs out), misconceptions found, and what the lesson should build from.',
              },
            },
            required: ['strand', 'assessment'],
          },
        },
        summary: { type: 'string', description: 'Optional overall synthesis: his goal and where the teaching should enter.' },
      },
      required: ['strands'],
    },
  },
  required: ['assessment'],
}

export const PLAN_DESCRIPTION = `Write or REWRITE this session's plan map: the dependency graph the learner follows live (a pane, the status line, and his lesson note). Call once right after the probe concludes, to present the map; re-call whenever the map is wrong (the new block replaces the old tree wholesale).

A mermaid graph block: one node per line (\`slug[Short Title]\`; slugs are permanent lowercase ids: a-z, 0-9, hyphens/underscores), \`-->\` edges meaning "from must be understood before to" (chains fine). No subgraphs, styles or classes. A map, not a syllabus: nodes are structural landmarks (the unconditional truths at the bottom, the major stations, his goal at the sink), as many as the subject genuinely needs.

Every quiz and explain call from then on names the node it is about via nodeId; where the lesson stands derives from those tags. Nodes are never marked finished.`

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    mermaid: {
      type: 'string',
      description:
        'A mermaid graph block, e.g.:\ngraph TD\n  primitives[Number primitives] --> operators[Arithmetic operators] --> expressions[Evaluating expressions]\nThe only strict rule: ids are permanent lowercase slugs; quizzes reference them via nodeId.',
    },
  },
  required: ['mermaid'],
}

export const PROBLEM_DESCRIPTION = `Pose one practice problem. Ends the turn: the learner works on it and his thinking traces and answer claims arrive back as his messages. The modelSolution rides this call and stays hidden from him until you conclude (conclude reveals it verbatim; never re-author it). Only one problem may be active: conclude it before posing the next.`

export const PROBLEM_SCHEMA = {
  type: 'object',
  properties: {
    statement: {
      type: 'string',
      description: "REQUIRED. The problem as he sees it (markdown + LaTeX). Self-contained and solvable from the session's material. NEVER announces the target proposition.",
    },
    mode: { type: 'string', enum: ['recall', 'discrimination', 'composition'], description: 'REQUIRED. The demand mode.' },
    target: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description: 'The proposition id(s) this problem exercises, from the knowledge graph (graph_propositions / graph_find). Include when the material is in the graph; OMIT entirely when it is not. Unknown ids are rejected.',
    },
    modelSolution: {
      type: 'string',
      description: 'REQUIRED. The full solution, moves in order, committed BEFORE he sees the problem: your own worked and shortcut-hunted solution. This IS the reveal.',
    },
  },
  required: ['statement', 'mode', 'modelSolution'],
}

export const CONCLUDE_DESCRIPTION = `Conclude the active practice problem: records the outcome and verdict and reveals the committed model solution to the learner. After the result, say your closing words about his work if useful, then END YOUR TURN: no further tool calls. The next problem is NEVER posed here; it waits for his explicit go-ahead ("next", or his own words asking for the next one). Between problems, answer his questions about the concluded one. Refused when no problem is active.`

export const CONCLUDE_SCHEMA = {
  type: 'object',
  properties: {
    outcome: {
      type: 'string',
      enum: ['solved', 'solvedWithHints', 'movedOn', 'surrendered', 'dismissed'],
      description: 'REQUIRED. dismissed: he discarded the problem without finishing it.',
    },
    verdict: { type: 'string', description: 'REQUIRED. The plain-language verdict: what was credited, where it broke.' },
    rung: {
      type: ['string', 'null'],
      enum: ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', null],
      description: 'REQUIRED. The hint-ladder rung the problem needed, R0 through R5, or null when no hint was given.',
    },
    missClass: {
      type: ['string', 'null'],
      enum: ['cue', 'discrimination', 'execution', 'careless', 'structural', null],
      description: 'REQUIRED. The miss classification, or null for no miss.',
    },
    retest: { type: 'boolean', description: 'REQUIRED. True marks the problem for a fresh-surface retest before the session ends.' },
  },
  required: ['outcome', 'verdict', 'rung', 'missClass', 'retest'],
}

export const GRAPH_SESSIONS_DESCRIPTION = `List the sessions of the learner's persistent knowledge graph: every lesson or imported-notes file that ever contributed a proposition, most recent first. Each line: the session's name, kind (chat/file), how many propositions were born in it, its dates, and its id (use it with graph_propositions). Reading this first shows what he has already covered and when, before you probe anything.`

export const GRAPH_PROPOSITIONS_DESCRIPTION = `List the propositions BORN in one knowledge-graph session, with their ids and full statements: what was covered there. The ids are what practice problems target.`

export const GRAPH_PROPOSITIONS_SCHEMA = {
  type: 'object',
  properties: { session: { type: 'string', description: 'The session id exactly as graph_sessions reported it.' } },
  required: ['session'],
}

export const GRAPH_FIND_DESCRIPTION = `Search the knowledge graph: a glob over proposition names, statements and aliases (e.g. *chain rule*; a bare term gets implicit surrounding *). Each match: id, name, statement, the session it was born in, and the premises it follows from.`

export const GRAPH_FIND_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string', description: 'Glob pattern, e.g. *derivative*.' } },
  required: ['query'],
}

export const GRAPH_EXTRACT_DESCRIPTION = `Extract what this session has taught so far into the learner's knowledge graph (propositions and the reasoning chains that derive them, linked to what the graph already holds). Runs in the background and is incremental: passages already extracted are skipped. Call it when a lesson wraps up. Do not wait for it; it reports to him when done.`

// The makers render through the plugin's own scripts: those run without a
// prompt, with plain arguments only (no shell syntax that could chain more).
export function isPluginScript(root: string, command: string): boolean {
  const script = `${root}/bin/`
  if (!command.startsWith(script)) return false
  const rest = command.slice(script.length)
  return /^(render-viz|test-demo)( +([A-Za-z0-9_./~@%+=,:-]+|'[^'\n]*'|"[^"$`\\\n]*"))*\s*$/.test(rest)
}
