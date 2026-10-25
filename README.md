# learn

A learning harness for Claude Code: it measures where your understanding ends, plans a dependency map from there to your goal, and teaches one reasoning step at a time, checking each step before building on it. Practice sessions make what you learned come to mind without being named, and a knowledge graph in your Obsidian vault carries it across sessions.

It is a port of [LearnHarness](https://github.com/amosblomqvist/learnharness) by Amos Blomqvist to Claude Code, so it runs on a Claude subscription instead of API keys. The teaching, probing, practice and extraction prompts come from LearnHarness and are adapted to Claude Code's tools.

## What's in it

**Commands and skills**

- `/learn:teach <topic>` runs a lesson in three phases:
  1. **Probe.** Claude makes your goal concrete, then binary-searches each strand the lesson depends on until it finds a floor you get right and a ceiling where your understanding runs out. It records the result with `probe_done`.
  2. **Plan.** Claude writes the dependency map (`plan`) and presents it, then waits for your go-ahead.
  3. **Teach.** Each step runs predict, teach, check. Every quiz is tagged with its plan node, so the map tracks where you are.
- `/learn:practice [topic]` runs practice problems. Claude solves each problem before posing it, and the model solution stays hidden until the problem is concluded. Hints climb a six-rung ladder, one rung per request, and anything missed is retested in a fresh form before the session ends.
- `/map` shows the lesson's plan map: a pane where the terminal is wide enough, otherwise text. The status line also shows the current node.
- `/graph` extracts what this session taught into the knowledge graph, and `/graph-import <note.md>` imports your own notes. Both run in the background.
- `/md-log <note.md>` and `/md-unlog` mirror the session into a note as Obsidian callouts, and stop it. `/learn:teach` and `/learn:practice` start a lesson note on their own and open it in Obsidian.
- `/learn` prints a summary of the commands.

**Tools Claude uses**

- `quiz`: graded multiple choice. You see ✓/✗, the correct answer and the explanation as soon as you answer. "I don't know" is always offered, and options are shuffled. After a graded pick, a second short popup asks how sure you are, before the answer is revealed. You can type a percentage and your thinking there instead of picking a level.
- `explain`: free recall. You answer in your own words, and Claude grades you against an answer it committed to before asking.
- `probe_done`, `plan`, `problem`, `conclude`: the probe hand-off, the plan map and the practice problems.
- `graph_sessions`, `graph_propositions`, `graph_find`, `graph_extract`: reading the knowledge graph and adding to it.

**Agents**

- `learn:researcher`: background fact-checks.
- `learn:demo-maker`: interactive HTML demos. It tests each one in headless Chrome and looks at a screenshot before handing it over.
- `learn:svg-maker` and `learn:mermaid-maker`: figures and diagrams. Each renders its picture and looks at it before returning.

## The knowledge graph

The graph lives in `<learning folder>/graph/`. The learning folder defaults to `~/Desktop/learn` and can be changed in the plugin settings.

- `nodes.jsonl` and `chains.jsonl` follow LearnHarness's format. Propositions are true ideas about the world. Chains are premises that *jointly* entail a conclusion.
- Every proposition also gets a note in `graph/propositions/`, linked to the propositions it follows from and to the lesson note it was learned in, so Obsidian's graph view shows the structure.
- Extraction uses the model set in the plugin's `graphModel` setting (`sonnet` by default). New findings are linked to propositions you already have, so the same idea learned twice becomes one node.

## Install

At the prompt of a terminal session:

```
/plugin install learn --marketplace judzos/claude-learn
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin install learn --marketplace judzos/claude-learn
```

In the desktop app, where `/plugin` doesn't run: click + next to the prompt box, then Plugins, Add marketplace with `judzos/claude-learn`, then Add plugin.

Diagrams need `rsvg-convert` (or ImageMagick) for SVG, and Node for Mermaid (`npx @mermaid-js/mermaid-cli`). Demos need Node and Chrome or Chromium; puppeteer's downloaded Chrome works too.

## Using it

1. Run `/learn:teach <topic>`. The lesson note opens in Obsidian and fills in as you go.
2. Answer the probe honestly. "I don't know" is information, not a failure.
3. When the lesson wraps up, Claude adds it to your knowledge graph. Run `/graph` yourself at any point.
4. Later, run `/learn:practice <topic>`.

## Differences from LearnHarness

- Questions use Claude Code's own question popup. That popup holds at most 4 choices, so a quiz has 2 or 3 options plus "I don't know". Confidence is asked in a second popup rather than with a slider, and thinking is typed there or in chat.
- The probe and teaching phases run in one agent, so the same `quiz` tool serves both. Once a plan exists, it requires `type` and `nodeId`.
- Background jobs are Claude Code subagents. PDFs are read with Claude's own Read tool.
- Not ported: API keys and the cost meter, dictation (your OS dictation works in any text field), and the in-app updater.

## License

[AGPL-3.0](LICENSE). This plugin contains prompts and code adapted from [LearnHarness](https://github.com/amosblomqvist/learnharness), © Amos Blomqvist, licensed under the AGPL-3.0. The files that carry adapted material say so at the top.
