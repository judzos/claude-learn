document.documentElement.classList.add('js');

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

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

// The hero field: an ASCII ground on an 8 by 16 cell, sparse on the text side,
// resolving toward the lesson on the right. Its glyphs are the lesson's own marks.
const canvas = document.querySelector('.field');
if (canvas && canvas.getContext) {
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const tints = ['--color-glyph-1', '--color-glyph-2', '--color-glyph-3', '--color-glyph-4', '--color-accent-deep'].map((v) => css.getPropertyValue(v).trim());
  const ramp = ['·', ':', '?', '○', '●', '✓'];
  const font = css.getPropertyValue('--font-outlier').trim();
  const W = 8, H = 16;
  let cols = 0, rows = 0, raf = 0, visible = true, last = 0, t = 0;
  let lens = null;

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(r.width / W);
    rows = Math.ceil(r.height / H);
    ctx.font = `11px ${font}`;
    ctx.textBaseline = 'top';
    canvas.style.backgroundImage = 'none';
  };

  // Cheap smooth noise from layered sines
  const noise = (x, y, z) =>
    (Math.sin(x * 0.11 + z) + Math.sin(y * 0.23 - z * 0.7) + Math.sin((x + y) * 0.07 + z * 0.5)) / 3;

  const draw = () => {
    ctx.clearRect(0, 0, cols * W, rows * H);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const across = x / cols;
        // Sparse under the headline, denser toward the lesson
        const bias = Math.max(0, across - 0.28) * 1.25;
        let v = (noise(x, y, t) + 1) / 2 * bias;
        if (lens) {
          const dx = (x * W - lens.x) / 120, dy = (y * H - lens.y) / 120;
          v += Math.max(0, 0.35 - (dx * dx + dy * dy) * 0.35);
        }
        if (v < 0.22) continue;
        const k = Math.min(ramp.length - 1, Math.floor((v - 0.22) * 9));
        ctx.fillStyle = tints[Math.min(tints.length - 1, Math.floor(k * 0.8))];
        ctx.fillText(ramp[k], x * W, y * H);
      }
    }
  };

  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    if (now - last < 33) return;
    last = now;
    t += 0.012;
    draw();
  };
  const start = () => { if (!raf && visible && !reduced.matches) raf = requestAnimationFrame(loop); };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };

  resize();
  draw();
  start();
  addEventListener('resize', () => { resize(); draw(); });
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); }).observe(canvas);
  reduced.addEventListener('change', () => { reduced.matches ? (stop(), draw()) : start(); });
  const hero = canvas.parentElement;
  hero.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    lens = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  hero.addEventListener('pointerleave', () => { lens = null; });
}
