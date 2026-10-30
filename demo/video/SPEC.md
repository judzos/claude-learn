GOAL:    a visitor to the repo understands the loop in 25 s: probe → plan → checked steps → graph, and knows how to install it
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps; silent (it ships as a README GIF/MP4)
TIME:    25 s x 30 = 750 frames
LOOK:    ground #B4532F flat (Claude-ish terracotta, no gradient); ink #FFFFFF for captions;
         product UI medium: one terminal window #1A1A1A, 18 px radius, shadow 0 30px 60px rgba(0,0,0,.35);
         terminal accent #E8875F (prompt marker, selection), ✓ #6EE7A0, ✗ #FF8A80, dim #8A8A8A;
         captions Inter 900 64 px, -2% tracking, left column x 120..640; terminal JetBrains Mono 28 px
OBJECTS: the Claude Code terminal, its question popup (header chip, ❯ selection, numbered options, key hint line),
         the plan map (● current, ✓ visited, ○ upcoming, ← prerequisites), the knowledge graph (proposition nodes + links)
MOTION:  arrivals expo.out 0.5 s; selection moves steps; caption per-word blur 6→0 0.13 s, 0.08 s apart;
         scene seams are blur swaps on one stage (the window never moves)
SHOTS:   0–3.5   type `/learn:teach Bayes' theorem`; caption "Learn anything, one checked step at a time."
         3.5–9   probe quiz, pick "About 99%", ✗, correct "About 9%"; caption "First it finds where your understanding ends."
         9–14    plan map grows one node at a time; caption "Then it maps the steps to your goal."
         14–20   step quiz → confidence popup → ✓; caption "Every step is checked before the next."
         20–25   knowledge graph builds; caption "What you learn joins your knowledge graph." + install line
BANNED:  dark void ground, glow, gradients, glass cards, everything centred, fade-and-slide-up on everything,
         corner logos, HUD decoration
QA:      1.8 s (typed), 7.5 s (✗ verdict), 13 s (full map), 18.5 s (✓), 24 s (graph + install)
