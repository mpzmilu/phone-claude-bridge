import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, 'config.json');
// 首次运行：没有 config.json 时从示例复制一份，避免把真实配置提交进版本库
if (!fs.existsSync(CONFIG_PATH)) {
  const example = path.join(ROOT, 'config.example.json');
  if (fs.existsSync(example)) fs.copyFileSync(example, CONFIG_PATH);
}
const CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const CLAUDE_EXE = CFG.claudePath || path.join(APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const DWS_JS = CFG.dwsPath || path.join(APPDATA, 'npm', 'node_modules', 'dingtalk-workspace-cli', 'bin', 'dws.js');

const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const WORK_DIR = CFG.workDir && String(CFG.workDir).trim() ? CFG.workDir : (process.env.USERPROFILE || os.homedir());
const STATE_FILE = path.join(ROOT, 'state.json');
const HISTORY_FILE = path.join(ROOT, 'history.json');
const LOG_FILE = path.join(ROOT, 'bridge.log');
const PID_FILE = path.join(ROOT, 'server.pid');

try {
  const st = fs.statSync(LOG_FILE);
  if (st.size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
} catch {}

function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.log(line);
}

let state = { sessionId: null };
try { if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}

let history = [];
try { if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}

// 桌面端会把 CLI 指向它自己的本地代理并清空 token，直接继承会得到 "Not logged in"。
// 这里剔除宿主注入的 CLAUDE_*/ANTHROPIC_* 变量，改为从 ~/.claude/settings.json 取凭据。
function buildChildEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC)/i.test(k)) continue;
    env[k] = v;
  }
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    for (const [k, v] of Object.entries(s.env || {})) env[k] = String(v);
  } catch (e) {
    log('settings env read failed', e.message);
  }
  if (CFG.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = CFG.anthropicBaseUrl;
  if (CFG.anthropicAuthToken) env.ANTHROPIC_AUTH_TOKEN = CFG.anthropicAuthToken;
  // Bash 工具在 Windows 上需要 Git Bash 路径，这条不是凭据，保留
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) env.CLAUDE_CODE_GIT_BASH_PATH = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  return env;
}
const CHILD_ENV = buildChildEnv();

function saveState() {  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { log('saveState failed', e.message); }
}
function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); } catch (e) { log('saveHistory failed', e.message); }
}
function addHistory(role, text, source) {
  history.push({ role, text, source, ts: Date.now() });
  if (history.length > 200) history = history.slice(-200);
  saveHistory();
}

let chain = Promise.resolve();
let busy = false;

// 网关的自定义模型名 CLI 不认识，每次都会往 stderr 打一行 unrecognized_model。
// 它只在子进程 stderr 里，本来就不会进 bridge.log；这里再滤一遍，避免它混进错误信息。
function cleanStderr(s) {
  return String(s || '')
    .split(/\r?\n/)
    .filter(l => !/^\s*\[claude-code:unrecognized_model\]/.test(l))
    .join('\n')
    .trim();
}

