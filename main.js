const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('@lydell/node-pty');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// written by ~/.claude/office-notify.js (a Notification hook): Claude Code's own "I'm asking the user" signal
const EVENTS_DIR = path.join(os.homedir(), '.claude', 'office-events');
// tools that by definition wait for the user, whatever the permission mode
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
// modes in which Claude Code never stops to ask for a tool permission
const NO_PROMPT_MODES = new Set(['auto', 'bypassPermissions']);
const STALE_TOOL_SECS = 30 * 60; // a tool "running" this long without a trace was most likely interrupted
const VISIBLE_HOURS = 24;     // sessions touched within this window get a character
const TAIL_BYTES = 96 * 1024; // how much of the end of a transcript to parse for state
const HEAD_BYTES = 256 * 1024;

let win;
const sessions = new Map(); // id -> { file, mtime, size, info }

// user-given character names live in the app's own settings, transcripts stay untouched
let names = {};
// sessions removed from the office: id -> time of removal; they come back on new activity
let hidden = {};
let hiddenNow = 0; // how many hidden sessions the last scan skipped
// agents sent to rest: id -> transcript mtime at that moment; any newer activity wakes them up
let rested = {};
// skills attached from the app: id -> [skill ids]
let attached = {};
// skills the user starred: shown in the "Личные" group of the picker
const DEFAULT_PINNED = ['plbx-playables-skills:plbx-playables', 'plbx-playables-skills:playable-dev-workflow'];
let pinned = DEFAULT_PINNED;
const store = (file) => path.join(app.getPath('userData'), file);
function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(store(file), 'utf8')); } catch { return {}; }
}
function saveJson(file, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(store(file), JSON.stringify(data, null, 2));
}
function loadNames() {
  names = loadJson('names.json');
  hidden = loadJson('hidden.json');
  rested = loadJson('rested.json');
  attached = loadJson('skills.json');
  const p = loadJson('pinned.json');
  pinned = Array.isArray(p.skills) ? p.skills : DEFAULT_PINNED;
}
function setName(id, name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (clean) names[id] = clean; else delete names[id];
  saveJson('names.json', names);
  return clean || null;
}
const ptys = new Map();     // termId -> pty

const ICON = path.join(__dirname, 'build', 'icon.png');

function createWindow(show = true) {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show,
    backgroundColor: '#1b1726',
    title: 'Claude Office',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // closing the window only hides it: scanning, notifications, the widget and the agents
  // running in the built-in terminals all keep going; quit from the tray menu
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!settings.hintShown && tray) {
      settings.hintShown = true;
      saveSettings();
      tray.displayBalloon({
        iconType: 'info',
        title: 'Claude Office работает в фоне',
        content: 'Агенты продолжают работать. Открыть офис или выйти — через значок в трее.',
      });
    }
  });

  // dev aid: OFFICE_SNAPSHOT=out.png saves a screenshot after a few seconds and quits
  if (process.env.OFFICE_SNAPSHOT) {
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[renderer]', msg));
    if (process.env.OFFICE_SIZE) win.setSize(...process.env.OFFICE_SIZE.split('x').map(Number));
    if (process.env.OFFICE_SNAPSHOT_JS) {
      setTimeout(() => win.webContents.executeJavaScript(process.env.OFFICE_SNAPSHOT_JS).catch((e) => console.log('js error', e)), 3000);
    }
    if (process.env.OFFICE_TEST_HIDE) {
      setTimeout(() => {
        win.close();
        setTimeout(() => console.log(`[test] after close: destroyed=${win.isDestroyed()} visible=${win.isVisible()} tray=${!!tray}`), 300);
      }, 4000);
    }
    setTimeout(async () => {
      const shot = async (w, file) => {
        try { fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG()); } catch (e) { console.log('[test] capture failed', e.message); }
      };
      if (widget && process.env.OFFICE_SNAPSHOT_WIDGET) await shot(widget, process.env.OFFICE_SNAPSHOT_WIDGET);
      if (!process.env.OFFICE_TEST_HIDE) await shot(win, process.env.OFFICE_SNAPSHOT);
      app.quit();
    }, Number(process.env.OFFICE_SNAPSHOT_DELAY) || 6000);
  }
}

// ---------- transcript parsing ----------

