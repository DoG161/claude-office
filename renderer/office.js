// Pixel-art office: every Claude Code session is a character.
// working -> sits at its desk typing; waiting -> stands at desk with "!";
// done -> stands at desk, "готово"; idle -> hangs out in the lounge; sleeping -> naps on the sofa.
//
// Palette rule: the room is muted and dark, so only the things that matter carry colour —
// characters, live monitors, the light pool under an active desk, and the speech bubbles.
(() => {
  const T = 16;
  const LOUNGE_MIN = 9;   // lounge width in tiles
  const MIN_W = 4 * 2 + LOUNGE_MIN + 3, MIN_H = 13;
  const SPEED = 46; // world px per second

  const SKIN = ['#f5cfa6', '#e0ac7e', '#c68863', '#8d5a3b', '#f1d3b8', '#ffdcb5'];
  const HAIR = ['#2b1d16', '#5a3825', '#a0522d', '#e8c170', '#1a1a1a', '#c0392b', '#9a9aa8', '#3b2f5c', '#f4f0e8'];
  const SHIRT = ['#e0784f', '#4f8cff', '#4fd18b', '#b07cff', '#ffc857', '#ff7fa8', '#3fc1c9', '#ef6f6c', '#8bd450', '#7a86ff', '#f2f2f2'];
  const PANTS = ['#2f3b59', '#3a3a46', '#4b3a2f', '#24324a', '#5a4a6a'];
  const STATE_COLOR = { working: '#5fd38d', waiting: '#ff5d5d', done: '#ffc857', idle: '#7aa7ff', sleeping: '#8a80a8' };
  const STATE_RGB = { working: '95,211,141', waiting: '255,93,93', done: '255,200,87' };

  // muted environment
  const ENV = {
    bg: '#121019',
    wall: '#2b2738', wallTop: '#262233', wainscot: '#302b40', wainLine: '#272335', trim: '#3a3450', base: '#1c1926',
    outer: '#1c1926', outerEdge: '#2b2738',
    wood: ['#3b302b', '#3f332d', '#382d29'], seam: '#2b221f', grain: '#463a33',
    carpet: '#232c35', carpet2: '#27313b', carpetDot: '#2d3843',
    rug: '#2a2433', rugEdge: '#342d40',
    deskTop: '#55463b', deskHi: '#5e4e42', deskEdge: '#3f342c', deskLeg: '#2e2620', drawer: '#4a3d33',
    bezel: '#1a1a22', bezelHi: '#2a2a35', screenOff: '#0d0f15',
    chair: '#2a3045', chairSeat: '#252a3d', chairHi: '#353c56', wheel: '#15161d',
    outline: '#0e0c14',
  };

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const hash3 = (a, b, c) => ((Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) >>> 0);
  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const center = (tx, ty) => ({ x: tx * T + 8, y: ty * T + 12 });

  // ---------------- map ----------------

  // room size in tiles follows the window's proportions, so the canvas is always filled
  function layoutFor(cw, ch, need, dpr) {
    let best = null;
    for (let s = 3.2 * dpr; s >= 0.5; s -= 0.05 * dpr) {
      const W = Math.floor(cw / (T * s)), H = Math.floor(ch / (T * s));
      if (W < MIN_W || H < MIN_H) continue;
      best = { W, H, s };
      const cols = Math.floor((W - LOUNGE_MIN - 3) / 4), rows = Math.floor((H - 5) / 4);
      if (cols * rows >= need) break;
    }
    if (!best) return { W: MIN_W, H: MIN_H };
    // round up so the room covers the whole canvas; the < 1 tile overflow is cropped at the edges,
    // where only the outer filler strip lives (the visible walls are a screen-space frame)
    return { W: Math.ceil(cw / (T * best.s)), H: Math.ceil(ch / (T * best.s)) };
  }

  function buildMap(W, H) {
    const cols = Math.floor((W - LOUNGE_MIN - 3) / 4);
    const rows = Math.floor((H - 5) / 4);
    const top = 3 + Math.floor((H - 5 - rows * 4) / 2); // centre the desk block vertically
    const Lx = cols * 4 + 2; // lounge left column
    const grid = [];
    for (let y = 0; y < H; y++) {
      grid.push([]);
      for (let x = 0; x < W; x++) grid[y].push(y < 2 || x === 0 || x === W - 1 || y === H - 1 ? 1 : 0);
    }
    const block = (x, y) => { grid[y][x] = 2; };
    const door = { tx: 2, ty: H - 1 };
    grid[door.ty][door.tx] = 0;

    const desks = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const bx = 1 + c * 4, by = top + r * 4;
        block(bx + 1, by + 1); block(bx + 2, by + 1);
        desks.push({
          i: desks.length, bx, by,
          seat: { x: (bx + 2) * T, y: (by + 2) * T + 9 },
          approach: { tx: bx + 1, ty: by + 2 },
          stand: { tx: bx + 3, ty: by + 2 },
          owner: null,
        });
      }
    }

    const items = [];
    const spots = [];
    // sofa against the back wall
    for (let k = 0; k < 4; k++) {
      block(Lx + 1 + k, 2);
      spots.push({ kind: 'sofa', tile: { tx: Lx + 1 + k, ty: 3 }, final: { x: (Lx + 1 + k) * T + 8, y: 2 * T + 12 }, pose: 'sitFront', dir: 'down', owner: null });
    }
    items.push({ type: 'sofa', x: (Lx + 1) * T, y: 2 * T, key: 2 * T + 5 });
    items.push({ type: 'lamp', x: Lx * T, y: 2 * T, key: 3 * T });
    block(Lx + 2, 4); block(Lx + 3, 4);
    items.push({ type: 'ctable', x: (Lx + 2) * T, y: 4 * T, key: 5 * T });
    // coffee machine
    block(W - 2, 5); block(W - 2, 6);
    items.push({ type: 'coffee', x: (W - 2) * T, y: 5 * T, key: 7 * T });
    spots.push({ kind: 'coffee', tile: { tx: W - 3, ty: 5 }, final: null, pose: 'stand', dir: 'right', owner: null });
    // water cooler
    block(Lx, H - 2);
    items.push({ type: 'cooler', x: Lx * T, y: (H - 2) * T, key: (H - 1) * T });
    spots.push({ kind: 'cooler', tile: { tx: Lx + 1, ty: H - 2 }, final: null, pose: 'stand', dir: 'left', owner: null });
    // ping-pong
    for (let x = Lx + 2; x <= Lx + 5; x++) { block(x, 8); block(x, 9); }
    items.push({ type: 'pingpong', x: (Lx + 2) * T, y: 8 * T, key: 10 * T });
    spots.push({ kind: 'pp1', tile: { tx: Lx + 1, ty: 8 }, final: { x: (Lx + 1) * T + 10, y: 9 * T + 2 }, pose: 'stand', dir: 'right', owner: null });
    spots.push({ kind: 'pp2', tile: { tx: Lx + 6, ty: 9 }, final: { x: (Lx + 6) * T + 6, y: 9 * T + 2 }, pose: 'stand', dir: 'left', owner: null });
    // plants
    for (const [px, py, v] of [[W - 2, 2, 0], [W - 2, H - 2, 1], [1, 2, 2], [Lx - 1, H - 2, 0]]) {
      block(px, py);
      items.push({ type: 'plant', v, x: px * T, y: py * T, key: (py + 1) * T });
    }
    // coat rack by the door
    block(1, H - 2);
    items.push({ type: 'coatrack', x: T, y: (H - 2) * T, key: (H - 1) * T });

    const wander = [];
    for (let y = 3; y < H - 1; y++) for (let x = Lx; x < W - 1; x++) if (grid[y][x] === 0) wander.push({ tx: x, ty: y });

    return { W, H, Lx, cols, rows, top, grid, door, desks, items, spots, wander, staticLayer: null };
  }

  function findPath(map, from, to) {
    const { W, H, grid } = map;
    const ok = (x, y) => x >= 0 && y >= 0 && x < W && y < H && grid[y][x] === 0;
    if (from.tx === to.tx && from.ty === to.ty) return [];
    const prev = new Map();
    const key = (x, y) => y * W + x;
    const q = [[from.tx, from.ty]];
    prev.set(key(from.tx, from.ty), null);
    while (q.length) {
      const [x, y] = q.shift();
      if (x === to.tx && y === to.ty) break;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (!ok(nx, ny) || prev.has(key(nx, ny))) continue;
        prev.set(key(nx, ny), key(x, y));
        q.push([nx, ny]);
      }
    }
    if (!prev.has(key(to.tx, to.ty))) return null;
    const out = [];
    let k = key(to.tx, to.ty);
    while (k !== key(from.tx, from.ty)) { out.push({ tx: k % W, ty: Math.floor(k / W) }); k = prev.get(k); }
    return out.reverse();
  }

  // ---------------- characters ----------------

  class Char {
    constructor(s, pos) {
      const h = hash(s.id);
      this.id = s.id;
      this.seed = (h % 1000) / 1000 * 10;
      this.pal = {
        skin: SKIN[h % SKIN.length],
        hair: HAIR[(h >>> 4) % HAIR.length],
        shirt: SHIRT[(h >>> 9) % SHIRT.length],
        pants: PANTS[(h >>> 14) % PANTS.length],
      };
      this.longHair = ((h >>> 18) & 3) === 0;
      this.s = s;
      this.x = pos.x; this.y = pos.y;
      this.anchor = pos.tile;
      this.path = [];
      this.goal = null;
      this.pose = 'stand';
      this.dir = 'down';
      this.desk = null;
      this.spot = null;
      this.idleUntil = 0;
      this.arrivedAt = 0;
      this.leaving = false;
    }
    get name() { return this.s.name || this.s.project; }
  }

  // ---------------- office ----------------

  const Office = {
    canvas: null, ctx: null, map: null, chars: new Map(),
    selected: null, hover: null, onSelect: null, onActivate: null, first: true,
    view: { s: 1, ox: 0, oy: 0, dpr: 1 },

    init(canvas, onSelect, onActivate) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.onSelect = onSelect;
      this.onActivate = onActivate;
      this.map = buildMap(MIN_W, MIN_H);
      this.need = 0;
      canvas.addEventListener('mousemove', (e) => {
        this.hover = this.hit(e);
        canvas.style.cursor = this.hover ? 'pointer' : 'default';
      });
      canvas.addEventListener('mouseleave', () => { this.hover = null; });
      canvas.addEventListener('click', (e) => { if (this.onSelect) this.onSelect(this.hit(e)); });
      canvas.addEventListener('dblclick', (e) => {
        const id = this.hit(e);
        if (id && this.onActivate) this.onActivate(id);
      });
      let last = performance.now();
      const loop = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        this.step(dt, now / 1000);
        this.draw(now / 1000);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    },

    select(id) { this.selected = id; },

    hit(e) {
      const r = this.canvas.getBoundingClientRect();
      const { s, ox, oy, dpr } = this.view;
      const wx = ((e.clientX - r.left) * dpr - ox) / s;
      const wy = ((e.clientY - r.top) * dpr - oy) / s;
      let best = null, bestY = -1;
      for (const c of this.chars.values()) {
        if (wx >= c.x - 7 && wx <= c.x + 7 && wy >= c.y - 21 && wy <= c.y + 2 && c.y > bestY) { best = c.id; bestY = c.y; }
      }
      return best;
    },

    update(list) {
      const ids = new Set(list.map((s) => s.id));
      let needed = list.length;
      for (const c of this.chars.values()) if (!ids.has(c.id)) needed++;
      this.need = needed;
      if (needed > this.map.desks.length) this.relayout(true);

      for (const s of list) {
        let c = this.chars.get(s.id);
        if (!c) {
          const start = this.first
            ? { x: 0, y: 0, tile: { tx: 2, ty: 2 } }
            : { ...center(this.map.door.tx, this.map.door.ty), tile: { ...this.map.door } };
          c = new Char(s, start);
          c.desk = this.map.desks.find((d) => !d.owner);
          c.desk.owner = c.id;
          this.chars.set(s.id, c);
          this.think(c, 0);
          if (this.first) this.snap(c);
        }
        c.s = s;
        c.leaving = false;
      }
      for (const c of this.chars.values()) {
        if (!ids.has(c.id) && !c.leaving) {
          c.leaving = true;
          this.releaseSpot(c);
          this.setGoal(c, { key: 'exit', tile: { ...this.map.door }, final: null, pose: 'stand', dir: 'down' });
        }
      }
      this.first = false;
    },

    // pick the room size for the current canvas; rebuild when it changes
    relayout(force) {
      const cv = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(cv.clientWidth * dpr), ch = Math.round(cv.clientHeight * dpr);
      if (!cw || !ch) return;
      const key = `${cw}x${ch}x${this.need}`;
      if (!force && key === this.layoutKey) return;
      this.layoutKey = key;
      const { W, H } = layoutFor(cw, ch, Math.max(1, this.need), dpr);
      if (W !== this.map.W || H !== this.map.H) this.rebuild(W, H);
    },

    rebuild(W, H) {
      const owners = this.map.desks.map((d) => d.owner).filter(Boolean);
      this.map = buildMap(W, H);
      owners.forEach((o, i) => { if (this.map.desks[i]) this.map.desks[i].owner = o; });
      for (const c of this.chars.values()) {
        c.desk = this.map.desks.find((d) => d.owner === c.id) || null;
        c.spot = null; c.goal = null; c.idleUntil = 0;
        this.think(c, 0);
        this.snap(c);
      }
    },

    snap(c) {
      const g = c.goal;
      if (!g) return;
      const p = g.final || center(g.tile.tx, g.tile.ty);
      c.x = p.x; c.y = p.y;
      c.anchor = { ...g.tile };
      c.path = [];
      c.pose = g.pose; c.dir = g.dir;
    },

    releaseSpot(c) { if (c.spot) { c.spot.owner = null; c.spot = null; } },

    setGoal(c, goal) {
      if (c.goal && c.goal.key === goal.key) return;
      c.goal = goal;
      const pts = [];
      pts.push({ ...center(c.anchor.tx, c.anchor.ty), tile: c.anchor });
      const route = findPath(this.map, c.anchor, goal.tile) || [];
      for (const t of route) pts.push({ ...center(t.tx, t.ty), tile: t });
      if (goal.final) pts.push({ ...goal.final });
      // drop the first point if we are already standing on it
      if (Math.hypot(pts[0].x - c.x, pts[0].y - c.y) < 0.5) pts.shift();
      c.path = pts;
    },

    think(c, now) {
      if (c.leaving) return;
      const st = c.s.state;
      const d = c.desk;
      if (st === 'sleeping') {
        // nap on the sofa if there is room, otherwise head down on the desk
        if (c.goal && c.goal.key.startsWith('sleep')) return;
        this.releaseSpot(c);
        const sofa = this.map.spots.find((s) => s.kind === 'sofa' && !s.owner);
        if (sofa) {
          sofa.owner = c.id;
          c.spot = sofa;
          this.setGoal(c, { key: 'sleep-sofa', tile: sofa.tile, final: sofa.final, pose: 'sofaSleep', dir: 'down' });
        } else {
          this.setGoal(c, { key: 'sleep-desk', tile: d.approach, final: d.seat, pose: 'sleep', dir: 'up' });
        }
      } else if (st === 'working') {
        this.releaseSpot(c);
        this.setGoal(c, { key: 'desk-working', tile: d.approach, final: d.seat, pose: 'type', dir: 'up' });
      } else if (st === 'waiting' || st === 'done') {
        this.releaseSpot(c);
        this.setGoal(c, { key: 'desk-stand', tile: d.stand, final: null, pose: 'stand', dir: 'down' });
      } else {
        // idle: wander around the lounge, pick a new activity every so often
        if (c.goal && c.goal.key.startsWith('lounge') && now < c.idleUntil) return;
        this.releaseSpot(c);
        const free = this.map.spots.filter((s) => !s.owner);
        let goal;
        if (free.length && Math.random() < 0.7) {
          const sp = pick(free);
          sp.owner = c.id;
          c.spot = sp;
          goal = { key: `lounge-${sp.kind}`, tile: sp.tile, final: sp.final, pose: sp.pose, dir: sp.dir };
        } else {
          const t = pick(this.map.wander);
          goal = { key: `lounge-w${t.tx}-${t.ty}`, tile: t, final: null, pose: 'stand', dir: pick(['down', 'left', 'right']) };
        }
        c.idleUntil = now + rand(9, 22);
        this.setGoal(c, goal);
      }
    },

    step(dt, now) {
      for (const c of [...this.chars.values()]) {
        this.think(c, now);
        if (!c.path.length) continue;
        const p = c.path[0];
        const dx = p.x - c.x, dy = p.y - c.y;
        const dist = Math.hypot(dx, dy);
        const mv = SPEED * dt;
        if (Math.abs(dx) > Math.abs(dy)) c.dir = dx > 0 ? 'right' : 'left';
        else if (dist > 0.01) c.dir = dy > 0 ? 'down' : 'up';
        c.pose = 'walk';
        if (dist <= mv) {
          c.x = p.x; c.y = p.y;
          c.path.shift();
          if (p.tile) c.anchor = p.tile;
          if (!c.path.length) {
            c.pose = c.goal.pose; c.dir = c.goal.dir; c.arrivedAt = now;
            if (c.leaving && c.goal.key === 'exit') {
              if (c.desk) c.desk.owner = null;
              this.chars.delete(c.id);
            }
          }
        } else {
          c.x += (dx / dist) * mv; c.y += (dy / dist) * mv;
        }
      }
    },

    // ---------------- rendering ----------------

    draw(t) {
      const cv = this.canvas, ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(cv.clientWidth * dpr), ch = Math.round(cv.clientHeight * dpr);
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      this.relayout(false);
      const { W, H } = this.map;
      // the room covers the canvas: overflow is cropped evenly at the sides and at the bottom,
      // never at the top where the back wall and the limits board are
      const s = Math.max(cw / (W * T), ch / (H * T));
      const ox = Math.round((cw - W * T * s) / 2), oy = 0;
      this.view = { s, ox, oy, dpr };

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = ENV.outer;
      ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(s, 0, 0, s, ox, oy);

      const now = new Date();
      const hour = now.getHours() + now.getMinutes() / 60;
      const night = hour < 7 || hour >= 20;

      if (!this.map.staticLayer) this.map.staticLayer = this.renderStatic();
      ctx.drawImage(this.map.staticLayer, 0, 0);
      this.drawWallDynamic(ctx, t, hour);
      if (!night) this.drawSunlight(ctx, hour);
      this.drawLightPools(ctx, t);

      const drawables = [];
      for (const d of this.map.desks) {
        drawables.push({ key: (d.by + 1) * T + 14, fn: () => this.drawDesk(ctx, d, t) });
        drawables.push({ key: d.seat.y + 1, fn: () => this.drawChair(ctx, d) });
      }
      for (const it of this.map.items) drawables.push({ key: it.key, fn: () => this.drawItem(ctx, it, t) });
      for (const c of this.chars.values()) drawables.push({ key: c.y, fn: () => this.drawChar(ctx, c, t) });
      drawables.sort((a, b) => a.key - b.key);
      for (const d of drawables) d.fn();

      if (night) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = 'rgba(6,5,22,0.35)';
        ctx.fillRect(0, 0, cw, ch);
        ctx.setTransform(s, 0, 0, s, ox, oy);
        ctx.globalCompositeOperation = 'lighter';
        for (const d of this.map.desks) {
          const c = d.owner && this.chars.get(d.owner);
          if (!c || c.s.state === 'sleeping' || c.s.state === 'idle') continue;
          this.glow(ctx, (d.bx + 2) * T, (d.by + 1) * T - 4, 30, '90,140,255', 0.25);
        }
        this.glow(ctx, this.map.Lx * T + 8, 2 * T - 6, 40, '255,190,110', 0.22);
        ctx.globalCompositeOperation = 'source-over';
      }

      // screen-space from here on
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // vignette over the whole canvas keeps the eye in the middle of the room
      const vg = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.35, cw / 2, ch / 2, Math.max(cw, ch) * 0.7);
      vg.addColorStop(0, 'rgba(8,6,14,0)');
      vg.addColorStop(1, 'rgba(8,6,14,0.45)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, cw, ch);
      this.drawFrame(ctx, cw, ch);

      this.drawLimitsText(ctx, t);
      const chars = [...this.chars.values()].sort((a, b) => a.y - b.y);
      for (const c of chars) this.drawOverlay(ctx, c, t);
    },

    // thin outer walls hugging the canvas edges, with the entrance cut into the bottom one
    drawFrame(ctx, cw, ch) {
      const { s, ox, oy, dpr } = this.view;
      const b = Math.round(7 * dpr), e = Math.max(1, Math.round(2 * dpr));
      const wallTop = Math.round(oy + 2 * T * s);
      ctx.fillStyle = ENV.outer;
      ctx.fillRect(0, 0, b, ch); ctx.fillRect(cw - b, 0, b, ch); ctx.fillRect(0, ch - b, cw, b);
      ctx.fillStyle = ENV.outerEdge;
      ctx.fillRect(b, wallTop, e, ch - b - wallTop); ctx.fillRect(cw - b - e, wallTop, e, ch - b - wallTop);
      ctx.fillRect(b, ch - b - e, cw - 2 * b, e);
      const dx = Math.round(ox + this.map.door.tx * T * s), dw = Math.round(T * s);
      ctx.fillStyle = '#0c0b11'; ctx.fillRect(dx, ch - b - e, dw, b + e);
      ctx.fillStyle = '#4a3a30';
      ctx.fillRect(dx - e, ch - b - e, e, b + e); ctx.fillRect(dx + dw, ch - b - e, e, b + e);
    },

    glow(ctx, x, y, r, rgb, a) {
      const g = ctx.createRadialGradient(x, y, 1, x, y, r);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    },

    // light pool under each desk whose agent needs attention or is busy
    drawLightPools(ctx, t) {
      for (const d of this.map.desks) {
        const c = d.owner && this.chars.get(d.owner);
        if (!c) continue;
        const st = c.s.state;
        const rgb = STATE_RGB[st];
        const cx = (d.bx + 2) * T, cy = (d.by + 2) * T;
        if (rgb) {
          let a = st === 'working' ? 0.3 : 0.32;
          if (st === 'waiting') a = 0.2 + 0.2 * (0.5 + 0.5 * Math.sin(t * 4));
          ctx.save();
          ctx.translate(cx, cy);
          ctx.scale(1.6, 1);
          this.glow(ctx, 0, 0, 26, rgb, a);
          ctx.restore();
        }
        if (this.selected === c.id) {
          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.scale(1.6, 1);
          this.glow(ctx, 0, 0, 14, '255,255,255', 0.16);
          ctx.restore();
        }
      }
      // the selected character gets a soft halo wherever it is
      const sc = this.selected && this.chars.get(this.selected);
      if (sc && !(sc.desk && this.chars.get(sc.desk.owner) === sc && STATE_RGB[sc.s.state])) {
        ctx.save();
        ctx.translate(sc.x, sc.y);
        ctx.scale(1.6, 1);
        this.glow(ctx, 0, 0, 14, '255,255,255', 0.16);
        ctx.restore();
      }
    },

    drawSunlight(ctx, hour) {
      // pale shafts falling from the windows onto the floor
      const k = Math.sin(Math.max(0, Math.min(1, (hour - 7) / 13)) * Math.PI);
      if (k <= 0.05) return;
      const skew = (hour - 13.5) * 3;
      ctx.fillStyle = `rgba(255,236,200,${0.045 * k})`;
      for (let c = 0; c < this.map.cols; c++) {
        const x = (1 + c * 4) * T + 22;
        ctx.beginPath();
        ctx.moveTo(x, 2 * T); ctx.lineTo(x + 20, 2 * T);
        ctx.lineTo(x + 26 - skew, 2 * T + 40); ctx.lineTo(x + 2 - skew, 2 * T + 40);
        ctx.fill();
      }
    },

    // floor, walls and wall decor that never change -> cached in an offscreen canvas
    renderStatic() {
      const { W, H, Lx, door } = this.map;
      const cv = document.createElement('canvas');
      cv.width = W * T; cv.height = H * T;
      const ctx = cv.getContext('2d');
      const px = (col, x, y, w = 1, h = 1) => { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); };

      // wooden planks in the office area
      for (let y = 2 * T; y < H * T; y += 4) {
        const row = y / 4;
        for (let x = -((row * 11) % 24); x < Lx * T; x += 24) {
          const sx = Math.max(0, x);
          const w = Math.min(Lx * T, x + 24) - sx;
          if (w <= 0) continue;
          px(ENV.wood[hash3(x, row, 1) % 3], sx, y, w, 4);
          px(ENV.seam, sx, y + 3, w, 1);
          px(ENV.seam, sx, y, 1, 3);
          const g = hash3(x, row, 2);
          if (w > 8) px(ENV.grain, sx + 2 + (g % (w - 7)), y + 1, 3 + (g % 3), 1);
        }
      }
      // a rug under each row of desks
      const cols = this.map.cols;
      for (let r = 0; r < this.map.rows; r++) {
        const y = (this.map.top + r * 4) * T + 6;
        px(ENV.rugEdge, T + 6, y, (cols * 4) * T - 12, 3 * T - 4);
        px(ENV.rug, T + 8, y + 2, (cols * 4) * T - 16, 3 * T - 8);
        for (let x = T + 12; x < (cols * 4 + 1) * T - 12; x += 6) px(ENV.rugEdge, x, y + 4, 2, 1);
      }
      // lounge carpet
      for (let y = 2; y < H; y++) {
        for (let x = Lx; x < W; x++) {
          px((x + y) % 2 ? ENV.carpet : ENV.carpet2, x * T, y * T, T, T);
          px(ENV.carpetDot, x * T + 4, y * T + 4); px(ENV.carpetDot, x * T + 11, y * T + 11);
        }
      }
      // round rug in front of the sofa
      px('#2b2a3c', (Lx + 1) * T + 2, 3 * T + 4, 60, 26);
      px('#323146', (Lx + 1) * T + 4, 3 * T + 6, 56, 22);
      px('#2b2a3c', (Lx + 1) * T + 8, 3 * T + 10, 48, 14);
      // threshold between office and lounge
      px('#1a2028', Lx * T - 1, 2 * T, 1, (H - 3) * T);

      // back wall
      px(ENV.wallTop, 0, 0, W * T, 16);
      px(ENV.wall, 0, 6, W * T, 12);
      px(ENV.wainscot, 0, 17, W * T, 9);
      for (let x = 4; x < W * T; x += 12) px(ENV.wainLine, x, 18, 1, 8);
      px(ENV.trim, 0, 16, W * T, 1);
      px(ENV.trim, 0, 26, W * T, 1);
      px(ENV.base, 0, 27, W * T, 5);
      px('#16141f', 0, 31, W * T, 1);

      // bookshelf in the lounge
      const bx = (Lx + 6) * T;
      px('#3a2c24', bx, 2, 30, 26);
      px('#271d18', bx + 2, 4, 26, 10); px('#271d18', bx + 2, 16, 26, 10);
      const books = ['#6b4c45', '#45546b', '#4b6152', '#6b6045', '#594b6b', '#6b4a4a', '#455f63'];
      for (let i = 0; i < 8; i++) {
        px(books[i % books.length], bx + 3 + i * 3, 6 + (i % 3), 2, 8 - (i % 3));
        px(books[(i + 3) % books.length], bx + 3 + i * 3, 18 + ((i + 1) % 2), 2, 8 - ((i + 1) % 2));
      }
      // framed portrait of the orange Claude Code critter above the sofa
      const fw = 40, fh = 24;
      const fx = (Lx + 1) * T + 32 - fw / 2, fy = 2;
      px('#3e3852', fx - 2, fy - 1, fw + 4, fh + 2);
      px('#1c1926', fx - 1, fy, fw + 2, fh);
      px('#191623', fx, fy, fw, fh - 1);
      px('#211d2d', fx, fy + fh - 5, fw, 4); // floor line in the picture
      // same shape as the terminal mascot: each cell is a block quadrant, twice as tall as wide
      const CRITTER = [
        '..############..',
        '..##.######.##..',
        '################',
        '..############..',
        '...#.#....#.#...',
      ];
      const cx0 = fx + (fw - 32) / 2, cy0 = fy + 2;
      CRITTER.forEach((row, ry) => {
        for (let rx = 0; rx < row.length; rx++) {
          if (row[rx] === '#') px('#d97757', cx0 + rx * 2, cy0 + ry * 4, 2, 4);
        }
      });
      px('#e8927a', cx0 + 4, cy0, 24, 1); // top highlight

      // door mat (the door itself is a gap in the screen-space frame)
      px('#3a2f36', door.tx * T + 2, door.ty * T - 10, T - 4, 6);
      px('#463840', door.tx * T + 3, door.ty * T - 9, T - 6, 4);
      return cv;
    },

    drawWallDynamic(ctx, t, hour) {
      for (let c = 0; c < this.map.cols; c++) this.drawWindow(ctx, (1 + c * 4) * T + 22, 12, t, hour);
      this.drawClock(ctx, (this.map.Lx - 1) * T + 8, 18);
      this.drawLimitsPanel(ctx);
    },

    drawWindow(ctx, x, y, t, hour) {
      const h = 13;
      let sky = '#6f9fc4', far = '#5a87ab';
      if (hour < 6 || hour >= 21) { sky = '#141a36'; far = '#1b2244'; }
      else if (hour < 8 || hour >= 19) { sky = '#c4826a'; far = '#a86a5c'; }
      ctx.fillStyle = '#3e3852'; ctx.fillRect(x - 2, y - 2, 24, h + 3);
      ctx.fillStyle = sky; ctx.fillRect(x, y, 20, h);
      ctx.fillStyle = far; ctx.fillRect(x, y + h - 4, 20, 4);
      // skyline
      ctx.fillStyle = shade(far, 0.75);
      ctx.fillRect(x + 1, y + h - 5, 4, 5); ctx.fillRect(x + 7, y + h - 7, 3, 7); ctx.fillRect(x + 13, y + h - 4, 5, 4);
      if (hour < 6 || hour >= 21) {
        ctx.fillStyle = '#d8d3a0';
        ctx.fillRect(x + 2, y + h - 4, 1, 1); ctx.fillRect(x + 8, y + h - 6, 1, 1); ctx.fillRect(x + 15, y + h - 3, 1, 1);
        ctx.fillStyle = '#cfd3ff';
        for (let i = 0; i < 3; i++) ctx.fillRect(x + ((i * 7 + x) % 19), y + 1 + ((i * 3) % 5), 1, 1);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        const cx = x + ((t * 2 + x) % 30) - 6;
        ctx.save(); ctx.beginPath(); ctx.rect(x, y, 20, h); ctx.clip();
        ctx.fillRect(cx, y + 3, 8, 2); ctx.fillRect(cx + 2, y + 2, 4, 1);
        ctx.restore();
      }
      ctx.fillStyle = '#4e4766'; ctx.fillRect(x + 9, y, 2, h); ctx.fillRect(x, y + 6, 20, 1);
      ctx.fillRect(x - 3, y + h, 26, 2);
      ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x + 1, y + 1, 3, 4);
    },

    setUsage(u) { this.usage = u; },

    limitsRect() {
      return { x0: T + 4, x1: (this.map.Lx - 1) * T - 2, y0: 1, y1: 9 };
    },

    // LED board on the back wall: frame in world space, contents drawn crisp in screen space
    drawLimitsPanel(ctx) {
      const { x0, x1, y0, y1 } = this.limitsRect();
      ctx.fillStyle = '#0c0b12'; ctx.fillRect(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2);
      ctx.fillStyle = '#3e3852'; ctx.fillRect(x0 - 1, y1 + 1, x1 - x0 + 2, 1);
      ctx.fillStyle = '#121019'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      // brackets holding it to the wall
      ctx.fillStyle = '#2a2638'; ctx.fillRect(x0 + 8, y1 + 1, 2, 2); ctx.fillRect(x1 - 10, y1 + 1, 2, 2);
    },

    drawLimitsText(ctx, t) {
      const { s, ox, oy, dpr } = this.view;
      const r = this.limitsRect();
      const X0 = ox + r.x0 * s, X1 = ox + r.x1 * s, Y0 = oy + r.y0 * s, Y1 = oy + r.y1 * s;
      const h = Y1 - Y0;
      const fs = Math.max(8, Math.min(12 * dpr, h * 0.62));
      const mid = Y0 + h / 2;
      ctx.save();
      ctx.beginPath(); ctx.rect(X0, Y0, X1 - X0, h); ctx.clip();
      ctx.textBaseline = 'middle';
      const rl = this.usage && this.usage.rate_limits;
      if (!rl) {
        ctx.font = `600 ${fs}px Consolas, monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#6a6385';
        ctx.fillText('ЛИМИТЫ ПОЯВЯТСЯ ПОСЛЕ ОТВЕТА В ЛЮБОЙ СЕССИИ CLAUDE CODE', (X0 + X1) / 2, mid);
        ctx.restore();
        return;
      }
      const nowS = Date.now() / 1000;
      const fmtReset = (ts, weekly) => {
        const left = ts - nowS;
        if (left <= 0) return 'сброшен';
        if (!weekly || left < 24 * 3600) {
          const hh = Math.floor(left / 3600), mm = Math.floor((left % 3600) / 60);
          return hh ? `сброс ${hh}ч ${mm}м` : `сброс ${mm}м`;
        }
        return 'сброс ' + new Date(ts * 1000).toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      };
      const parts = [
        { label: '5 ЧАСОВ', d: rl.five_hour, weekly: false },
        { label: 'НЕДЕЛЯ', d: rl.seven_day, weekly: true },
      ].filter((p) => p.d);
      const gap = 14 * dpr;
      const pw = (X1 - X0 - gap * (parts.length - 1)) / parts.length;
      parts.forEach((p, i) => {
        const px0 = X0 + i * (pw + gap), px1 = px0 + pw;
        const expired = p.d.resets_at && p.d.resets_at < nowS;
        const pct = expired ? 0 : Math.max(0, Math.min(100, Number(p.d.used_percentage) || 0));
        const col = pct >= 90 ? (Math.floor(t * 2) % 2 ? '#ff5d5d' : '#b83a3a') : pct >= 75 ? '#ff5d5d' : pct >= 50 ? '#ffc857' : '#5fd38d';
        ctx.font = `700 ${fs}px Consolas, monospace`;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#8a82a6';
        ctx.fillText(p.label, px0 + 6 * dpr, mid);
        const lw = ctx.measureText(p.label).width;
        const val = `${Math.round(pct)}%`;
        const rs = p.d.resets_at ? fmtReset(p.d.resets_at, p.weekly) : '';
        ctx.font = `600 ${fs}px Consolas, monospace`;
        const rsw = ctx.measureText(rs).width;
        ctx.font = `700 ${fs}px Consolas, monospace`;
        const vw = ctx.measureText(val).width;
        ctx.textAlign = 'right';
        ctx.font = `600 ${fs}px Consolas, monospace`;
        ctx.fillStyle = '#6a6385';
        ctx.fillText(rs, px1 - 4 * dpr, mid);
        ctx.font = `700 ${fs}px Consolas, monospace`;
        ctx.fillStyle = col;
        ctx.fillText(val, px1 - 4 * dpr - rsw - 8 * dpr, mid);
        // segmented LED bar
        const bx0 = px0 + 6 * dpr + lw + 8 * dpr, bx1 = px1 - 4 * dpr - rsw - 8 * dpr - vw - 8 * dpr;
        const seg = Math.max(2, Math.round(3 * dpr)), sg = Math.max(1, Math.round(dpr));
        const n = Math.floor((bx1 - bx0) / (seg + sg));
        if (n < 4) return;
        const lit = Math.round(n * pct / 100);
        const bh = Math.round(h * 0.5), by = Math.round(mid - bh / 2);
        for (let k = 0; k < n; k++) {
          ctx.fillStyle = k < lit ? col : '#221f2c';
          ctx.fillRect(Math.round(bx0 + k * (seg + sg)), by, seg, bh);
        }
      });
      ctx.restore();
    },

    drawClock(ctx, cx, cy) {
      ctx.fillStyle = '#3e3852'; ctx.fillRect(cx - 6, cy - 7, 13, 15); ctx.fillRect(cx - 7, cy - 6, 15, 13);
      ctx.fillStyle = '#b9b2a2'; ctx.fillRect(cx - 5, cy - 6, 11, 13); ctx.fillRect(cx - 6, cy - 5, 13, 11);
      ctx.fillStyle = '#6a6274';
      ctx.fillRect(cx, cy - 5, 1, 1); ctx.fillRect(cx, cy + 5, 1, 1); ctx.fillRect(cx - 5, cy, 1, 1); ctx.fillRect(cx + 5, cy, 1, 1);
      ctx.fillStyle = '#1f1b29';
      const d = new Date();
      const hand = (ang, len) => {
        for (let i = 0; i <= len; i++) ctx.fillRect(Math.round(cx + Math.sin(ang) * i), Math.round(cy - Math.cos(ang) * i), 1, 1);
      };
      hand(((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2, 3);
      hand(d.getMinutes() / 60 * Math.PI * 2, 4);
      ctx.fillStyle = '#c0392b';
      hand(d.getSeconds() / 60 * Math.PI * 2, 4);
    },

    drawDesk(ctx, d, t) {
      const x = (d.bx + 1) * T, y = (d.by + 1) * T;
      const owner = d.owner && this.chars.get(d.owner);
      const st = owner ? owner.s.state : null;
      const px = (col, a, b, w = 1, h = 1) => { ctx.fillStyle = col; ctx.fillRect(a, b, w, h); };
      // shadow
      px('rgba(0,0,0,0.25)', x + 1, y + 14, 31, 3);
      // drawer unit on the right
      px(ENV.drawer, x + 23, y + 9, 8, 7);
      px(ENV.deskEdge, x + 23, y + 12, 8, 1);
      px('#6b5a4b', x + 26, y + 10, 2, 1); px('#6b5a4b', x + 26, y + 13, 2, 1);
      // table
      px(ENV.deskTop, x, y + 2, 32, 9);
      px(ENV.deskHi, x, y + 2, 32, 1);
      px(ENV.deskEdge, x, y + 11, 32, 2);
      px(ENV.deskLeg, x + 1, y + 13, 2, 3);
      // cable down the back
      px('#1b1a22', x + 17, y + 3, 1, 1); px('#1b1a22', x + 18, y + 4, 1, 1);

      // monitor
      px('#2b2b36', x + 14, y + 1, 4, 3); px('#2b2b36', x + 11, y + 3, 10, 1);
      px(ENV.bezel, x + 7, y - 11, 18, 12);
      px(ENV.bezelHi, x + 7, y - 11, 18, 1);
      const sx = x + 8, sy = y - 10;
      const scr = (col) => px(col, sx, sy, 16, 9);
      if (st === 'working') {
        scr('#122038');
        const cols = ['#5fd38d', '#7aa7ff', '#ffc857', '#ff7fa8', '#c8c8d8'];
        const off = Math.floor(t * 4 + d.i);
        for (let i = 0; i < 4; i++) {
          const k = (off + i) * 7 + d.i;
          px(cols[k % cols.length], sx + 1 + (k % 3), sy + 1 + i * 2, 3 + (k % 10), 1);
        }
        if (Math.floor(t * 2) % 2) px('#ece7f6', sx + 2 + ((off * 3) % 10), sy + 7, 2, 1);
      } else if (st === 'waiting') {
        scr(Math.floor(t * 3) % 2 ? '#6a1f27' : '#3e141a');
        px('#ff6b6b', sx + 7, sy + 1, 2, 5); px('#ff6b6b', sx + 7, sy + 7, 2, 1);
      } else if (st === 'done') {
        scr('#1d3a2a');
        px('#5fd38d', sx + 4, sy + 4); px('#5fd38d', sx + 5, sy + 5); px('#5fd38d', sx + 6, sy + 6);
        px('#5fd38d', sx + 7, sy + 5); px('#5fd38d', sx + 8, sy + 4); px('#5fd38d', sx + 9, sy + 3); px('#5fd38d', sx + 10, sy + 2);
      } else if (st === 'idle') {
        scr('#10141f');
        const p = (t * 3 + d.i * 5) % 40;
        const bxp = p < 20 ? p : 40 - p;
        px('#2f6b70', sx + Math.floor(bxp * 13 / 20), sy + 3 + Math.round(Math.sin(t * 2 + d.i) * 2), 2, 2);
      } else {
        scr(ENV.screenOff);
        px('rgba(255,255,255,0.04)', sx + 1, sy + 1, 4, 2);
      }
      // power led
      px(st && st !== 'sleeping' ? '#5fd38d' : '#3a3a44', x + 23, y, 1, 1);

      // keyboard + mouse
      px('#24242e', x + 9, y + 6, 14, 4);
      for (let k = 0; k < 6; k++) px('#3a3a48', x + 10 + k * 2, y + 7, 1, 1);
      for (let k = 0; k < 5; k++) px('#3a3a48', x + 11 + k * 2, y + 8, 1, 1);
      px('#24242e', x + 25, y + 7, 2, 3); px('#3a3a48', x + 25, y + 7, 2, 1);

      // personal items vary per desk
      const v = d.i % 4;
      if (v === 0) { // mug
        px('#a9a3b5', x + 2, y + 4, 4, 4); px('#a9a3b5', x + 6, y + 5, 1, 2); px('#3e2a20', x + 3, y + 4, 2, 1);
      } else if (v === 1) { // tiny plant
        px('#5a3e30', x + 2, y + 5, 4, 4);
        px('#3e5e45', x + 1, y + 2, 2, 3); px('#4b7052', x + 4, y + 1, 2, 4); px('#3e5e45', x + 3, y + 3, 2, 2);
      } else if (v === 2) { // papers
        px('#8f8a80', x + 1, y + 4, 6, 5); px('#a39e93', x + 2, y + 3, 6, 5);
        px('#6c675f', x + 3, y + 4, 4, 1); px('#6c675f', x + 3, y + 6, 3, 1);
      } else { // desk lamp
        px('#3a3a46', x + 2, y + 8, 5, 1); px('#3a3a46', x + 4, y + 2, 1, 6); px('#4a4a58', x + 2, y + 1, 5, 2);
        if (st === 'working') px('rgba(255,220,150,0.35)', x + 1, y + 3, 7, 4);
      }
    },

    drawChair(ctx, d) {
      const cx = d.seat.x, cy = d.seat.y;
      const px = (col, a, b, w = 1, h = 1) => { ctx.fillStyle = col; ctx.fillRect(a, b, w, h); };
      px('rgba(0,0,0,0.25)', cx - 6, cy + 6, 12, 2);
      px(ENV.wheel, cx - 5, cy + 6, 2, 1); px(ENV.wheel, cx + 3, cy + 6, 2, 1); px(ENV.wheel, cx - 1, cy + 7, 2, 1);
      px('#1f2230', cx - 4, cy + 5, 8, 1);
      px('#1f2230', cx - 1, cy + 3, 2, 2);
      px(ENV.chair, cx - 6, cy - 6, 12, 9);
      px(ENV.chairHi, cx - 5, cy - 6, 10, 1);
      px(ENV.chairSeat, cx - 6, cy + 1, 12, 2);
      px('#20253a', cx - 7, cy - 2, 1, 4); px('#20253a', cx + 6, cy - 2, 1, 4); // armrests
    },

    drawItem(ctx, it, t) {
      const { x, y } = it;
      const px = (col, a, b, w = 1, h = 1) => { ctx.fillStyle = col; ctx.fillRect(a, b, w, h); };
      if (it.type === 'sofa') {
        px('rgba(0,0,0,0.25)', x - 3, y + 13, 70, 3);
        px('#2f283b', x - 3, y - 6, 70, 10);
        px('#3a3148', x - 3, y - 6, 70, 1);
        for (let k = 0; k < 4; k++) { px('#352d44', x + 1 + k * 16, y - 4, 14, 7); px('#3d3450', x + 2 + k * 16, y - 4, 12, 1); }
        px('#3d3450', x, y + 4, 64, 9);
        px('#453b5a', x, y + 4, 64, 1);
        for (let k = 1; k < 4; k++) px('#30293e', x + k * 16, y + 4, 1, 9);
        px('#2a2436', x, y + 12, 64, 2);
        px('#2f283b', x - 4, y - 2, 5, 16); px('#2f283b', x + 63, y - 2, 5, 16);
        px('#3a3148', x - 4, y - 2, 5, 1); px('#3a3148', x + 63, y - 2, 5, 1);
        // cushion with a hint of colour
        px('#5a4a6e', x + 50, y - 1, 8, 6); px('#66557c', x + 51, y, 6, 1);
      } else if (it.type === 'lamp') {
        px('rgba(0,0,0,0.25)', x + 4, y + 14, 8, 2);
        px('#2a2833', x + 5, y + 13, 6, 2);
        px('#2a2833', x + 7, y - 2, 2, 15);
        px('#7a6a52', x + 3, y - 9, 10, 7); px('#8a7a60', x + 3, y - 9, 10, 1);
        px('rgba(255,210,140,0.25)', x + 4, y - 2, 8, 2);
      } else if (it.type === 'ctable') {
        px('rgba(0,0,0,0.25)', x + 2, y + 13, 28, 2);
        px('#3e3129', x + 2, y + 3, 28, 9);
        px('#4a3a30', x + 2, y + 3, 28, 1);
        px('#2e241e', x + 3, y + 12, 2, 3); px('#2e241e', x + 27, y + 12, 2, 3);
        px('#a9a3b5', x + 7, y + 4, 3, 3); px('#3e2a20', x + 8, y + 4, 1, 1);
        px('#a9a3b5', x + 21, y + 6, 3, 3);
        px('#5b5466', x + 12, y + 5, 7, 4); px('#6c6578', x + 12, y + 5, 7, 1); // magazine
      } else if (it.type === 'coffee') {
        px('#363a46', x, y, 16, 32);
        px('#444957', x, y, 16, 3);
        px('#2c303b', x + 2, y + 9, 12, 1); px('#2c303b', x + 2, y + 20, 12, 1);
        px('#4c5262', x + 7, y + 14, 2, 1); px('#4c5262', x + 7, y + 25, 2, 1);
        px('#1d1f27', x + 3, y - 10, 10, 13);
        px('#2c2f3a', x + 4, y - 9, 8, 4);
        px('#b0664d', x + 5, y - 8, 3, 1);
        px(Math.floor(t * 2) % 2 ? '#ff5d5d' : '#5a2020', x + 11, y - 3, 1, 1);
        px('#a9a3b5', x + 6, y - 1, 3, 3);
        for (let i = 0; i < 3; i++) {
          const p = (t * 0.6 + i / 3) % 1;
          px(`rgba(220,220,235,${0.45 * (1 - p)})`, x + 7 + Math.round(Math.sin(p * 6 + i) * 1.5), y - 3 - Math.round(p * 10));
        }
      } else if (it.type === 'cooler') {
        px('rgba(0,0,0,0.25)', x + 3, y + 14, 10, 2);
        px('rgba(95,143,176,0.85)', x + 4, y - 8, 8, 9);
        px('rgba(255,255,255,0.25)', x + 5, y - 7, 1, 6);
        px('#7d7d8a', x + 3, y + 1, 10, 13);
        px('#8c8c99', x + 3, y + 1, 10, 1);
        px('#66666f', x + 3, y + 12, 10, 2);
        px('#4f6f9f', x + 5, y + 4, 2, 2); px('#9f5a5a', x + 9, y + 4, 2, 2);
      } else if (it.type === 'pingpong') {
        px('rgba(0,0,0,0.25)', x + 1, y + 26, 64, 3);
        px('#1d3129', x, y + 4, 64, 22);
        px('#28443a', x, y + 2, 64, 22);
        px('#7d8a84', x, y + 2, 64, 1); px('#7d8a84', x, y + 23, 64, 1); px('#7d8a84', x, y + 2, 1, 22); px('#7d8a84', x + 63, y + 2, 1, 22);
        px('#5d6a64', x, y + 12, 64, 1);
        px('#9aa3a0', x + 31, y - 1, 2, 26); px('#6d7673', x + 31, y + 24, 2, 2);
        px('#26262f', x + 3, y + 25, 2, 4); px('#26262f', x + 59, y + 25, 2, 4);
        // rally when both ends are taken and the players have arrived
        const [a, b] = this.map.spots.filter((s) => s.kind === 'pp1' || s.kind === 'pp2').map((s) => s.owner && this.chars.get(s.owner));
        if (a && b && !a.path.length && !b.path.length) {
          const p = (t * 0.9) % 2, q = p < 1 ? p : 2 - p;
          const bx = x + 2 + q * 60, by = y + 13 - Math.abs(Math.sin(q * Math.PI * 2)) * 8;
          px('rgba(0,0,0,0.3)', Math.round(bx), y + 14, 2, 1);
          px('#ffffff', Math.round(bx), Math.round(by), 2, 2);
        } else {
          // paddles resting on the table
          px('#7a3a34', x + 10, y + 6, 3, 3); px('#7a3a34', x + 50, y + 16, 3, 3);
        }
      } else if (it.type === 'plant') {
        px('rgba(0,0,0,0.25)', x + 3, y + 14, 10, 2);
        px('#5a3e30', x + 4, y + 8, 8, 7);
        px('#4a3226', x + 4, y + 8, 8, 1); px('#6a4a3a', x + 5, y + 10, 1, 4);
        if (it.v === 1) {
          px('#35553e', x + 7, y - 8, 2, 16);
          px('#3e5e45', x + 2, y - 4, 5, 3); px('#4b7052', x + 9, y - 6, 5, 3); px('#3e5e45', x + 3, y + 1, 4, 3); px('#4b7052', x + 9, y, 4, 3);
        } else if (it.v === 2) {
          px('#3e5e45', x + 3, y + 2, 10, 6); px('#4b7052', x + 4, y, 8, 3); px('#567b5c', x + 6, y + 1, 2, 2); px('#567b5c', x + 9, y + 3, 2, 2);
        } else {
          px('#35553e', x + 2, y - 2, 4, 9); px('#35553e', x + 10, y - 1, 4, 8); px('#3e5e45', x + 6, y - 6, 4, 13);
          px('#4b7052', x + 3, y - 1, 2, 6); px('#4b7052', x + 7, y - 5, 2, 9); px('#4b7052', x + 11, y, 2, 5);
        }
      } else if (it.type === 'coatrack') {
        px('rgba(0,0,0,0.25)', x + 4, y + 14, 8, 2);
        px('#2e2620', x + 7, y - 6, 2, 20); px('#2e2620', x + 4, y + 13, 8, 1);
        px('#2e2620', x + 4, y - 6, 8, 1);
        px('#4a3f5c', x + 3, y - 5, 4, 9); px('#3f4a5c', x + 9, y - 5, 4, 7);
      }
    },

    drawChar(ctx, c, t) {
      const P = c.pal;
      const shoe = '#1e1c26', eye = '#1d1a24';
      let x0 = Math.round(c.x) - 5, y0 = Math.round(c.y) - 18;
      const pose = c.pose;
      const walking = pose === 'walk';
      const phase = walking ? Math.floor(t * 8 + c.seed) % 2 : -1;
      const dir = c.dir;
      const flip = dir === 'left';
      const shirtHi = shade(P.shirt, 1.15), shirtLo = shade(P.shirt, 0.75), hairHi = shade(P.hair, 1.35), pantsLo = shade(P.pants, 0.8);
      const ops = [];
      const r = (col, dx, dy, w, h) => ops.push([col, dx, dy, w, h]);
      const sel = this.selected === c.id, hov = this.hover === c.id;

      if (pose === 'type' || pose === 'sleep') {
        // seen from behind, sitting at the desk
        y0 += 1;
        const sleep = pose === 'sleep';
        const hy = sleep ? 3 : 0;
        r(P.shirt, 1, 8, 8, 7);
        r(shirtLo, 8, 8, 1, 7); r(shirtHi, 1, 8, 1, 7);
        r(shirtLo, 4, 9, 2, 5);
        if (sleep) {
          r(P.shirt, 0, 7, 10, 2);
        } else {
          const f = Math.floor(t * 9 + c.seed) % 2;
          r(shirtLo, 0, 8, 1, 4); r(shirtLo, 9, 8, 1, 4);
          r(P.skin, 0, 6 + f, 1, 2); r(P.skin, 9, 7 - f, 1, 2);
        }
        r(P.skin, 1, 4 + hy, 1, 2); r(P.skin, 8, 4 + hy, 1, 2);
        r(P.skin, 4, 7 + hy, 2, 1);
        r(P.hair, 2, hy, 6, 7); r(P.hair, 1, 1 + hy, 8, 4);
        r(hairHi, 3, hy, 3, 1);
        if (c.longHair) r(P.hair, 2, 7 + hy, 6, 3);
        this.paint(ctx, ops, x0, y0, flip);
        return this.outlineMark(ctx, c, sel, hov);
      }

      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(x0 + 1, y0 + 17, 8, 2);

      const sitting = pose === 'sitFront' || pose === 'sofaSleep';
      if (sitting) y0 -= 1;

      // legs
      if (sitting) {
        r(P.pants, 2, 13, 6, 3); r(pantsLo, 2, 15, 6, 1);
        r(P.pants, 2, 16, 2, 1); r(P.pants, 6, 16, 2, 1);
        r(shoe, 2, 17, 2, 1); r(shoe, 6, 17, 2, 1);
      } else if (dir === 'left' || dir === 'right') {
        if (phase === 0) { r(P.pants, 2, 14, 2, 3); r(pantsLo, 6, 14, 2, 3); r(shoe, 1, 17, 3, 1); r(shoe, 6, 17, 3, 1); }
        else { r(P.pants, 4, 14, 3, 3); r(shoe, 4, 17, 4, 1); }
      } else {
        const lL = phase === 0 ? 1 : 0, rL = phase === 1 ? 1 : 0;
        r(P.pants, 2, 14, 3, 3 - lL); r(shoe, 2, 17 - lL, 3, 1);
        r(pantsLo, 5, 14, 3, 3 - rL); r(shoe, 5, 17 - rL, 3, 1);
      }

      // body + head
      if (dir === 'left' || dir === 'right') {
        r(P.shirt, 2, 8, 6, 6);
        r(shirtLo, 2, 13, 6, 1); r(shirtHi, 7, 8, 1, 5);
        const sw = phase === 0 ? 1 : phase === 1 ? -1 : 0;
        r(shirtLo, 4 + sw, 9, 2, 4);
        r(P.skin, 4 + sw, 13, 2, 1);
        // a paddle at the ping-pong table, a mug at the coffee machine
        if (!walking && c.spot && c.spot.kind.startsWith('pp')) { r('#c0392b', 7, 9, 2, 3); r('#6b4a33', 7, 12, 1, 1); }
        if (!walking && c.spot && c.spot.kind === 'coffee' && t - c.arrivedAt > 2) { r('#f2f2f2', 6, 10, 3, 3); }
        r(P.skin, 2, 2, 6, 6);
        r(P.hair, 1, 0, 8, 3); r(P.hair, 1, 3, 3, 3); r(hairHi, 4, 0, 3, 1);
        if (c.longHair) r(P.hair, 1, 6, 3, 4);
        r(eye, 6, 4, 1, 1);
        r(P.skin, 8, 4, 1, 1);
      } else {
        r(P.shirt, 1, 8, 8, 6);
        r(shirtLo, 1, 13, 8, 1); r(shirtHi, 2, 8, 1, 5); r(shirtLo, 8, 8, 1, 5);
        const swL = phase === 0 ? 1 : 0, swR = phase === 1 ? 1 : 0;
        r(shirtLo, 0, 8 + swL, 1, 4); r(P.skin, 0, 12 + swL, 1, 1);
        r(shirtLo, 9, 8 + swR, 1, 4); r(P.skin, 9, 12 + swR, 1, 1);
        r(P.skin, 2, 2, 6, 6);
        if (dir === 'up') {
          r(P.hair, 2, 0, 6, 7); r(P.hair, 1, 1, 8, 4); r(hairHi, 3, 0, 3, 1);
          r(P.skin, 1, 5, 1, 1); r(P.skin, 8, 5, 1, 1);
          if (c.longHair) r(P.hair, 2, 7, 6, 3);
        } else {
          r(shirtHi, 4, 8, 2, 1); // collar
          r(P.hair, 1, 0, 8, 3); r(P.hair, 1, 3, 1, 3); r(P.hair, 8, 3, 1, 2); r(hairHi, 3, 0, 3, 1);
          if (c.longHair) { r(P.hair, 1, 6, 1, 4); r(P.hair, 8, 5, 1, 5); }
          const blink = pose === 'sofaSleep' || ((t + c.seed) % 4) < 0.13;
          if (blink) { r(eye, 3, 5, 1, 1); r(eye, 6, 5, 1, 1); }
          else { r(eye, 3, 4, 1, 2); r(eye, 6, 4, 1, 2); }
          r(shade(P.skin, 0.85), 4, 7, 2, 1); // chin shadow / mouth
          if ((c.s.state === 'done' || c.s.state === 'waiting') && !walking) {
            // waving
            const up = Math.floor(t * 4 + c.seed) % 2;
            r(shirtLo, 9, 5 + up, 1, 4); r(P.skin, 9, 4 + up, 1, 1);
          }
        }
      }
      this.paint(ctx, ops, x0, y0, flip);
      this.outlineMark(ctx, c, sel, hov);
    },

    // draws collected rects with a 1px dark silhouette outline behind them
    paint(ctx, ops, x0, y0, flip) {
      const X = (dx, w) => (flip ? x0 + 10 - dx - w : x0 + dx);
      ctx.fillStyle = ENV.outline;
      for (const [, dx, dy, w, h] of ops) {
        const x = X(dx, w), y = y0 + dy;
        ctx.fillRect(x - 1, y, w + 2, h);
        ctx.fillRect(x, y - 1, w, h + 2);
      }
      for (const [col, dx, dy, w, h] of ops) {
        ctx.fillStyle = col;
        ctx.fillRect(X(dx, w), y0 + dy, w, h);
      }
    },

    outlineMark(ctx, c, sel, hov) {
      if (!sel && !hov) return;
      const x = Math.round(c.x), y = Math.round(c.y);
      ctx.fillStyle = sel ? '#ffffff' : 'rgba(255,255,255,0.5)';
      ctx.fillRect(x - 7, y + 2, 14, 1);
      ctx.fillRect(x - 7, y + 1, 1, 1); ctx.fillRect(x + 6, y + 1, 1, 1);
    },

    drawOverlay(ctx, c, t) {
      const { s, ox, oy, dpr } = this.view;
      const sx = ox + c.x * s;
      const headY = oy + (c.y - 21 + (c.pose === 'type' || c.pose === 'sleep' ? 2 : 0)) * s;
      const fs = Math.round(11 * dpr);
      const st = c.s.state;
      const sel = this.selected === c.id, hov = this.hover === c.id;
      const active = st === 'working' || st === 'waiting' || st === 'done';

      // name tag under the feet (sleepers only on hover, they huddle on the sofa)
      if (st !== 'sleeping' || sel || hov) {
        ctx.font = `600 ${Math.round(10 * dpr)}px "Segoe UI", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const name = c.name.length > 20 ? c.name.slice(0, 19) + '…' : c.name;
        const ny = oy + (c.y + 3) * s;
        const nw = ctx.measureText(name).width + 10 * dpr;
        const nh = Math.round(14 * dpr);
        const nx = Math.round(sx - nw / 2);
        if (sel) ctx.fillStyle = 'rgba(217,119,87,0.95)';
        else ctx.fillStyle = active || hov ? 'rgba(14,12,20,0.85)' : 'rgba(14,12,20,0.55)';
        ctx.fillRect(nx, Math.round(ny), Math.round(nw), nh);
        if (!sel && active) {
          ctx.fillStyle = STATE_COLOR[st];
          ctx.fillRect(nx, Math.round(ny), Math.max(2, Math.round(2 * dpr)), nh);
        }
        ctx.fillStyle = sel ? '#1b1214' : active || hov ? '#ece7f6' : 'rgba(236,231,246,0.55)';
        ctx.fillText(name, sx + (active && !sel ? dpr : 0), ny + 2 * dpr);
      }

      if (sel) {
        const b = Math.round(Math.sin(t * 5) * 3 * dpr);
        ctx.fillStyle = '#d97757';
        const ay = headY - 34 * dpr + b;
        ctx.beginPath(); ctx.moveTo(sx - 6 * dpr, ay); ctx.lineTo(sx + 6 * dpr, ay); ctx.lineTo(sx, ay + 7 * dpr); ctx.fill();
      }

      let text = null, bg = '#f4f1fa', fg = '#1b1726';
      if (c.leaving) text = 'пока!';
      else if (st === 'working' && c.pose === 'type') text = c.s.activity || 'Работает…';
      else if (st === 'waiting') { text = '!'; bg = Math.floor(t * 3) % 2 ? '#ff5d5d' : '#d84040'; fg = '#fff'; }
      else if (st === 'done' && !c.path.length) { text = '✓ готово'; bg = '#ffc857'; }
      else if (st === 'idle' && c.spot && c.spot.kind === 'coffee' && !c.path.length) { text = '☕'; bg = '#9a92b3'; }
      if (st === 'sleeping' && (c.pose === 'sleep' || c.pose === 'sofaSleep')) {
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let i = 0; i < 3; i++) {
          const p = (t * 0.45 + i / 3 + c.seed) % 1;
          ctx.font = `800 ${Math.round((10 + p * 8) * dpr)}px Consolas, monospace`;
          ctx.lineWidth = 3 * dpr;
          ctx.strokeStyle = `rgba(14,12,20,${1 - p})`;
          ctx.fillStyle = `rgba(200,195,230,${0.85 * (1 - p)})`;
          const zx = sx + (3 + p * 9) * s, zy = headY - p * 14 * s;
          ctx.strokeText('z', zx, zy);
          ctx.fillText('z', zx, zy);
        }
      }
      if (!text) return;
      if (text.length > 30) text = text.slice(0, 29) + '…';
      ctx.font = `600 ${fs}px Consolas, monospace`;
      ctx.textAlign = 'center';
      const w = Math.round(ctx.measureText(text).width + 12 * dpr);
      const h = Math.round(18 * dpr);
      const bx = Math.round(sx - w / 2), by = Math.round(headY - h - 6 * dpr);
      const px = Math.max(1, Math.round(2 * dpr));
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(bx + px, by + px * 2, w, h);
      ctx.fillStyle = ENV.outline;
      ctx.fillRect(bx - px, by - px, w + 2 * px, h + 2 * px);
      ctx.fillStyle = bg;
      ctx.fillRect(bx, by, w, h);
      if (st === 'working') {
        ctx.fillStyle = STATE_COLOR.working;
        ctx.fillRect(bx, by, Math.max(2, Math.round(3 * dpr)), h);
        ctx.fillStyle = bg;
      }
      ctx.beginPath();
      ctx.moveTo(sx - 4 * dpr, by + h); ctx.lineTo(sx + 4 * dpr, by + h); ctx.lineTo(sx, by + h + 5 * dpr);
      ctx.fill();
      ctx.fillStyle = fg;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, sx + (st === 'working' ? dpr : 0), by + h / 2 + 1);
    },
  };

  Office.STATE_COLOR = STATE_COLOR;
  Office.paletteOf = (id) => {
    const h = hash(id);
    return { shirt: SHIRT[(h >>> 9) % SHIRT.length], hair: HAIR[(h >>> 4) % HAIR.length], skin: SKIN[h % SKIN.length] };
  };
  window.Office = Office;
})();
