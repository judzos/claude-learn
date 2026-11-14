// The page's charts: the probe quiz and its reading, the Bayes explorer,
// the probe bracket, the knowledge graph and the hint ladder.
// Every chart is drawn from the plugin's own rules or from plain arithmetic.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}, text) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const onResize = (node, fn) => new ResizeObserver(() => fn()).observe(node);

  // ---- The probe quiz and the confidence reading
  const quiz = $('.quiz');
  if (quiz) {
    const opts = $$('[data-answer]', quiz);
    const confBox = $('.quiz__conf', quiz);
    const confs = $$('[data-conf]', quiz);
    const verdict = $('.quiz__verdict', quiz);
    const again = $('.quiz__again', quiz);
    const dot = $('.quad__dot');
    const labels = { 99: 'About 99%', 50: 'About 50%', 9: 'About 9%' };
    let answer = null;

    const read = (right, conf) => {
      if (right) return conf >= 75
        ? 'Solid. The probe steps up to something harder.'
        : 'Right, but fragile: worth one reinforcing touch before moving on.';
      if (conf >= 75) return 'Wrong and sure is the strongest signal a probe can get: a committed misconception, and the lesson starts there.';
      if (conf <= 25) return 'Below chance means you distrusted your own pick. Claude reads that as honesty, not error.';
      return 'A shaky near-miss or an honest gap: a small correction usually does it.';
    };
    const finish = (html) => {
      verdict.innerHTML = html;
      again.hidden = false;
      confs.forEach((b) => { b.disabled = true; });
    };

    opts.forEach((btn) => btn.addEventListener('click', () => {
      answer = btn.dataset.answer;
      opts.forEach((b) => { b.setAttribute('aria-pressed', String(b === btn)); b.disabled = true; });
      if (answer === 'idk') {
        finish('<span class="tok">●</span> No confidence asked. “I don’t know” is a real gap, never a wrong answer. Correct: about 9%.');
        again.focus();
        return;
      }
      confBox.hidden = false;
      confs[0].focus();
    }));

    confs.forEach((btn) => btn.addEventListener('click', () => {
      const conf = Number(btn.dataset.conf);
      const right = answer === '9';
      btn.setAttribute('aria-pressed', 'true');
      finish(`<span class="${right ? 'ok">✓' : 'bad">✗'}</span> ${labels[answer]}, you were ${conf}% sure.${right ? '' : ' Correct: about 9%.'} ${read(right, conf)}`);
      dot.style.left = conf + '%';
      dot.dataset.row = right ? 'top' : 'bottom';
      dot.hidden = false;
      again.focus();
    }));

    again.addEventListener('click', () => {
      answer = null;
      [...opts, ...confs].forEach((b) => { b.disabled = false; b.removeAttribute('aria-pressed'); });
      confBox.hidden = true;
      again.hidden = true;
      dot.hidden = true;
      verdict.textContent = '';
      opts[0].focus();
    });

    $$('.quad__axis span').forEach((s) => { s.style.left = s.dataset.at + '%'; });
  }

  // ---- Bayes explorer
  const prevIn = $('#b-prev');
  if (prevIn) {
    const sensIn = $('#b-sens'), fpIn = $('#b-fp');
    const out = { post: $('#b-post'), prev: $('#b-prev-o'), sens: $('#b-sens-o'), fp: $('#b-fp-o'), tp: $('#b-tp'), fpn: $('#b-fpn') };
    const barTp = $('#b-bar-tp'), barFp = $('#b-bar-fp');
    const canvas = $('#b-pop'), curve = $('#b-curve');
    const ctx = canvas.getContext('2d');
    const COLS = 40, ROWS = 25, CW = 8, CH = 14;
    const fmtPct = (p) => Number((p * 100).toPrecision(2)) + '%';
    const fmtN = (n) => (n >= 10000 ? n.toLocaleString('en-US') : String(n));
    const about = (n) => (n < 0.5 ? 'Fewer than 1' : fmtN(Math.round(n)));
    const posterior = (prev, sens, fp) => (prev * sens) / (prev * sens + (1 - prev) * fp);

    // A fixed shuffle, so each person keeps their seat while the counts change
    const order = Array.from({ length: COLS * ROWS }, (_, i) => i);
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const seat = new Array(order.length);
    order.forEach((cell, rank) => { seat[cell] = rank; });

    const state = () => ({ prev: 10 ** Number(prevIn.value), sens: Number(sensIn.value) / 100, fp: Number(fpIn.value) / 100 });

    const drawPop = ({ prev, sens, fp }) => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = COLS * CW * dpr;
      canvas.height = ROWS * CH * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, COLS * CW, ROWS * CH);
      const total = COLS * ROWS;
      const sick = Math.round(prev * total);
      const caught = Math.round(prev * sens * total);
      const falsePos = Math.round((1 - prev) * fp * total);
      const c = { tp: token('--color-mark'), fp: token('--color-dot-4'), fn: token('--color-bad'), rest: token('--color-glyph-3') };
      for (let i = 0; i < total; i++) {
        const r = seat[i];
        let size = 1.1, col = c.rest;
        if (r < caught) { size = 3.2; col = c.tp; }
        else if (r < sick) { size = 3.2; col = c.fn; }
        else if (r >= total - falsePos) { size = 2.6; col = c.fp; }
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc((i % COLS) * CW + CW / 2, Math.floor(i / COLS) * CH + CH / 2, size, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const drawCurve = ({ prev, sens, fp }) => {
      const W = curve.clientWidth, H = 300;
      if (!W) return;
      const m = { l: 44, r: 20, t: 20, b: 36 };
      const x = (v) => m.l + ((v + 4) / 3.7) * (W - m.l - m.r);
      const y = (p) => m.t + (1 - p) * (H - m.t - m.b);
      const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
      [0, 0.25, 0.5, 0.75, 1].forEach((p) => {
        root.append(svg('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y(p), y2: y(p) }));
        root.append(svg('text', { x: m.l - 8, y: y(p) + 4, 'text-anchor': 'end' }, p * 100 + '%'));
      });
      [[-4, '1 in 10k'], [-3, '1 in 1000'], [-2, '1 in 100'], [-1, '1 in 10']].forEach(([v, label], i) => {
        root.append(svg('line', { class: 'grid', x1: x(v), x2: x(v), y1: H - m.b, y2: H - m.b + 6 }));
        if (i || W > 340) root.append(svg('text', { x: x(v), y: H - 10, 'text-anchor': i ? 'middle' : 'start' }, label));
      });
      let d = '';
      for (let i = 0; i <= 90; i++) {
        const v = -4 + (3.7 * i) / 90;
        d += `${i ? 'L' : 'M'}${x(v).toFixed(1)},${y(posterior(10 ** v, sens, fp)).toFixed(1)}`;
      }
      root.append(svg('path', { class: 'series', d }));
      const v = Math.log10(prev), p = posterior(prev, sens, fp);
      root.append(svg('line', { class: 'drop', x1: x(v), x2: x(v), y1: y(p), y2: H - m.b }));
      root.append(svg('circle', { class: 'marker', cx: x(v), cy: y(p), r: 6 }));
      const left = x(v) > W - 110;
      root.append(svg('text', { class: 'value', x: x(v) + (left ? -12 : 12), y: Math.max(m.t + 6, y(p) - 10), 'text-anchor': left ? 'end' : 'start' }, fmtPct(p)));
      curve.replaceChildren(root);
    };

    const update = () => {
      const s = state();
      const tp = s.prev * s.sens, fpos = (1 - s.prev) * s.fp;
      out.post.textContent = fmtPct(posterior(s.prev, s.sens, s.fp));
      out.prev.textContent = '1 in ' + fmtN(Number((1 / s.prev).toPrecision(2)));
      out.sens.textContent = Number(sensIn.value) + '%';
      out.fp.textContent = Number(fpIn.value) + '%';
      out.tp.textContent = about(tp * 1000);
      out.fpn.textContent = about(fpos * 1000);
      barTp.style.flexGrow = (100 * tp) / (tp + fpos);
      barFp.style.flexGrow = (100 * fpos) / (tp + fpos);
      drawPop(s);
      drawCurve(s);
    };

    [prevIn, sensIn, fpIn].forEach((el) => el.addEventListener('input', update));
    $('#b-reset').addEventListener('click', () => { prevIn.value = -3; sensIn.value = 99; fpIn.value = 1; update(); });
    onResize(curve, () => drawCurve(state()));
    addEventListener('modechange', update);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(update);
    update();
  }

  // ---- The probe bracket
  const edgeIn = $('#e-edge');
  if (edgeIn) {
    const plot = $('#e-plot'), count = $('#e-count'), edgeOut = $('#e-edge-o');
    const TOP = 32;

    // Open near the top of the strand, then split the bracket until it closes
    const search = (edge) => {
      let floor = 0, ceil = TOP, level = 26;
      const steps = [{ floor, ceil }];
      while (ceil - floor > 1) {
        const right = level <= edge;
        if (right) floor = level; else ceil = level;
        steps.push({ floor, ceil, level, right });
        level = Math.floor((floor + ceil) / 2);
      }
      return steps;
    };

    const draw = () => {
      const edge = Number(edgeIn.value);
      const steps = search(edge);
      const n = steps.length - 1;
      count.textContent = n;
      edgeOut.textContent = 'level ' + edge;
      const W = plot.clientWidth, H = 380;
      if (!W) return;
      const m = { l: 44, r: 16, t: 20, b: 36 };
      const x = (i) => m.l + (i / (n + 1)) * (W - m.l - m.r);
      const y = (lv) => m.t + (1 - lv / TOP) * (H - m.t - m.b);
      const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
      [0, 8, 16, 24, 32].forEach((lv) => {
        root.append(svg('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y(lv), y2: y(lv) }));
        root.append(svg('text', { x: m.l - 8, y: y(lv) + 4, 'text-anchor': 'end' }, lv));
      });
      steps.forEach((s, i) => {
        const g = svg('g', { class: 'step', style: `--i:${i}` });
        g.append(svg('rect', { class: 'band', x: x(i), y: y(s.ceil), width: x(i + 1) - x(i), height: y(s.floor) - y(s.ceil) }));
        g.append(svg('line', { class: 'bound', x1: x(i), x2: x(i + 1), y1: y(s.ceil), y2: y(s.ceil) }));
        g.append(svg('line', { class: 'bound', x1: x(i), x2: x(i + 1), y1: y(s.floor), y2: y(s.floor) }));
        if (i) {
          g.append(svg('text', { class: s.right ? 'mark mark--ok' : 'mark mark--bad', x: x(i), y: y(s.level) + 6, 'text-anchor': 'middle' }, s.right ? '✓' : '✗'));
          g.append(svg('text', { x: x(i), y: H - 10, 'text-anchor': 'middle' }, 'Q' + i));
        }
        root.append(g);
      });
      const ey = y(edge + 0.5);
      root.append(svg('line', { class: 'ref', x1: m.l, x2: W - m.r, y1: ey, y2: ey }));
      root.append(svg('text', { class: 'value', x: m.l + 8, y: ey - 8 }, 'your edge'));
      plot.replaceChildren(root);
    };

    edgeIn.addEventListener('input', () => { plot.classList.remove('is-playing'); draw(); });
    $('#e-replay').addEventListener('click', () => { plot.classList.add('is-playing'); draw(); });
    onResize(plot, draw);
    // Play once, the first time the chart scrolls into view
    new IntersectionObserver(([e], io) => {
      if (!e.isIntersecting) return;
      plot.classList.add('is-playing');
      draw();
      io.disconnect();
    }, { threshold: 0.4 }).observe(plot);
    draw();
  }

  // ---- The knowledge graph
  const kg = $('#kg');
  if (kg) {
    const W = 720, H = 500;
    const detail = $('#kg-detail');
    const buttons = $$('.kg__list button');
    const nodes = [
      { id: '1', from: [], note: 'A' }, { id: '2', from: [], note: 'A' },
      { id: '3', from: ['1', '2'], note: 'A' }, { id: '4', from: [], note: 'A' },
      { id: '5', from: ['3', '4'], note: 'A' }, { id: '6', from: ['2', '4'], note: 'B' },
      { id: 'A', label: 'Lesson note, Bayes’ theorem', kind: 'note' },
      { id: 'B', label: 'Practice note, the spam filter', kind: 'note' },
    ];
    const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const links = [];
    nodes.forEach((n) => {
      (n.from || []).forEach((f) => links.push({ a: by[f], b: n, kind: 'chain' }));
      if (n.note) links.push({ a: n, b: by[n.note], kind: 'note' });
    });
    const start = { 1: [120, 90], 2: [120, 290], 3: [320, 180], 4: [320, 390], 5: [540, 250], 6: [540, 420], A: [380, 60], B: [560, 330] };
    nodes.forEach((n) => { [n.x, n.y] = start[n.id]; n.vx = 0; n.vy = 0; });

    const defs = svg('defs'), arrow = svg('marker', { id: 'kg-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    arrow.append(svg('path', { class: 'kg-head', d: 'M0,1 L9,5 L0,9 z' }));
    defs.append(arrow);
    kg.append(defs);
    const linkEls = links.map((l) => {
      const el = svg('line', { class: 'kg-link kg-link--' + l.kind });
      if (l.kind === 'chain') el.setAttribute('marker-end', 'url(#kg-arrow)');
      kg.append(el);
      return el;
    });
    const nodeEls = nodes.map((n) => {
      const g = svg('g', { class: 'kg-node' + (n.kind ? ' kg-node--note' : '') });
      g.append(n.kind ? svg('rect', { x: -15, y: -15, width: 30, height: 30, rx: 4 }) : svg('circle', { r: 20 }));
      g.append(svg('text', { y: 5, 'text-anchor': 'middle' }, n.kind ? '' : n.id));
      if (n.kind) g.append(svg('text', { class: 'kg-note', y: 34, 'text-anchor': 'middle' }, n.label));
      kg.append(g);
      return g;
    });

    const render = () => {
      links.forEach((l, i) => {
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.hypot(dx, dy) || 1;
        const ra = l.a.kind ? 18 : 21, rb = l.b.kind ? 18 : 24;
        const el = linkEls[i];
        el.setAttribute('x1', l.a.x + (dx / d) * ra); el.setAttribute('y1', l.a.y + (dy / d) * ra);
        el.setAttribute('x2', l.b.x - (dx / d) * rb); el.setAttribute('y2', l.b.y - (dy / d) * rb);
      });
      nodes.forEach((n, i) => nodeEls[i].setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`));
    };

    let held = null, raf = 0, heat = 0;
    const tick = () => {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y, d2 = Math.max(dx * dx + dy * dy, 400), d = Math.sqrt(d2);
          const f = 2600 / d2;
          a.vx -= (dx / d) * f; a.vy -= (dy / d) * f; b.vx += (dx / d) * f; b.vy += (dy / d) * f;
        }
      }
      links.forEach((l) => {
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.hypot(dx, dy) || 1;
        const f = (d - 200) * (l.kind === 'note' ? 0.002 : 0.006);
        l.a.vx += (dx / d) * f; l.a.vy += (dy / d) * f; l.b.vx -= (dx / d) * f; l.b.vy -= (dy / d) * f;
      });
      nodes.forEach((n) => {
        n.vx += (start[n.id][0] - n.x) * 0.02; n.vy += (start[n.id][1] - n.y) * 0.02;
        n.vx *= 0.82; n.vy *= 0.82;
        if (n === held) { n.vx = 0; n.vy = 0; return; }
        n.x = Math.min(W - (n.kind ? 150 : 40), Math.max(n.kind ? 150 : 40, n.x + n.vx));
        n.y = Math.min(H - 60, Math.max(36, n.y + n.vy));
      });
    };
    const loop = () => {
      tick(); render();
      heat = held ? 90 : heat - 1;
      raf = heat > 0 ? requestAnimationFrame(loop) : 0;
    };
    const wake = () => { heat = 90; if (!raf) raf = requestAnimationFrame(loop); };

    // Settle before the first paint, so the graph never arrives mid-motion
    for (let i = 0; i < 300; i++) tick();
    render();

    const select = (id) => {
      const n = id ? by[id] : null;
      const lit = new Set(n ? [n.id, ...(n.from || []), n.note] : []);
      const into = nodes.filter((m) => (m.from || []).includes(id)).map((m) => m.id);
      kg.classList.toggle('has-pick', Boolean(n));
      nodes.forEach((m, i) => {
        nodeEls[i].classList.toggle('is-lit', lit.has(m.id));
        nodeEls[i].classList.toggle('is-pick', m.id === id);
      });
      links.forEach((l, i) => linkEls[i].classList.toggle('is-lit', Boolean(n) && l.a.id !== l.b.id && (l.kind === 'chain' ? l.b.id === id : l.a.id === id)));
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.node === id)));
      if (!n) { detail.textContent = 'Select a proposition to see what it follows from.'; return; }
      const parts = [];
      parts.push(n.from.length ? `Follows from ${n.from.join(' and ')}, jointly.` : 'Taught directly: nothing in the graph entails it.');
      if (into.length) parts.push(`A premise of ${into.join(' and ')}.`);
      parts.push(`Learned in: ${by[n.note].label.toLowerCase().replace('bayes', 'Bayes')}.`);
      detail.textContent = `${n.id}. ${parts.join(' ')}`;
    };
    let picked = null;
    const pick = (id) => { picked = picked === id ? null : id; select(picked); };
    buttons.forEach((b) => {
      b.addEventListener('click', () => pick(b.dataset.node));
      b.addEventListener('pointerenter', () => { if (!picked) select(b.dataset.node); });
      b.addEventListener('pointerleave', () => { if (!picked) select(null); });
    });

    const point = (e) => {
      const r = kg.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
    };
    nodes.forEach((n, i) => {
      const el = nodeEls[i];
      let moved = false;
      el.addEventListener('pointerdown', (e) => { held = n; moved = false; el.setPointerCapture(e.pointerId); e.preventDefault(); });
      el.addEventListener('pointermove', (e) => {
        if (held !== n) return;
        [n.x, n.y] = point(e);
        moved = true;
        if (reduced.matches) render(); else wake();
      });
      const drop = () => { if (held === n) held = null; };
      el.addEventListener('pointerup', () => { drop(); if (!moved && !n.kind) pick(n.id); });
      el.addEventListener('pointercancel', drop);
    });
  }

  // ---- The hint ladder
  const rungs = $$('[data-rung]');
  if (rungs.length) {
    const readout = $('#ladder-read');
    const text = [
      ['R0, attention redirect.', '“Re-read the second given.” It costs nothing: everything is still yours to find.'],
      ['R1, pattern re-description.', '“What you are looking at is a sum of many small things.” It names the kind of pattern, never the idea.'],
      ['R2, candidate class.', '“Something from this cluster applies.” The space narrows; choosing within it is still yours.'],
      ['R3, the proposition, named.', 'Recalling the idea is given up. Carrying it out is still yours.'],
      ['R4, the move outlined.', 'Carrying it out is given up too. You fill in the steps.'],
      ['R5, the worked step.', 'Everything is given up except the boundary lesson.'],
    ];
    const choose = (btn) => {
      rungs.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      const [name, body] = text[Number(btn.dataset.rung)];
      readout.replaceChildren(Object.assign(document.createElement('strong'), { textContent: name }), ' ' + body);
    };
    rungs.forEach((b) => {
      b.addEventListener('click', () => choose(b));
      b.addEventListener('pointerenter', () => choose(b));
      b.addEventListener('focus', () => choose(b));
    });
  }
})();