function readRange(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text, dropFirst) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift(); // probably cut in the middle
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial line */ }
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  }
  return '';
}

function isHumanPrompt(e) {
  if (e.type !== 'user' || e.isSidechain || e.isMeta) return false;
  const c = e.message && e.message.content;
  if (Array.isArray(c) && c.some((x) => x && x.type === 'tool_result')) return false;
  const t = textOf(c).trim();
  if (!t) return false;
  // harness-injected messages (<bash-stdout>, <task-notification>, <command-name>…) aren't the user talking
  if (/^<[a-z][\w-]*>/.test(t) || t.startsWith('Caveat:')) return false;
  if (t.startsWith('[Request interrupted')) return false;
  return true;
}

function summarizeTool(tu) {
  const i = tu.input || {};
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (tu.name) {
    case 'Read': return `Читает ${base(i.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Правит ${base(i.file_path)}`;
    case 'Write': return `Пишет ${base(i.file_path)}`;
    case 'Bash': case 'PowerShell': return `$ ${String(i.command || '').split('\n')[0].slice(0, 60)}`;
    case 'Grep': return `Ищет «${String(i.pattern || '').slice(0, 30)}»`;
    case 'Glob': return `Ищет файлы ${String(i.pattern || '').slice(0, 30)}`;
    case 'WebFetch': case 'WebSearch': return 'Гуглит';
    case 'Agent': case 'Task': return `Субагент: ${String(i.description || '').slice(0, 40)}`;
    case 'TodoWrite': return 'Планирует';
    default: return tu.name;
  }
}

function readHeadInfo(file) {
  const stat = fs.statSync(file);
  const entries = parseLines(readRange(file, 0, Math.min(stat.size, HEAD_BYTES)), false);
  let cwd = null, title = null;
  for (const e of entries) {
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!title && isHumanPrompt(e)) title = textOf(e.message.content).trim().split('\n')[0];
    if (cwd && title) break;
  }
  return { cwd, title };
}

// the latest permission prompt / question Claude Code raised for this session, if the hook is installed
function pendingAsk(id) {
  try {
    const ev = JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, `${id}.json`), 'utf8'));
    const kind = ev.notification_type || '';
    const asks = kind === 'permission_prompt' || kind === 'elicitation_dialog' ||
      (!kind && /permission|разрешени/i.test(ev.message || ''));
    return asks ? ev : null;
  } catch { return null; }
}
const hookInstalled = () => fs.existsSync(path.join(os.homedir(), '.claude', 'office-notify.js'));

// subagents write their own transcripts next to the session; they count as the session being busy
function sidecarMtime(file) {
  const dir = path.join(file.slice(0, -6), 'subagents');
  let latest = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { latest = Math.max(latest, fs.statSync(path.join(dir, f)).mtimeMs); } catch { }
    }
  } catch { }
  return latest;
}