function askClaude(question, source) {
  const run = () => new Promise((resolve) => {
    busy = true;
    const mode = CFG.mode === 'full' ? 'full' : 'lite';
    if (state.mode !== mode) {
      state.sessionId = null;
      state.mode = mode;
      saveState();
      log('mode changed, session reset', mode);
    }

    const isNew = !state.sessionId;
    const sid = isNew ? randomUUID() : state.sessionId;
    const seeded = isNew && !!state.pendingSeed;
    const effectiveQuestion = seeded
      ? `以下是之前对话的摘要，请把它当作背景：\n${state.pendingSeed}\n\n---\n\n${question}`
      : question;
    const args = [
      '-p', effectiveQuestion,
      '--output-format', 'json',
      '--strict-mcp-config',
      '--mcp-config', path.join(ROOT, 'empty-mcp.json'),
    ];
    if (mode === 'lite') {
      // 极简：不加载技能、不提供任何工具，输入从 6.9 万 token 降到几百
      args.push('--bare', '--disable-slash-commands', '--tools', '');
      if (CFG.liteSystemPrompt) args.push('--system-prompt', CFG.liteSystemPrompt);
    } else {
      if (CFG.permissionMode) args.push('--permission-mode', CFG.permissionMode);
      if (CFG.allowedTools) args.push('--allowedTools', CFG.allowedTools);
      if (CFG.disallowedTools) args.push('--disallowedTools', CFG.disallowedTools);
      if (CFG.systemPrompt) args.push('--append-system-prompt', CFG.systemPrompt);
    }
    if (CFG.model) args.push('--model', CFG.model);
    if (isNew) args.push('--session-id', sid);
    else args.push('--resume', sid);

    const env = CHILD_ENV;

    log('ask', source, question.slice(0, 120));
    const started = Date.now();
    // stdio 首项给 ignore：CLI 2.1.3xx 起会等 stdin 3 秒才继续，关掉可省掉这段延迟
    const p = spawn(CLAUDE_EXE, args, { cwd: WORK_DIR, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { p.kill(); } catch {}
    }, (CFG.timeoutSec || 180) * 1000);

    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.stderr.on('data', d => { err += d.toString('utf8'); });
    p.on('error', e => {
      clearTimeout(timer);
      busy = false;
      log('spawn error', e.message);
      resolve({ ok: false, answer: `无法启动 Claude：${e.message}` });
    });
    p.on('close', code => {
      clearTimeout(timer);
      busy = false;
      let answer = '';
      let newSid = sid;
      let cost = null;
      let inTok = null;
      const lines = out.trim().split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          answer = obj.result ?? obj.error ?? '';
          if (obj.session_id) newSid = obj.session_id;
          if (typeof obj.total_cost_usd === 'number') cost = obj.total_cost_usd;
          if (obj.usage && typeof obj.usage.input_tokens === 'number') inTok = obj.usage.input_tokens;
          if (obj.is_error && !answer) answer = 'Claude 返回了错误';
          break;
        } catch {}
      }
      if (!answer) answer = cleanStderr(err) || (timedOut ? `超时（${CFG.timeoutSec} 秒）` : `进程退出码 ${code}，没有输出`);
      if (code === 0 && newSid) {
        state.sessionId = newSid;
        if (seeded) delete state.pendingSeed;
        saveState();
      }
      log('done', `${Date.now() - started}ms`, `code=${code}`, `chars=${answer.length}`,
        `in=${inTok ?? '?'}`, `cost=${cost == null ? '?' : '$' + cost.toFixed(5)}`);
      resolve({ ok: code === 0, answer });
    });
  });

  const task = chain.then(run, run);
  chain = task.catch(() => {});
  return task;
}

function summarizeHistory() {
  const transcript = history
    .filter(m => m.role === 'user' || (m.role === 'assistant' && m.source !== 'system'))
    .slice(-40)
    .map(m => (m.role === 'user' ? '用户：' : '助手：') + String(m.text).slice(0, 1000))
    .join('\n');

  return new Promise(resolve => {
    const prompt = '把下面这段对话压缩成不超过 400 字的要点，保留结论、决定、待办和关键细节，供后续继续对话使用。只输出摘要本身。\n\n' + transcript;
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--bare', '--disable-slash-commands', '--tools', '',
      '--strict-mcp-config', '--mcp-config', path.join(ROOT, 'empty-mcp.json'),
      '--system-prompt', '你是一个对话摘要器，只输出摘要。',
    ];
    const p = spawn(CLAUDE_EXE, args, { cwd: WORK_DIR, env: CHILD_ENV, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, 120000);
    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.stderr.on('data', d => { err += d.toString('utf8'); });
    p.on('error', e => { clearTimeout(timer); resolve({ ok: false, text: e.message }); });
    p.on('close', code => {
      clearTimeout(timer);
      let text = '';
      const lines = out.trim().split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const obj = JSON.parse(lines[i]); text = obj.result || ''; break; } catch {}
      }
      if (!text) text = cleanStderr(err);
      resolve({ ok: code === 0, text });
    });
  });
}

