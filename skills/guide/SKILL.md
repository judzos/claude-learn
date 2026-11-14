---
name: guide
description: Build a study guide website for a whole subject — one self-contained HTML file with an overview, a module per topic (the idea, formulas or key facts, method, worked examples, check-yourself quizzes, practice with hidden solutions), optional study plan, mock test and diagrams, and a progress map coloured by the learner's knowledge graph. Use when they want a study guide, review sheet, exam prep site or overview of everything in a course, test or subject.
argument-hint: <subject, course or test> [files…]
---

# Study guide

You build one study guide: a website, in one HTML file, that covers the whole subject the learner is studying and that they work through on their own. Each module explains one topic and then checks that it stuck. The guide opens from disk, saves progress in the browser, and shows a map of the subject's ideas coloured by what the learner's knowledge graph already holds.

The plugin has the page engine (layout, navigation, quizzes, timer, flashcards, progress map, dark mode). You write the **content** in a small markup vocabulary and build it with `build-guide`. You never hand-write the engine, its CSS or its scripts.

## 1. Setup

Load the tools in one call: `ToolSearch` with query `select:mcp__learn__guide_paths,mcp__learn__graph_find,mcp__learn__graph_sessions,mcp__learn__graph_propositions`.

## 2. Gather the whole corpus

The guide covers **everything they're studying**, so read all of it before planning anything:

- Every file, PDF, folder, outline, syllabus, past test, handout or note they point at. Read PDFs in full, in page ranges. For a textbook, read the chapters or sections the outline names, not the whole book.
- Their own words: the topic, the test, what it covers, what they find hard.
- Their knowledge graph: `graph_sessions` shows what they've covered with learn, and `graph_find` with the subject's key terms finds related propositions.
- If they gave only a topic, look in the working directory for course material (an outline, slides, a past test) before asking.

An outline or past test is the best guide to *scope*: it sets which topics the guide covers, their order, and the style of the questions. The guide must cover what the outline lists, no more and no less, unless the learner asks otherwise.

## 3. Ask how they want it

Ask once, with one `AskUserQuestion` call of up to four questions. Leave out any question the material or their request already answers. Each question stands on its own and puts the recommended option first.

- **Depth.** Always ask this unless they already said:
  - *Quick review*: a cheat-sheet pass. Each module has the essentials, 2 checks and 2 practice problems, and no worked-example walkthroughs.
  - *Standard*: the idea, a method, 1–2 worked examples, 3–4 checks and 3–4 practice problems per module.
  - *Full course guide*: everything in Standard plus more worked examples, common mistakes, 5+ checks and 5+ practice problems per module.
- **Diagrams.** Recommend yes for spatial, structural or process subjects (geometry, graphs of functions, anatomy, circuits, pipelines, cycles, timelines) and no where pictures would only decorate (vocabulary, proofs by algebra). Diagrams make the build slower, so say so.
- **Extras** (multiSelect):
  - *Day-by-day study plan* (they type the exam date under Other, or you ask in a follow-up)
  - *Timed mock test* (exam style, from their past papers if you have them)
  - *Flashcards* (for term-heavy subjects)
- **Missing material.** Ask only if you found nothing to build from and the topic is something a course would define its own way (for example "my Bio 101 midterm"). Offer: point me at files / build from the topic alone.

## 4. Paths, and refresh vs new

Call `guide_paths` with a short subject name. It returns the finished guide's path, a sources folder, the progress key, and the build and test commands.

If it reports **sources from an earlier build**, this is a refresh. Read the old `data.json` and `parts/` first. Keep every section id and the order of the questions inside each module, because saved progress is keyed by section id and question position. Change content where the material or the learner's request changed, recheck the knowledge-graph status of every map node, and add new modules at the end. Do not rewrite from scratch.

## 5. Plan the modules and the map

Split the subject into modules: one per topic a learner would study in one sitting, in teaching order (prerequisites first). The outline's sections are usually the right split. A mock test, if they asked for one, is the last module.