function readTailState(file, size, mtime, id) {
  const start = Math.max(0, size - TAIL_BYTES);
  const entries = parseLines(readRange(file, start, size - start), start > 0);
  let customTitle = null, cwd = null, mode = null;
  let lastText = null, lastPrompt = null;
  let last = null; // last meaningful conversation entry
  for (const e of entries) {
    if (e.type === 'custom-title' && e.customTitle) customTitle = e.customTitle;
    if (e.type === 'summary' && e.summary && !customTitle) customTitle = e.summary;
    if (e.cwd) cwd = e.cwd;
    if (e.permissionMode) mode = e.permissionMode;
    if (e.isSidechain) continue;
    if (e.type === 'assistant' || e.type === 'user') {
      last = e;
      if (e.type === 'assistant') {
        const t = textOf(e.message && e.message.content).trim();
        if (t) lastText = t;
      } else if (isHumanPrompt(e)) {
        lastPrompt = textOf(e.message.content).trim();
      }
    }
  }

  let age = (Date.now() - mtime) / 1000;
  let state = 'idle', activity = null;
  if (last) {
    const content = (last.message && last.message.content) || [];
    const arr = Array.isArray(content) ? content : [];
    if (last.type === 'assistant') {
      const tools = arr.filter((c) => c && c.type === 'tool_use');
      if (tools.length) {
        // a tool was requested and its result isn't in yet
        const tool = tools[tools.length - 1];
        activity = summarizeTool(tool);
        const side = sidecarMtime(file);
        if (side > mtime) age = (Date.now() - side) / 1000;
        const ask = pendingAsk(id);
        if (ASK_TOOLS.has(tool.name)) {
          state = 'waiting';
          activity = tool.name === 'ExitPlanMode' ? 'Ждёт: согласуй план' : 'Ждёт: ответь на вопрос';
        } else if (ask && ask.at >= mtime - 1000) {
          // Claude Code showed a permission prompt after the last thing written to the transcript
          state = 'waiting';
          activity = `Ждёт разрешения: ${activity}`;
        } else if (age > STALE_TOOL_SECS) {
          state = 'done';
          activity = null;
        } else if (!hookInstalled() && !NO_PROMPT_MODES.has(mode) && age > 30) {
          // no hook to tell us: in modes that can prompt, a long silence most likely is a prompt
          state = 'waiting';
          activity = `Ждёт (вероятно): ${activity}`;
        } else {
          state = 'working';
        }
      } else if (last.message && last.message.stop_reason === null && age < 10) {
        state = 'working';
        activity = 'Пишет ответ…';
      } else {
        state = 'done';
      }
    } else {
      // user turn (prompt or tool result) -> Claude is thinking
      state = age < 120 ? 'working' : 'done';
      activity = isHumanPrompt(last) ? 'Думает…' : 'Обдумывает результат…';
      const t = textOf(last.message && last.message.content);
      if (t.startsWith('[Request interrupted')) { state = 'done'; activity = null; }
    }
  }
  if (state === 'done' && age > 10 * 60) state = 'idle';
  if (state === 'idle' && age > 2 * 3600) state = 'sleeping';
  return { state, activity, customTitle, cwd, lastText, lastPrompt, age, mode };
}

function restedState(id, mtime, state) {
  if (!rested[id]) return state;
  if (mtime > rested[id]) { delete rested[id]; saveJson('rested.json', rested); return state; }
  return state === 'done' || state === 'waiting' ? 'idle' : state;
}

function scan() {
  const result = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return result; }
  const cutoff = Date.now() - VISIBLE_HOURS * 3600 * 1000;
  const seen = new Set();
  hiddenNow = 0;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < cutoff || st.size === 0) continue;
      const id = f.slice(0, -6);
      if (hidden[id] && st.mtimeMs <= hidden[id]) { hiddenNow++; continue; }
      seen.add(id);
      let s = sessions.get(id);
      try {
        if (!s) {
          s = { file, mtime: 0, size: 0, head: readHeadInfo(file) };
          sessions.set(id, s);
        }
        if (s.mtime !== st.mtimeMs || s.size !== st.size || !s.tail) {
          s.mtime = st.mtimeMs; s.size = st.size;
          if (!s.head.title) s.head = readHeadInfo(file);
        }
        // state depends on age, so recompute every tick (cheap: reads only the tail)
        s.tail = readTailState(file, st.size, st.mtimeMs, id);
      } catch { continue; }
      if (!s.head.title && !s.tail.lastPrompt) continue; // empty sessions (no prompt yet)
      // the folder the session started in: that's where `claude --resume` finds it
      const cwd = s.head.cwd || s.tail.cwd || '';
      result.push({
        id,
        name: names[id] || null,
        cwd,
        project: cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) || cwd : d.name,
        title: s.tail.customTitle || s.head.title || s.tail.lastPrompt,
        state: restedState(id, st.mtimeMs, s.tail.state),
        rested: !!(rested[id] && st.mtimeMs <= rested[id]),
        skills: attached[id] || [],
        activity: s.tail.activity,
        lastText: s.tail.lastText ? s.tail.lastText.slice(0, 600) : null,
        lastPrompt: s.tail.lastPrompt ? s.tail.lastPrompt.slice(0, 300) : null,
        mtime: st.mtimeMs,
      });
    }
  }
  for (const id of sessions.keys()) if (!seen.has(id)) sessions.delete(id);
  return result;
}

// one scan feeds the office, the widget and the notifications; callers within a short window share it
let last = null, lastAt = 0;
function freshScan() {
  if (!last || Date.now() - lastAt > 700) { last = scan(); lastAt = Date.now(); }
  return last;
}
ipcMain.handle('sessions:scan', () => freshScan());
ipcMain.handle('sessions:rename', (_e, id, name) => setName(id, name));

