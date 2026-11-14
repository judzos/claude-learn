document.documentElement.classList.add('js');

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

// Dark mode: follows the system until the toggle sets a mode, which is remembered
const root = document.documentElement;
const toggle = document.querySelector('.mode-toggle');
const isDark = () => (root.dataset.mode || (darkQuery.matches ? 'dark' : 'light')) === 'dark';
const syncToggle = () => {
  toggle.setAttribute('aria-pressed', String(isDark()));
  dispatchEvent(new Event('modechange'));
};
toggle.addEventListener('click', () => {
  root.dataset.mode = isDark() ? 'light' : 'dark';
  try { localStorage.setItem('mode', root.dataset.mode); } catch {}
  syncToggle();
});
darkQuery.addEventListener('change', syncToggle);
syncToggle();

// Copy keys
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const text = document.getElementById(btn.dataset.copy).textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(btn.dataset.copy));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      btn.textContent = 'Selected';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
  });
});

// Lesson phase tabs
const tabs = [...document.querySelectorAll('[role="tab"]')];
const select = (tab, focus) => {
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  });
  if (focus) tab.focus();
};
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => select(tab));
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (e.key === 'Home') select(tabs[0], true);
    else if (e.key === 'End') select(tabs[tabs.length - 1], true);
    else if (step) select(tabs[(i + step + tabs.length) % tabs.length], true);
    else return;
    e.preventDefault();
  });
});
if (tabs.length) select(tabs[0]);

// Videos: play while on screen unless reduced motion; the toggle always works
document.querySelectorAll('.player').forEach((fig) => {
  const video = fig.querySelector('video');
  const btn = fig.querySelector('.player__toggle');
  let userPaused = reduced.matches;
  const sync = () => {
    const playing = !video.paused;
    btn.textContent = playing ? 'Pause' : 'Play';
    btn.setAttribute('aria-pressed', String(playing));
  };
  video.addEventListener('play', sync);
  video.addEventListener('pause', sync);
  btn.addEventListener('click', () => {
    if (video.paused) { userPaused = false; video.play().catch(() => {}); }
    else { userPaused = true; video.pause(); }
  });
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !userPaused) video.play().catch(() => {});
    else if (!entry.isIntersecting) video.pause();
  }, { threshold: 0.35 }).observe(fig);
  sync();
});