Then build the **progress map**: the subject's key ideas as nodes, with an edge from each idea to the ideas that build on it.

- Use 1–4 nodes per module. The labels are short claims or skills, 2–6 words, for example "Choosing u with LIATE". Avoid bare headings like "Part 2".
- Each node's `module` is the section id that teaches it.
- Draw an edge only for a real dependency, where you need A to do B. Keep the map sparse and acyclic.
- Mark a node `learned: true` only when `graph_find` turns up a proposition that states that idea, and put the proposition's statement in `note`. A loosely related proposition does not count. When the graph is empty, every node is new, and that's fine.

## 6. Write the sources

Write `data.json` and one file per section in `parts/`, named so they sort in order: `00-home.html`, `01-<id>.html`, `02-<id>.html` and so on. Write one module per Write call. For a large guide this keeps each write small and lets you fix a single module later.

### data.json

```json
{
  "title": "Cal 2 · Test 2",
  "subtitle": "201-MA2 · test Wed Nov 18",
  "key": "<the progress key guide_paths gave>",
  "math": true,
  "map": {
    "nodes": [
      {"id": "parts", "label": "Integration by parts", "module": "parts", "learned": true, "note": "∫u dv = uv − ∫v du"},
      {"id": "improper", "label": "Integrals out to infinity", "module": "improper", "learned": false}
    ],
    "edges": [["parts", "improper"]]
  }
}
```

Set `math` to false for subjects with no notation. It skips loading MathJax.

### The home section (first part)

```html
<section class="topic" id="home" data-title="Start here">
  <div class="kicker">Calculus II · Test 2</div>
  <h1>Test 2 study guide</h1>
  <p class="lead">One or two sentences: what this covers and how each module runs.</p>
  <div data-tiles></div>              <!-- the engine fills in a tile per module, with progress -->
  <h3>How the topics connect</h3>
  <p>A short paragraph on the order and why it matters.</p>
  <h3>Your progress map</h3>
  <div data-map></div>                <!-- the engine draws the map from data.json -->
  <!-- if asked: <h3>A five-day plan</h3> and a <table> of day / module / what to do -->
</section>
```

For a study plan, count the days from today to the exam and spread the modules over them, leaving the day before for review or the mock test. If the outline lists textbook exercises, put them in the plan.

### A module

```html
<section class="topic" id="parts" data-title="3 · Integration by parts" data-blurb="§7.1: the product rule, run backwards">
  <div class="kicker">Module 3 · Section 7.1</div>
  <h2>Integration by parts</h2>
  <p class="lead">The one-sentence point of the module.</p>
  …content…
</section>
```

Section ids use letters, digits, `-` and `_` only. `data-title` is the nav label, and `data-blurb` is the tile's subtitle. The engine adds the knowledge-graph badge, the footer (previous / mark done / next) and the nav, so don't write them.

Choose a module's anatomy to fit the subject. For a quantitative subject: the idea → formulas → the method → worked examples → common mistakes → check yourself → practice. For a conceptual or memory-heavy subject: the idea → key terms (flashcards) → how it works or a timeline → recall questions → check yourself → practice (short-answer or essay prompts with model answers). Use headings like `<h3>The idea</h3>` so every module reads the same way.

### The component vocabulary