ipcMain.handle('sessions:hide', (_e, id) => {
  hidden[id] = Date.now();
  saveJson('hidden.json', hidden);
});
ipcMain.handle('sessions:unhideAll', () => {
  hidden = {};
  saveJson('hidden.json', hidden);
});
ipcMain.handle('sessions:hiddenCount', () => hiddenNow);
ipcMain.handle('sessions:rest', (_e, ids) => {
  for (const id of ids) {
    const s = sessions.get(id);
    if (s) rested[id] = s.mtime;
  }
  saveJson('rested.json', rested);
});
ipcMain.handle('sessions:attachSkills', (_e, id, skills) => {
  attached[id] = [...new Set([...(attached[id] || []), ...skills])];
  saveJson('skills.json', attached);
  return attached[id];
});

// ---------- skills ----------

function readSkill(file) {
  try {
    const head = readRange(file, 0, 4096);
    const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const field = (k) => {
      const r = m[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'));
      return r ? r[1].trim().replace(/^["']|["']$/g, '') : '';
    };
    return { name: field('name') || path.basename(path.dirname(file)), description: field('description') };
  } catch { return null; }
}

function skillsIn(dir, prefix, source, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const info = readSkill(path.join(dir, e.name, 'SKILL.md'));
    if (!info) continue;
    const id = prefix ? `${prefix}:${e.name}` : e.name;
    if (!out.some((x) => x.id === id)) out.push({ id, source, description: info.description.slice(0, 300) });
  }
}

// the same skills Claude Code itself sees: project, personal, claude.ai-synced, enabled plugins
function listSkills(cwd) {
  const home = path.join(os.homedir(), '.claude');
  const out = [];
  if (cwd) skillsIn(path.join(cwd, '.claude', 'skills'), '', 'Проект', out);
  skillsIn(path.join(home, 'skills'), '', 'Личные', out);
  try {
    for (const b of fs.readdirSync(path.join(home, 'skills', 'synced'))) {
      if (!b.startsWith('.')) skillsIn(path.join(home, 'skills', 'synced', b), 'anthropic-skills', 'Claude.ai', out);
    }
  } catch { }
  let enabled = {};
  try { enabled = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).enabledPlugins || {}; } catch { }
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {};
    for (const [key, list] of Object.entries(installed)) {
      if (enabled[key] === false || !list || !list[0]) continue;
      const plugin = key.split('@')[0];
      skillsIn(path.join(list[0].installPath, 'skills'), plugin, `Плагин ${plugin}`, out);
    }
  } catch { }
  for (const s of out) {
    s.pinned = pinned.includes(s.id);
    if (s.pinned && s.source !== 'Проект') s.source = 'Личные';
  }
  // project first, then personal + starred, then the rest as discovered
  const rank = (s) => (s.source === 'Проект' ? 0 : s.source === 'Личные' ? 1 : 2);
  return out.filter((x) => x.id !== 'synced').sort((a, b) => rank(a) - rank(b));
}

ipcMain.handle('skills:pin', (_e, id, on) => {
  pinned = on ? [...new Set([...pinned, id])] : pinned.filter((x) => x !== id);
  saveJson('pinned.json', { skills: pinned });
});

ipcMain.handle('skills:list', (_e, cwd) => listSkills(cwd));

const skillsPrompt = (skills) =>
  `Пользователь подключил к этой сессии скиллы: ${skills.join(', ')}. ` +
  'Загрузи каждый из них инструментом Skill, прежде чем браться за работу, и следуй их инструкциям.';
ipcMain.handle('skills:message', (_e, skills) =>
  `Подключи скиллы: ${skills.join(', ')}. Загрузи каждый инструментом Skill и используй их в дальнейшей работе.`);

// moves the transcript (and its sidecar folder with subagent logs) to the Windows Recycle Bin
ipcMain.handle('sessions:trash', async (_e, id) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad session id');
  const s = sessions.get(id);
  if (!s) throw new Error('Сессия не найдена');
  await shell.trashItem(s.file);
  const side = s.file.slice(0, -6);
  if (fs.existsSync(side)) await shell.trashItem(side);
  sessions.delete(id);
  delete hidden[id];
  if (names[id]) { delete names[id]; saveJson('names.json', names); }
});

