// Compact always-on-top desktop widget: plan limits + who is working / waiting.
(() => {
  const STATE_LABEL = { working: 'работает', waiting: 'ждёт тебя', done: 'готово', idle: 'отдыхает', sleeping: 'спит' };
  const ORDER = { waiting: 0, working: 1, done: 2, idle: 3, sleeping: 4 };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // the orange critter in the header
  (() => {
    const g = $('#critter').getContext('2d');
    const rows = ['..############..', '..##.######.##..', '################', '..############..', '...#.#....#.#...'];
    g.fillStyle = '#d97757';
    rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '#') g.fillRect(x, y * 2, 1, 2); }));
  })();

  // tiny head-and-shoulders portrait in the agent's own colours
  function avatar(id) {
    const c = document.createElement('canvas');
    c.width = 10; c.height = 12;
    const g = c.getContext('2d');
    const p = Office.paletteOf(id);
    const r = (col, x, y, w, h) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
    r('#0e0c14', 1, 0, 8, 1); r('#0e0c14', 0, 1, 10, 11);
    r(p.shirt, 1, 8, 8, 4);
    r(p.skin, 2, 2, 6, 6);
    r(p.hair, 1, 1, 8, 2); r(p.hair, 1, 3, 1, 3); r(p.hair, 8, 3, 1, 2);
    r('#1d1a24', 3, 4, 1, 2); r('#1d1a24', 6, 4, 1, 2);
    return c;
  }

  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'только что';
    if (s < 3600) return `${Math.floor(s / 60)} мин`;
    return `${Math.floor(s / 3600)} ч`;
  }

  function renderList(list) {
    const sorted = [...list].sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || (b.mtime - a.mtime));
    const n = (st) => list.filter((s) => s.state === st).length;
    const sum = [];
    if (n('working')) sum.push(`⚙ ${n('working')}`);
    if (n('waiting')) sum.push(`! ${n('waiting')}`);
    if (n('done')) sum.push(`✓ ${n('done')}`);
    $('#sum').textContent = sum.join('  ');
    $('#empty').hidden = list.length > 0;
    const ul = $('#list');
    ul.innerHTML = '';
    for (const s of sorted) {
      const li = document.createElement('li');
      li.className = s.state + (s.state === 'idle' || s.state === 'sleeping' ? ' quiet' : '');
      li.title = s.title || '';
      const sub = s.state === 'working' && s.activity ? s.activity
        : s.state === 'waiting' && s.activity ? s.activity
        : `${STATE_LABEL[s.state]} · ${ago(s.mtime)}`;
      li.appendChild(avatar(s.id));
      const main = document.createElement('div');
      main.className = 'w-main';
      main.innerHTML = `<div class="w-name">${esc(s.name || s.project)}</div><div class="w-sub">${esc(sub)}</div>`;
      li.appendChild(main);
      li.addEventListener('click', () => window.api.showMain(s.id));
      ul.appendChild(li);
    }
  }

  async function renderLimits() {
    const u = await window.api.usage();
    const rl = u && u.rate_limits;
    const box = $('#limits');
    if (!rl) { box.innerHTML = ''; return; }
    const now = Date.now() / 1000;
    const row = (label, d, weekly) => {
      if (!d) return '';
      const expired = d.resets_at && d.resets_at < now;
      const pct = expired ? 0 : Math.max(0, Math.min(100, Number(d.used_percentage) || 0));
      const col = pct >= 75 ? '#ff5d5d' : pct >= 50 ? '#ffc857' : '#5fd38d';
      let reset = '';
      if (d.resets_at && !expired) {
        const left = d.resets_at - now;
        reset = !weekly || left < 86400
          ? `${Math.floor(left / 3600)}ч${String(Math.floor((left % 3600) / 60)).padStart(2, '0')}`
          : new Date(d.resets_at * 1000).toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      }
      return `<span class="lim-label">${label}</span>
        <span class="lim-bar"><i style="width:${pct}%;background:${col}"></i></span>
        <span class="lim-val"><b style="color:${col}">${Math.round(pct)}%</b> ${reset}</span>`;
    };
    box.innerHTML = row('5 ч', rl.five_hour, false) + row('нед', rl.seven_day, true);
  }

  $('#open').addEventListener('click', () => window.api.showMain());
  $('#close').addEventListener('click', () => window.api.setWidget(false));

  window.api.onSessions(renderList);
  window.api.scan().then(renderList);
  renderLimits();
  setInterval(renderLimits, 15000);
})();