async function askAndRecord(question, source) {
  // 控制命令：不调用模型，直接重置会话
  if (/^\/(clear|new|reset)\s*$/i.test(question)) {
    state.sessionId = null;
    delete state.pendingSeed;
    saveState();
    history = [];
    saveHistory();
    const msg = '已清空上下文，下一条问题开始新会话。';
    addHistory('assistant', msg, 'system');
    log('session cleared', source);
    return msg;
  }

  if (/^\/compact\s*$/i.test(question)) {
    if (!history.length) return '当前没有对话可压缩。';
    const r = await summarizeHistory();
    if (!r.ok || !r.text) return '压缩失败：' + String(r.text || '没有输出').slice(0, 200);
    const summary = r.text.slice(0, 2000);
    state.sessionId = null;
    state.pendingSeed = summary;
    saveState();
    history = [];
    saveHistory();
    addHistory('assistant', '已压缩。摘要：\n' + summary, 'system');
    log('session compacted', source, `summary=${summary.length}`);
    return '已压缩，摘要已保留，下一条问题会带着它继续。';
  }

  addHistory('user', question, source);
  const r = await askClaude(question, source);
  const answer = (r.answer || '(空)').slice(0, CFG.maxAnswerChars || 6000);
  addHistory('assistant', answer, source);
  return answer;
}

const seen = new Set();
const recentReplies = [];

function rememberReply(text) {
  const t = String(text || '').trim();
  if (!t) return;
  recentReplies.push({ t, ts: Date.now() });
  if (recentReplies.length > 20) recentReplies.shift();
}

// 防回环：万一桥自己发出去的回复也被当成 at-me 事件收回来，直接丢掉。
function isOwnEcho(content) {
  const c = String(content || '').trim();
  if (!c) return false;
  const now = Date.now();
  return recentReplies.some(r => now - r.ts < 180000 && (c === r.t || (r.t.length > 20 && c.includes(r.t.slice(0, 120)))));
}

let stopping = false;
let dingProc = null;

function stripMentions(s) {
  return String(s || '').replace(/^(\s*@[^\s@]+\s*)+/, '').trim();
}

function runDws(args) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d.toString('utf8'); });
    p.on('error', e => resolve({ code: -1, err: e.message }));
    p.on('close', c => resolve({ code: c, err }));
  });
}

async function sendDing(conversationId, text, sender) {
  const body = String(text || '').slice(0, 4000) || '(空)';
  rememberReply(body);
  const base = [DWS_JS, 'chat', '+messages-send', '--as', 'user', '--text', body, '-y'];

  if (conversationId) {
    const groupArgs = [...base, '--chat-id', conversationId];
    const r = await runDws(groupArgs);
    if (r.code === 0) return;
    log('dingtalk group send failed', r.code, r.err.trim().slice(0, 200));
  }

  if (sender) {
    const r = await runDws([...base, '--open-dingtalk-id', sender]);
    if (r.code === 0) return;
    log('dingtalk dm send failed', r.code, r.err.trim().slice(0, 200));
  }
}

const OK_EVENT_TYPES = new Set([
  'user_im_message_receive_at',
  'user_im_message_receive_o2o_all',
  'user_im_message_receive_user',
]);

function handleDingLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { log('[dws]', line.slice(0, 200)); return; }
  if (!OK_EVENT_TYPES.has(ev.type)) return;
  if (ev.event_id) {
    if (seen.has(ev.event_id)) return;
    seen.add(ev.event_id);
    if (seen.size > 500) seen.clear();
  }
  const sender = ev.sender_open_dingtalk_id || '';
  const allowed = (CFG.dingtalk.allowedSenders || []).filter(Boolean);
  if (allowed.length) {
    if (!allowed.includes(sender)) { log('ignore sender (not in allowlist)', sender); return; }
  } else if (CFG.dingtalk.bindFirstSender !== false) {
    if (!state.ownerOpenId) {
      state.ownerOpenId = sender;
      saveState();
      log('bound owner', sender);
    } else if (state.ownerOpenId !== sender) {
      log('ignore sender (not owner)', sender);
      return;
    }
  }
  const convId = ev.conversation_id || '';
  const allowedConvs = (CFG.dingtalk.allowedConversations || []).filter(Boolean);
  if (allowedConvs.length && !allowedConvs.includes(convId)) {
    log('ignore conversation', convId.slice(0, 16));
    return;
  }

  const q = stripMentions(ev.content);
  if (!q) return;
  if (isOwnEcho(q)) { log('skip own echo', q.slice(0, 40)); return; }
  const conv = ev.conversation_id;
  log('dingtalk question', sender, q.slice(0, 80));
  (async () => {
    if (CFG.dingtalk.ack) await sendDing(conv, '收到，正在处理…', sender);
    const answer = await askAndRecord(q, 'dingtalk');
    await sendDing(conv, answer, sender);
  })().catch(e => log('dingtalk handle error', e.message));
}

function startDingtalk() {
  if (!CFG.dingtalk || !CFG.dingtalk.enabled) return;
  if (!fs.existsSync(DWS_JS)) { log('dingtalk skipped: dws.js not found'); return; }
  const args = [DWS_JS, 'event', '+listen-im', '--kind', CFG.dingtalk.kind || 'at-me', '-f', 'ndjson'];
  log('dingtalk listener starting');
  dingProc = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
  let buf = '';
  dingProc.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handleDingLine(line);
    }
  });
  dingProc.stderr.on('data', d => log('[dws]', d.toString('utf8').trim().slice(0, 300)));
  dingProc.on('error', e => log('dingtalk spawn error', e.message));
  dingProc.on('close', code => {
    dingProc = null;
    log('dingtalk listener exited', code);
    if (!stopping) setTimeout(startDingtalk, 15000);
  });
}

function authed(req, url) {
  const t = url.searchParams.get('t') || req.headers['x-token'];
  return !!t && t === CFG.token;
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('index.html missing');
    }
    return;
  }

  if (url.pathname === '/api/ping') {
    send(200, { ok: true, busy, service: 'phone-claude-bridge', port: CFG.port });
    return;
  }

  if (!authed(req, url)) { send(401, { ok: false, error: 'token' }); return; }

  if (url.pathname === '/api/state') {
    send(200, { ok: true, busy, history, workDir: WORK_DIR });
    return;
  }

  if (url.pathname === '/api/ask' && req.method === 'POST') {
    const body = await readBody(req);
    const q = String(body.q || '').trim();
    if (!q) { send(400, { ok: false, error: 'empty' }); return; }
    const answer = await askAndRecord(q, 'web');
    send(200, { ok: true, answer });
    return;
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    state.sessionId = null;
    delete state.pendingSeed;
    saveState();
    history = [];
    saveHistory();
    send(200, { ok: true });
    return;
  }

  send(404, { ok: false, error: 'not found' });
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 0;

server.on('error', e => {
  log('server error', e.code || e.message);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100);
});

function lanIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) out.push(ni.address);
    }
  }
  return out;
}

try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}

if (CFG.webEnabled === true) {
  server.listen(CFG.port, '0.0.0.0', () => {
    log('web listening', `port=${CFG.port}`, `workDir=${WORK_DIR}`);
    for (const ip of lanIPs()) log('url', `http://${ip}:${CFG.port}/?t=${CFG.token}`);
  });
} else {
  log('web channel disabled, DingTalk only', `workDir=${WORK_DIR}`);
}
startDingtalk();

function shutdown(sig) {
  log('shutdown', sig);
  stopping = true;
  try { if (dingProc) dingProc.kill(); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