// The hero cloud: a knowledge tree drawn as a few thousand dots. It grows from
// one root (what you know) through branches into clusters of ideas, each main
// branch in its own hue, and turns slowly. Still under reduced motion.
const canvas = document.querySelector('.field');
if (canvas && canvas.getContext) {
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const readTints = () => [0, 1, 2, 3, 4, 5].map((i) => css.getPropertyValue(`--color-dot-${i}`).trim());
  let tints = readTints();
  const pause = document.querySelector('.field__toggle');

  let seed = 11;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => (rand() + rand() + rand() + rand() - 2) / 2;

  // The tree: a trunk, five main branches, then two more forks
  const nodes = [{ p: [0, -1, 0], d: 0, hue: 0, len: 0 }];
  const edges = [];
  const add = (parent, p, hue) => {
    const a = nodes[parent];
    const n = { p, d: a.d + 1, hue, len: a.len + Math.hypot(p[0] - a.p[0], p[1] - a.p[1], p[2] - a.p[2]) };
    nodes.push(n);
    edges.push([a, n]);
    return nodes.length - 1;
  };
  const trunk = add(0, [0, -0.4, 0], 0);
  const fork = (parent, angle, hue, level) => {
    const q = nodes[parent].p;
    const reach = [0.5, 0.36, 0.26, 0.2][level], rise = [0.02, 0.24, 0.18, 0.14][level];
    const id = add(parent, [q[0] + Math.cos(angle) * reach, q[1] + rise + rand() * 0.16, q[2] + Math.sin(angle) * reach], hue);
    if (level === 3) return;
    const kids = level === 0 ? 3 : 2, spread = [0.7, 0.9, 1.1][level];
    for (let k = 0; k < kids; k++) fork(id, angle + (k - (kids - 1) / 2) * spread + gauss() * 0.25, hue, level + 1);
  };
  for (let i = 0; i < 5; i++) fork(trunk, (i / 5) * Math.PI * 2 + rand() * 0.4, i + 1, 0);
  const maxLen = Math.max(...nodes.map((n) => n.len));

  // Dots: thin filaments along each branch, a cluster at each node, a haze between
  const small = matchMedia('(max-width: 40rem)').matches;
  const density = small ? 0.4 : 0.75;
  const dots = [];
  const put = (x, y, z, hue, grow) => dots.push({ x, y, z, hue, grow, phase: Math.floor(rand() * 3), big: rand() < 0.035 });
  edges.forEach(([a, b]) => {
    const count = 70 * density;
    for (let i = 0; i < count; i++) {
      const t = rand(), j = 0.014 + a.d * 0.007;
      put(a.p[0] + (b.p[0] - a.p[0]) * t + gauss() * j, a.p[1] + (b.p[1] - a.p[1]) * t + gauss() * j, a.p[2] + (b.p[2] - a.p[2]) * t + gauss() * j,
        rand() < 0.3 ? 0 : b.hue, (a.len + (b.len - a.len) * t) / maxLen);
    }
  });
  nodes.forEach((n) => {
    if (!n.d) return;
    const count = [0, 160, 200, 170, 150, 170][n.d] * density, sd = [0, 0.04, 0.07, 0.075, 0.08, 0.1][n.d];
    for (let i = 0; i < count; i++) {
      const far = rand() < 0.2 ? 2.2 : 1;
      put(n.p[0] + gauss() * sd * far, n.p[1] + gauss() * sd * far, n.p[2] + gauss() * sd * far, rand() < 0.1 ? 0 : n.hue, n.len / maxLen + rand() * 0.05);
    }
  });
  const byHue = [0, 1, 2, 3, 4, 5].map((h) => dots.filter((d) => d.hue === h));

  let w = 0, h = 0, raf = 0, visible = true, paused = false, last = 0, born = 0, t = 0, grown = reduced.matches ? 1 : 0, lean = 0, leanTo = 0;
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas.style.backgroundImage = 'none';
  };

  // One path per hue, depth band and twinkle phase: 36 fills a frame, not
  // one per dot. If a frame still runs long, draw every second or third dot.
  let stride = 1, slow = 0;
  const draw = () => {
    const began = performance.now();
    ctx.clearRect(0, 0, w, h);
    const wide = w > 960;
    const R = wide ? Math.min(h * 0.43, w * 0.3) : Math.min(w * 0.44, h * 0.22);
    const cx = wide ? w * 0.7 : w * 0.5, cy = wide ? h * 0.54 : R * 1.1 + 24;
    const dark = isDark();
    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    const angle = t * 0.16 + lean, cos = Math.cos(angle), sin = Math.sin(angle);
    const scale = wide ? 1 : 0.7;
    for (let hue = 0; hue < 6; hue++) {
      const paths = [0, 1, 2, 3, 4, 5].map(() => new Path2D());
      const list = byHue[hue];
      for (let i = 0; i < list.length; i += stride) {
        const d = list[i];
        if (d.grow > grown) continue;
        const x = d.x * cos + d.z * sin, z = d.z * cos - d.x * sin;
        const s = 1 / (1 + z * 0.3);
        const size = (d.big ? 3 : 1.5) * scale * s * (z < 0 ? 1.15 : 0.9);
        paths[(z < 0 ? 0 : 3) + d.phase].rect(cx + x * R * s - size / 2, cy - d.y * R * s - size / 2, size, size);
      }
      ctx.fillStyle = tints[hue];
      paths.forEach((path, k) => {
        ctx.globalAlpha = (k < 3 ? 0.85 : 0.4) * (0.8 + 0.2 * Math.sin(t * 1.6 + k * 2.1)) * (dark ? 1 : 0.9);
        ctx.fill(path);
      });
    }
    ctx.globalAlpha = 1;
    slow = performance.now() - began > 24 ? slow + 1 : 0;
    if (slow > 4 && stride < 4) { stride++; slow = 0; }
  };

  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    if (now - last < 33) return;
    last = now;
    if (!born) born = now;
    t = (now - born) / 1000;
    const g = Math.min(1, t / 2.6);
    grown = Math.max(grown, 1.1 * (1 - (1 - g) ** 3));
    lean += (leanTo - lean) * 0.05;
    draw();
  };
  const start = () => { if (!raf && visible && !paused && !reduced.matches) raf = requestAnimationFrame(loop); };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  const still = () => { grown = 1.1; draw(); };

  resize();
  reduced.matches ? still() : start();
  addEventListener('resize', () => { resize(); draw(); });
  addEventListener('modechange', () => { tints = readTints(); draw(); });
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); }).observe(canvas);
  reduced.addEventListener('change', () => { reduced.matches ? (stop(), still()) : start(); });
  const hero = canvas.parentElement;
  hero.addEventListener('pointermove', (e) => { leanTo = (e.clientX / innerWidth - 0.5) * 0.9; });
  hero.addEventListener('pointerleave', () => { leanTo = 0; });
  if (pause) {
    if (reduced.matches) pause.hidden = true;
    pause.addEventListener('click', () => {
      paused = !paused;
      pause.setAttribute('aria-pressed', String(!paused));
      pause.textContent = paused ? 'Play motion' : 'Pause motion';
      paused ? (stop(), still()) : start();
    });
  }
}