// plan limits, dumped by the user's statusline script (~/.claude/statusline.js)
ipcMain.handle('usage:get', () => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'office-usage.json'), 'utf8')); } catch { return null; }
});

// ---------- terminals ----------

// the native claude.exe, so arguments (names, prompts) go through without cmd.exe quoting
let claudeExe;
function resolveClaude() {
  if (claudeExe !== undefined) return claudeExe;
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
  ];
  try {
    candidates.push(...execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => l.endsWith('.exe')));
  } catch { }
  claudeExe = candidates.find((c) => c && fs.existsSync(c)) || null;
  return claudeExe;
}

ipcMain.handle('term:open', (_e, { cwd, resumeId, name, skills, prompt, cols, rows }) => {
  if (cwd && !fs.existsSync(cwd)) throw new Error(`Папка не найдена: ${cwd}`);
  const sessionId = resumeId || crypto.randomUUID();
  const args = resumeId ? ['--resume', resumeId] : ['--session-id', sessionId];
  if (!resumeId && name) { args.push('-n', name); setName(sessionId, name); }
  if (skills && skills.length) {
    args.push('--append-system-prompt', skillsPrompt(skills));
    attached[sessionId] = [...new Set([...(attached[sessionId] || []), ...skills])];
    saveJson('skills.json', attached);
  }
  if (prompt) args.push(prompt);
  // if the app itself was started from inside a Claude Code session, its markers would make the
  // agent think it is a child session (no transcript saved -> no character in the office)
  const env = { ...process.env, FORCE_COLOR: '1' };
  for (const k of Object.keys(env)) if (/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(k)) delete env[k];
  const opts = {
    name: 'xterm-256color',
    cols: cols || 100,
    rows: rows || 30,
    cwd: cwd || os.homedir(),
    env,
  };
  const exe = resolveClaude();
  const p = exe
    ? pty.spawn(exe, args, opts)
    : pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'claude', ...args], opts);
  const termId = `t${p.pid}_${Date.now()}`;
  ptys.set(termId, p);
  p.onData((data) => win && !win.isDestroyed() && win.webContents.send('term:data', termId, data));
  p.onExit(({ exitCode }) => {
    ptys.delete(termId);
    if (win && !win.isDestroyed()) win.webContents.send('term:exit', termId, exitCode);
  });
  return { termId, sessionId };
});

ipcMain.on('term:write', (_e, id, data) => { const p = ptys.get(id); if (p) p.write(data); });
ipcMain.on('term:resize', (_e, id, cols, rows) => {
  const p = ptys.get(id);
  if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch { /* exited */ } }
});
ipcMain.on('term:kill', (_e, id) => { const p = ptys.get(id); if (p) { try { p.kill(); } catch { } ptys.delete(id); } });

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.on('shell:open', (_e, p) => { if (p && fs.existsSync(p)) shell.openPath(p); });

// ---------- background: tray, desktop widget, notifications ----------

let tray = null;
let widget = null;
let quitting = false;
let settings = {};
const prevState = new Map(); // id -> last seen state, to notice transitions
const saveSettings = () => saveJson('settings.json', settings);

function showMain(selectId) {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (selectId) win.webContents.send('app:select', selectId);
}

function notifyChanges(list) {
  const officeInView = win && !win.isDestroyed() && win.isVisible() && win.isFocused();
  for (const s of list) {
    const prev = prevState.get(s.id);
    prevState.set(s.id, s.state);
    if (!prev || prev === s.state || officeInView || settings.notify === false || !Notification.isSupported()) continue;
    let title = null;
    if (s.state === 'waiting') title = `${s.name || s.project} — ждёт тебя`;
    else if (s.state === 'done' && prev === 'working') title = `${s.name || s.project} — готово`;
    if (!title) continue;
    const body = s.state === 'waiting' ? (s.activity || 'Нужно твоё решение') : (s.lastText || s.title || '').slice(0, 140);
    const n = new Notification({ title, body, icon: ICON, silent: false });
    n.on('click', () => showMain(s.id));
    n.show();
  }
}

