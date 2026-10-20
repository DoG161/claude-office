(() => {
  const STATE_LABEL = {
    working: 'работает', waiting: 'ждёт тебя', done: 'готово', idle: 'отдыхает', sleeping: 'спит',
  };
  const ORDER = { waiting: 0, working: 1, done: 2, idle: 3, sleeping: 4 };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const errText = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  let sessions = [];
  let hiddenCount = 0;
  let selected = null;
  let renaming = null; // session id whose name is being edited

  const nameOf = (s) => s.name || s.project;
  const canRest = (s) => s.state === 'done' || s.state === 'waiting';

  Office.init($('#office'), (id) => select(id), (id) => startRename(id));

  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'только что';
    if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
    return `${Math.floor(s / 3600)} ч назад`;
  }

  function select(id) {
    selected = id;
    Office.select(id);
    render();
  }

  async function tick() {
    try {
      sessions = await window.api.scan();
      Office.update(sessions);
      Office.setUsage(await window.api.usage());
      hiddenCount = await window.api.hiddenCount();
      render();
    } catch (e) {
      console.error(e);
    }
    setTimeout(tick, 1500);
  }

  function render() {
    const sorted = [...sessions].sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || (b.mtime - a.mtime));
    $('#empty').hidden = sessions.length > 0;
    const hb = $('#hidden-bar');
    hb.hidden = !hiddenCount;
    hb.innerHTML = `Убрано из офиса: ${hiddenCount} · <a href="#" data-act="unhide">вернуть всех</a>`;

    const counts = {};
    for (const s of sessions) counts[s.state] = (counts[s.state] || 0) + 1;
    $('#stats').innerHTML = ['working', 'waiting', 'done', 'idle', 'sleeping']
      .filter((k) => counts[k])
      .map((k) => `<span><i class="dot" style="background:${Office.STATE_COLOR[k]}"></i><b>${counts[k]}</b> ${STATE_LABEL[k]}</span>`)
      .join('');
    $('#btn-rest-all').hidden = !counts.done;

    $('#agents').innerHTML = sorted.map((s) => {
      const pal = Office.paletteOf(s.id);
      let sub = s.state === 'working' && s.activity ? s.activity : `${STATE_LABEL[s.state]} · ${ago(s.mtime)}`;
      if (s.name) sub = `${s.project} · ${sub}`;
      return `<li data-id="${s.id}" class="${s.id === selected ? 'sel' : ''}">
        <span class="swatch" style="background:linear-gradient(${pal.hair} 0 30%, ${pal.skin} 30% 55%, ${pal.shirt} 55%)"><i style="background:${Office.STATE_COLOR[s.state]}"></i></span>
        <div class="ag-main"><div class="ag-name">${esc(nameOf(s))}</div><div class="ag-sub">${esc(sub)}</div></div>
      </li>`;
    }).join('');

    const s = sessions.find((x) => x.id === selected);
    const det = $('#details');
    if (!s) { det.hidden = true; renaming = null; return; }
    det.hidden = false;
    if (renaming === s.id) return; // don't wipe the input while typing
    const live = termForSession(s.id);
    det.innerHTML = `
      <div class="title-row"><h3>${esc(nameOf(s))}</h3><button class="icon-btn" data-act="rename" title="Переименовать (или двойной клик по персонажу)">✎</button></div>
      <div class="path">${s.name ? `${esc(s.project)} · ` : ''}${esc(s.cwd)}</div>
      <span class="state" style="background:${Office.STATE_COLOR[s.state]}">${STATE_LABEL[s.state]}</span>
      <span class="muted"> · ${ago(s.mtime)}${live ? ' · открыт здесь' : ''}</span>
      ${canRest(s) ? '<div class="actions"><button class="btn rest" data-act="rest" title="Агент уйдёт в зону отдыха и вернётся к столу, когда сессия снова начнёт работать">☕ Отпустить отдыхать</button></div>' : ''}
      <div class="label">Скиллы</div>
      <div class="chips">${s.skills.map((k) => `<span class="chip">${esc(k)}</span>`).join('')}<button class="chip add" data-act="skills">+ подключить</button></div>
      <div class="label">Тема</div><div class="quote">${esc(s.title)}</div>
      ${s.lastPrompt ? `<div class="label">Последний запрос</div><div class="quote">${esc(s.lastPrompt)}</div>` : ''}
      <div class="actions">
        <button class="btn primary" data-act="resume">${live ? 'К терминалу' : 'Открыть в терминале'}</button>
        <button class="btn" data-act="folder">Папка</button>
      </div>
      <div class="actions">
        <button class="btn" data-act="hide" title="Агент уйдёт из офиса. Файл сессии не трогается; если продолжишь её в Claude Code, агент вернётся. (клавиша Delete)">Убрать из офиса</button>
        <button class="btn danger" data-act="trash" title="Переместить файл сессии в Корзину Windows">Удалить…</button>
      </div>`;
  }

  $('#agents').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) select(li.dataset.id);
  });
  $('#agents').addEventListener('dblclick', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) startRename(li.dataset.id);
  });

  // ---------------- rest / remove ----------------

  async function rest(list) {
    if (!list.length) return;
    await window.api.rest(list.map((s) => s.id));
    // show it right away; the next scan confirms it
    for (const s of list) { s.state = 'idle'; s.rested = true; }
    Office.update(sessions);
    render();
  }

  $('#btn-rest-all').addEventListener('click', () => rest(sessions.filter((s) => s.state === 'done')));

  async function removeAgent(s, trash) {
    if (trash) {
      const live = s.state === 'working' || s.state === 'waiting'
        ? '\n\nВнимание: сессия сейчас активна в другом окне.' : '';
      if (!confirm(`Удалить сессию «${nameOf(s)}»?\n\nФайл истории переместится в Корзину Windows — продолжить сессию через --resume будет нельзя, пока не восстановишь его оттуда.${live}`)) return;
      try { await window.api.trash(s.id); } catch (e) {
        alert(errText(e));
        return;
      }
    } else {
      await window.api.hide(s.id);
      hiddenCount++;
    }
    sessions = sessions.filter((x) => x.id !== s.id);
    Office.update(sessions); // the character walks out of the door
    select(null);
  }

  $('#hidden-bar').addEventListener('click', async (e) => {
    if (e.target.dataset.act !== 'unhide') return;
    e.preventDefault();
    await window.api.unhideAll();
    hiddenCount = 0;
    render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) { closeModal(); return; }
    if (e.key !== 'Delete' || !selected || renaming || !$('#modal').hidden) return;
    if (e.target.closest && e.target.closest('input, textarea, .term')) return;
    const s = sessions.find((x) => x.id === selected);
    if (s) removeAgent(s, false);
  });

  function startRename(id) {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    if (selected !== id) select(id);
    renaming = id;
    const row = $('#details .title-row');
    row.innerHTML = `<input class="rename" maxlength="40" placeholder="${esc(s.project)}" value="${esc(s.name || '')}">`;
    const input = row.querySelector('input');
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save) s.name = await window.api.rename(id, input.value);
      renaming = null;
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  $('#details').addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    const s = sessions.find((x) => x.id === selected);
    if (!act || !s) return;
    if (act === 'folder') window.api.openFolder(s.cwd);
    if (act === 'rename') startRename(s.id);
    if (act === 'hide') removeAgent(s, false);
    if (act === 'trash') removeAgent(s, true);
    if (act === 'rest') rest([s]);
    if (act === 'skills') attachSkillsDialog(s);
    if (act === 'resume') {
      const live = termForSession(s.id);
      if (live) { $('#drawer').classList.remove('collapsed'); activate(live); return; }
      if ((s.state === 'working' || s.state === 'waiting') &&
          !confirm('Эта сессия сейчас активна в другом окне. Открыть её копию здесь всё равно?')) return;
      openTerminal({ cwd: s.cwd, resumeId: s.id, label: nameOf(s) });
    }
  });

  // desktop widget toggle; the main process owns the window and tells us its state
  let widgetOn = false;
  const showWidgetState = (on) => { widgetOn = on; $('#btn-widget').classList.toggle('on', on); };
  window.api.widgetEnabled().then(showWidgetState);
  window.api.onWidgetState(showWidgetState);
  $('#btn-widget').addEventListener('click', () => window.api.setWidget(!widgetOn));
  // clicks on the widget or on a notification bring us here with an agent to show
  window.api.onSelect((id) => select(id));

  $('#btn-term').addEventListener('click', () => {
    $('#drawer').classList.toggle('collapsed');
    fitActive();
  });

  // ---------------- modal + skill picker ----------------

  function openModal(html) {
    $('#modal-card').innerHTML = html;
    $('#modal').hidden = false;
    return $('#modal-card');
  }
  function closeModal() { $('#modal').hidden = true; $('#modal-card').innerHTML = ''; }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });

  // searchable, grouped checklist of every skill Claude Code can see for a folder
  function skillPicker(root, { exclude = [] } = {}) {
    const chosen = new Set();
    let all = [];
    let cwd = null;
    root.innerHTML = `
      <div class="chips picked"></div>
      <input class="field" type="search" placeholder="Поиск скилла по названию или описанию…">
      <div class="skill-list"><div class="muted pad">Загружаю…</div></div>`;
    const list = root.querySelector('.skill-list');
    const picked = root.querySelector('.picked');
    const search = root.querySelector('input');

    function draw() {
      const q = search.value.trim().toLowerCase();
      const items = all.filter((s) => !exclude.includes(s.id) &&
        (!q || s.id.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)));
      const groups = new Map();
      for (const s of items) {
        if (!groups.has(s.source)) groups.set(s.source, []);
        groups.get(s.source).push(s);
      }
      list.innerHTML = items.length
        ? [...groups].map(([src, arr]) => `<div class="grp">${esc(src)} <span class="muted">${arr.length}</span></div>` +
          arr.map((s) => `<label class="skill${chosen.has(s.id) ? ' on' : ''}" title="${esc(s.description)}">
              <input type="checkbox" value="${esc(s.id)}" ${chosen.has(s.id) ? 'checked' : ''}>
              <span class="sk-main"><span class="sk-name">${esc(s.id)}</span><span class="sk-desc">${esc(s.description)}</span></span>
              <button class="star${s.pinned ? ' on' : ''}" data-pin="${esc(s.id)}" title="${s.pinned ? 'Убрать из личных' : 'В личные'}">${s.pinned ? '★' : '☆'}</button>
            </label>`).join('')).join('')
        : '<div class="muted pad">Ничего не нашлось</div>';
      picked.innerHTML = [...chosen].map((id) => `<span class="chip on">${esc(id)}<b data-rm="${esc(id)}">✕</b></span>`).join('');
      root.dispatchEvent(new CustomEvent('change'));
    }
    list.addEventListener('change', (e) => {
      if (e.target.type !== 'checkbox') return;
      if (e.target.checked) chosen.add(e.target.value); else chosen.delete(e.target.value);
      draw();
    });
    list.addEventListener('click', async (e) => {
      const id = e.target.dataset.pin;
      if (!id) return;
      e.preventDefault(); // don't toggle the checkbox of the row
      const s = all.find((x) => x.id === id);
      await window.api.pinSkill(id, !s.pinned);
      all = await window.api.skills(cwd);
      draw();
    });
    picked.addEventListener('click', (e) => {
      const id = e.target.dataset.rm;
      if (id) { chosen.delete(id); draw(); }
    });
    search.addEventListener('input', draw);

    return {
      selected: () => [...chosen],
      async load(dir) {
        cwd = dir || null;
        all = await window.api.skills(cwd);
        for (const id of [...chosen]) if (!all.some((s) => s.id === id)) chosen.delete(id);
        draw();
      },
    };
  }

  // ---------------- new agent ----------------

  $('#btn-new').addEventListener('click', newAgentDialog);

  function newAgentDialog() {
    const card = openModal(`
      <h2>Новый агент</h2>
      <label class="fld"><span>Название</span>
        <input class="field" id="na-name" maxlength="40" placeholder="Например: Порт на Pixi"></label>
      <label class="fld"><span>Папка проекта</span>
        <div class="row"><input class="field" id="na-dir" placeholder="D:\\Projects\\my-game"><button class="btn" id="na-browse">Обзор…</button></div></label>
      <label class="fld"><span>Задача <em>— необязательно, можно написать потом в терминале</em></span>
        <textarea class="field" id="na-prompt" rows="3" placeholder="С чего начать агенту"></textarea></label>
      <div class="fld"><span>Скиллы <em id="na-count"></em></span><div id="na-skills"></div></div>
      <div class="err" id="na-err" hidden></div>
      <div class="modal-actions">
        <button class="btn" data-close>Отмена</button>
        <button class="btn primary" id="na-go">Запустить агента</button>
      </div>`);
    const dir = card.querySelector('#na-dir');
    const name = card.querySelector('#na-name');
    dir.value = store.get('lastDir') || '';
    const picker = skillPicker(card.querySelector('#na-skills'));
    card.querySelector('#na-skills').addEventListener('change', () => {
      const n = picker.selected().length;
      card.querySelector('#na-count').textContent = n ? `— выбрано: ${n}` : '— загрузятся при старте сессии';
    });
    picker.load(dir.value);
    let t;
    dir.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => picker.load(dir.value.trim()), 400); });
    card.querySelector('#na-browse').addEventListener('click', async () => {
      const d = await window.api.pickFolder();
      if (!d) return;
      dir.value = d;
      if (!name.value) name.placeholder = d.split(/[\\/]/).filter(Boolean).pop() || d;
      picker.load(d);
    });
    card.querySelector('[data-close]').addEventListener('click', closeModal);
    card.querySelector('#na-go').addEventListener('click', async () => {
      const cwd = dir.value.trim();
      const err = card.querySelector('#na-err');
      if (!cwd) { err.hidden = false; err.textContent = 'Укажи папку проекта'; dir.focus(); return; }
      const label = name.value.trim() || cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
      const ok = await openTerminal({
        cwd,
        name: name.value.trim() || null,
        skills: picker.selected(),
        prompt: card.querySelector('#na-prompt').value.trim() || null,
        label,
        onError: (m) => { err.hidden = false; err.textContent = m; },
      });
      if (!ok) return;
      store.set('lastDir', cwd);
      closeModal();
    });
    name.focus();
  }

  // ---------------- skills for a running agent ----------------

  function attachSkillsDialog(s) {
    const live = termForSession(s.id);
    const card = openModal(`
      <h2>Скиллы для «${esc(nameOf(s))}»</h2>
      <p class="muted">${live
        ? 'Агент открыт здесь: сообщение с просьбой загрузить скиллы уйдёт прямо в его терминал. Если он сейчас занят, Claude Code поставит его в очередь.'
        : 'Агент запущен вне приложения. Можно открыть его здесь (продолжить сессию) или скопировать сообщение и вставить в его окно самому.'}</p>
      <div id="as-skills"></div>
      <div class="modal-actions">
        <button class="btn" data-close>Отмена</button>
        ${live ? '' : '<button class="btn" id="as-copy" disabled>Скопировать сообщение</button>'}
        <button class="btn primary" id="as-go" disabled>${live ? 'Подключить' : 'Открыть здесь и подключить'}</button>
      </div>`);
    const picker = skillPicker(card.querySelector('#as-skills'), { exclude: s.skills });
    picker.load(s.cwd);
    card.querySelector('#as-skills').addEventListener('change', () => {
      const none = !picker.selected().length;
      card.querySelector('#as-go').disabled = none;
      const cp = card.querySelector('#as-copy');
      if (cp) cp.disabled = none;
    });
    card.querySelector('[data-close]').addEventListener('click', closeModal);

    const remember = async (skills) => { s.skills = await window.api.attachSkills(s.id, skills); render(); };
    card.querySelector('#as-copy')?.addEventListener('click', async () => {
      const skills = picker.selected();
      await navigator.clipboard.writeText(await window.api.skillsMessage(skills));
      await remember(skills);
      closeModal();
      toast('Сообщение скопировано — вставь его в окно агента');
    });
    card.querySelector('#as-go').addEventListener('click', async () => {
      const skills = picker.selected();
      const msg = await window.api.skillsMessage(skills);
      if (live) {
        sendToTerminal(live, msg);
        $('#drawer').classList.remove('collapsed');
        activate(live);
      } else {
        if ((s.state === 'working' || s.state === 'waiting') &&
            !confirm('Эта сессия сейчас активна в другом окне. Открыть её копию здесь всё равно?')) return;
        await openTerminal({ cwd: s.cwd, resumeId: s.id, label: nameOf(s), prompt: msg });
      }
      await remember(skills);
      closeModal();
    });
  }

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---------------- terminals ----------------

  const terms = new Map(); // termId -> { term, fit, el, tab, sessionId, exited }
  let active = null;

  function termForSession(sessionId) {
    for (const [id, t] of terms) if (t.sessionId === sessionId && !t.exited) return id;
    return null;
  }

  // type a message into Claude Code's prompt and submit it (Enter goes separately,
  // otherwise the TUI treats the whole chunk as a paste and only inserts a newline)
  function sendToTerminal(id, text) {
    window.api.termWrite(id, text.replace(/\r?\n/g, ' '));
    setTimeout(() => window.api.termWrite(id, '\r'), 250);
  }

  async function openTerminal({ cwd, resumeId, name, skills, prompt, label, onError }) {
    $('#drawer').classList.remove('collapsed');
    const el = document.createElement('div');
    el.className = 'term';
    $('#terms').appendChild(el);
    const term = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { background: '#120f1a', foreground: '#ece7f6', cursor: '#d97757', selectionBackground: '#4a4166' },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    el.classList.add('active');
    fit.fit();

    let id, sessionId;
    try {
      ({ termId: id, sessionId } = await window.api.termOpen({ cwd, resumeId, name, skills, prompt, cols: term.cols, rows: term.rows }));
    } catch (e) {
      el.remove();
      term.dispose();
      if (!terms.size) $('#drawer').classList.add('collapsed');
      if (onError) onError(errText(e)); else alert(errText(e));
      return false;
    }
    term.onData((d) => window.api.termWrite(id, d));
    term.onResize(({ cols, rows }) => window.api.termResize(id, cols, rows));
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.ctrlKey && ev.key === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); return false; }
      if (ev.ctrlKey && ev.key === 'v') { navigator.clipboard.readText().then((t) => window.api.termWrite(id, t)); return false; }
      return true;
    });

    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.innerHTML = `<span>${esc(label)}</span><span class="x" title="Закрыть">✕</span>`;
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) closeTerminal(id);
      else activate(id);
    });
    $('#tabs .none')?.remove();
    $('#tabs').appendChild(tab);
    terms.set(id, { term, fit, el, tab, sessionId, exited: false });
    activate(id);
    if (!resumeId) selected = sessionId; // the new character gets selected once it shows up
    Office.select(selected);
    return true;
  }

  function activate(id) {
    active = id;
    for (const [k, t] of terms) {
      t.el.classList.toggle('active', k === id);
      t.tab.classList.toggle('active', k === id);
    }
    fitActive();
    terms.get(id)?.term.focus();
  }

  function closeTerminal(id) {
    const t = terms.get(id);
    if (!t) return;
    window.api.termKill(id);
    t.term.dispose();
    t.el.remove();
    t.tab.remove();
    terms.delete(id);
    if (active === id) {
      const next = [...terms.keys()].pop();
      if (next) activate(next);
      else {
        active = null;
        $('#tabs').innerHTML = '<span class="muted none">Нет открытых терминалов</span>';
        $('#drawer').classList.add('collapsed');
      }
    }
    render();
  }

  function fitActive() {
    requestAnimationFrame(() => {
      const t = active && terms.get(active);
      if (t) { try { t.fit.fit(); } catch { /* hidden */ } }
    });
  }

  window.api.onTermData((id, data) => terms.get(id)?.term.write(data));
  window.api.onTermExit((id) => {
    const t = terms.get(id);
    if (!t) return;
    t.exited = true;
    t.tab.classList.add('exited');
    t.term.write('\r\n\x1b[90m[сессия завершена — закрой вкладку]\x1b[0m\r\n');
    render();
  });
  window.addEventListener('resize', fitActive);

  tick();
})();