| You write | You get |
| --- | --- |
| `<div class="formula">\[ … \]</div>` | a highlighted formula block |
| `<div class="trap"><b>Common mistakes.</b> …</div>` | a warning callout |
| `<div class="note">…</div>`, `<div class="card">…</div>` | an aside, a boxed panel |
| `<ol class="method"><li>…</li></ol>` | a numbered method |
| `<div class="steps"><div class="step"><div class="n">Step name</div>…</div>…</div>` | a worked example revealed one step at a time |
| `<div class="mcq" data-a="1"><p>Question</p><ul><li>A</li><li>B</li><li>C</li></ul><div class="why">Why B is right</div></div>` | multiple choice. `data-a` is the **0-based index** of the correct `<li>`. The engine shuffles the options, so write them in any order. |
| `<div class="num" data-a="128/3" data-tol="0.01" data-label="CS =" data-unit="dollars"><p>Question</p><div class="why">Worked answer</div></div>` | a numeric answer box. `data-a` takes a number or a fraction. `data-tol` is optional (default 0.1% of the answer). |
| `<div class="recall"><p>Prompt</p><div class="why">Model answer</div></div>` | free recall: they write an answer, compare it with yours and mark themselves |
| `<dl class="flash"><dt>Term</dt><dd>Definition</dd>…</dl>` | flip cards |
| `<div class="prob"><span class="tag">1</span>Problem</div><details><summary>Solution</summary>…</details>` | a practice problem with a hidden solution. For a mock test, tag it `Q1 · 6 marks`. |
| `<div class="timer" data-min="90"></div>` | a countdown timer for a mock test |
| `<figure><img src="name.png" alt="…"><figcaption>…</figcaption></figure>` | a diagram. Put the PNG in the sources folder and the build inlines it. |
| `<table>`, `<pre><code>`, `<code>` | wrapped and styled automatically |

Math goes in `\( … \)` inline and `\[ … \]` for display. Never use `$`, which the engine leaves as a literal dollar sign. Inside HTML, write `&lt;` for a literal `<` in text and math.

Every module that teaches something gets "check yourself" questions (`mcq`, `num`, `recall`), because those drive the progress on the tiles. Practice problems (`prob`) come after them and are harder: closer to the real exam.

## 7. Get every answer right

A wrong answer key teaches something false and marks the learner wrong for being right. So:

- Solve every check question and practice problem yourself before writing it. The `why` and the solution are your own worked answer.
- Check arithmetic and algebra with a quick script (Bash: `python3 -c …`) when the numbers aren't trivial. For a `num` question, compute `data-a` this way.
- Write multiple-choice distractors from real mistakes (the misconceptions a learner actually has), and count `data-a` from 0.
- If a fact, definition or convention feels even slightly unsure, check it with `Agent` and `subagent_type: "learn:researcher"` before it goes in. Where the course's material defines something its own way, follow the course.
- Match the course's notation and conventions, taken from its outline, slides or past tests.

## 8. Diagrams (only if they said yes)

Put a diagram only where it shows something the words can't: a shape, a structure, a process. Brief one maker per figure (the visualize skill's rules apply: one idea, the fewest elements). Use `learn:svg-maker` for geometry, plots and number lines, and `learn:mermaid-maker` for flows, trees and cycles. Dispatch them in parallel, in one message. Each returns a PNG path. Copy each PNG into the sources folder with Bash and reference it as `<img src="<file>.png">` inside a `<figure>`.

## 9. Build, test, look

1. Run the `build` command `guide_paths` gave. It prints `FAILED` with every broken answer key, bad id or missing image, or `BUILT` with a summary. Fix the errors and rebuild until it prints `BUILT`. Fix its warnings too, unless one is deliberate.
2. Run the `test` command. It loads the page in headless Chrome and must print `PASSED`. Then **Read the screenshot it wrote** and look at it: the nav, the tiles, and the map's labels inside their boxes. If something looks wrong, fix it and rebuild.
3. Copy the preview to the guide path (Bash `cp`), then open it in the browser: `xdg-open <guide>` on Linux, `open <guide>` on macOS.

## 10. Hand it over

Tell them in a few lines:

- Where the guide is (its path).
- What's in it: the number of modules, check questions, practice problems and extras.
- What the map says: how many of the ideas are already in their knowledge graph, and which modules are all new.
- That progress saves in the browser, and that running `/learn:guide <same subject>` again refreshes it (new material, updated graph status) and keeps their progress.
- That `/learn:practice` and `/learn:teach` work on any module they're stuck on.

Don't paste the guide's content into the chat.