function refresh() {
  try {
    lastAt = 0;
    const list = freshScan();
    notifyChanges(list);
    if (widget && !widget.isDestroyed()) widget.webContents.send('sessions:update', list);
    if (tray) {
      const c = (st) => list.filter((s) => s.state === st).length;
      const parts = [];
      if (c('working')) parts.push(`работают: ${c('working')}`);
      if (c('waiting')) parts.push(`ждут тебя: ${c('waiting')}`);
      if (c('done')) parts.push(`готово: ${c('done')}`);
      tray.setToolTip(`Claude Office${parts.length ? '\n' + parts.join(', ') : ''}`);
    }
  } catch (e) {
    console.error(e);
  }
}

function widgetBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const def = { width: 300, height: 380, x: wa.x + wa.width - 320, y: wa.y + wa.height - 400 };
  const b = settings.widgetBounds;
  if (!b) return def;
  // monitor layout may have changed since: keep it only if it still lands on a screen
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    b.x + 40 > a.x && b.x < a.x + a.width - 40 && b.y >= a.y - 10 && b.y < a.y + a.height - 40);
  return onScreen ? b : def;
}

function createWidget() {
  if (widget && !widget.isDestroyed()) { widget.showInactive(); return; }
  widget = new BrowserWindow({
    ...widgetBounds(),
    minWidth: 230,
    minHeight: 150,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: settings.widgetOnTop !== false,
    show: false,
    title: 'Claude Office — виджет',
    backgroundColor: '#1b1726',
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  widget.loadFile(path.join(__dirname, 'renderer', 'widget.html'));
  widget.once('ready-to-show', () => widget.showInactive());
  let t;
  const remember = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (!widget || widget.isDestroyed()) return;
      settings.widgetBounds = widget.getBounds();
      saveSettings();
    }, 300);
  };
  widget.on('moved', remember);
  widget.on('resized', remember);
  widget.on('closed', () => { widget = null; });
}

function setWidget(on) {
  settings.widget = !!on;
  saveSettings();
  if (on) createWidget();
  else if (widget && !widget.isDestroyed()) widget.close();
  buildTrayMenu();
  if (win && !win.isDestroyed()) win.webContents.send('widget:state', !!on);
}

// a portable build runs from a temp copy; Windows must start the original .exe
const exePath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const loginOpts = () => ({ path: exePath(), args: ['--background'] });
const loginEnabled = () => app.isPackaged && app.getLoginItemSettings(loginOpts()).openAtLogin;

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть офис', click: () => showMain() },
    { type: 'separator' },
    { label: 'Виджет на рабочем столе', type: 'checkbox', checked: !!settings.widget, click: (i) => setWidget(i.checked) },
    {
      label: 'Виджет поверх окон', type: 'checkbox', checked: settings.widgetOnTop !== false,
      click: (i) => {
        settings.widgetOnTop = i.checked;
        saveSettings();
        if (widget && !widget.isDestroyed()) widget.setAlwaysOnTop(i.checked);
      },
    },
    {
      label: 'Уведомления', type: 'checkbox', checked: settings.notify !== false,
      click: (i) => { settings.notify = i.checked; saveSettings(); },
    },
    {
      label: 'Запускать вместе с Windows', type: 'checkbox', checked: loginEnabled(), enabled: app.isPackaged,
      click: (i) => { app.setLoginItemSettings({ ...loginOpts(), openAtLogin: i.checked }); buildTrayMenu(); },
    },
    { type: 'separator' },
    { label: 'Выйти (остановит агентов в терминалах приложения)', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Claude Office');
  tray.on('click', () => showMain());
  buildTrayMenu();
}

ipcMain.on('app:showMain', (_e, id) => showMain(id));
ipcMain.on('widget:set', (_e, on) => setWidget(on));
ipcMain.handle('widget:get', () => !!settings.widget);

const testRun = !!process.env.OFFICE_SNAPSHOT;
if (!testRun && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(() => {
    app.setAppUserModelId('ai.plbx.claude-office');
    loadNames();
    settings = loadJson('settings.json');
    createTray();
    createWindow(!process.argv.includes('--background'));
    if (settings.widget || process.env.OFFICE_WIDGET) createWidget();
    refresh();
    setInterval(refresh, 1500);
  });
}
app.on('before-quit', () => {
  quitting = true;
  for (const p of ptys.values()) { try { p.kill(); } catch { } }
});
// all windows hidden/closed: keep living in the tray
app.on('window-all-closed', () => { });
