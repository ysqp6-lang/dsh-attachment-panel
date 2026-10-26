/**
 * dsh-attachment-panel — 宿主半边
 *
 * 只做一件事：把「主人投送给 DSH 的图片/文件」列出来，给页面和侧栏面板看。
 *
 * 数据从哪来：
 *   ~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd   多帧 zstd 会话日志
 *     - 第 1 帧第 1 行 = header（cwd / createdAt）
 *     - session/title 事件 = 会话标题
 *     - user/message 里的 image / file 内容块 = 主人投送的附件（含原名、mediaType、字节数）
 *     - tool/result 里的同类内容块 = 工具产出/读取的图片（可单独筛出来看）
 *   ~/.dsh/attachments/v1/objects/<sha256 前2位>/<sha256>   附件实体（内容寻址，原名只存在日志里）
 *
 * 路由（注册为 webServer 前缀 /dsh-ap）：
 *   GET  /dsh-ap                 面板页面（也能直接在浏览器打开）
 *   GET  /dsh-ap/api/index       索引 JSON（？scope=user|tool|all&refresh=1）
 *   GET  /dsh-ap/api/thumb/<hash>缩略图（sips 生成，缓存到 attachments/v1/thumbs）
 *   GET  /dsh-ap/api/raw/<hash>  原文件
 *   POST /dsh-ap/api/reveal      { id } → 在 Finder 里显示
 *
 * 全程 fail-open：任何异常只影响本面板，不碰 DSH 本体。
 */
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

const PKG = 'dsh-attachment-panel';
const ROUTE = '/dsh-ap';
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const SESSIONS_DIR = join(DSH_HOME, 'sessions');
const ATTACH_DIR = join(DSH_HOME, 'attachments', 'v1');
const OBJECTS_DIR = join(ATTACH_DIR, 'objects');
const THUMBS_DIR = process.env.DSH_AP_THUMBS ?? join(ATTACH_DIR, 'thumbs');
const CACHE_FILE = process.env.DSH_AP_CACHE ?? join(ATTACH_DIR, 'panel-index.json');
const THUMB_WIDTHS = new Set([192, 320, 480, 768]);
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

/** tailscale 可执行文件：环境变量优先，其次按平台候选探测，最后回落到 PATH 里的 tailscale。 */
function findTailscaleBin() {
  const fromEnv = process.env.DSH_TAILDROP_TAILSCALE;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  const candidates = IS_MAC
    ? [
        '/usr/local/bin/tailscale',
        '/opt/homebrew/bin/tailscale',
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      ]
    : IS_WIN
      ? ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']
      : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/bin/tailscale'];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return 'tailscale';
}

/** 用系统默认程序打开 / 在文件管理器里定位。非 macOS 返回 null 表示不支持。 */
const OPENER = IS_MAC
  ? { reveal: (path) => ['-R', path], open: (path) => [path], bin: '/usr/bin/open' }
  : IS_WIN
    ? { reveal: (path) => ['/select,', path], open: (path) => [path], bin: 'explorer.exe' }
    : existsSync('/usr/bin/xdg-open')
      ? { reveal: (path) => [dirname(path)], open: (path) => [path], bin: '/usr/bin/xdg-open' }
      : null;

const TAILSCALE_BIN = findTailscaleBin();
const SEND_LOG = join(ATTACH_DIR, 'panel-sends.jsonl');
const SEND_TMP_ROOT = join(tmpdir(), 'dsh-ap-send');
const SEND_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const INCOMING_DIR = IS_MAC
  ? '/Library/Tailscale/incoming-files'
  : IS_WIN
    ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'Tailscale', 'files')
    : '/var/lib/tailscale/files';
const RECEIVE_DIRS = [join(homedir(), 'Downloads')];
const RECEIVE_WINDOW_MS = 14 * 24 * 3600 * 1000;
const RECEIVE_MAX_PER_DIR = 60;
const RECEIVE_TTL_MS = 60 * 1000;

const ZSTD_MAGIC = 0x28b52ffd;
const PANEL_HTML_FILE = new URL('./panel.html', import.meta.url);

/**
 * 面板 HTML 每次请求都按 mtime 读盘：改 panel.html 后刷新页面就生效，不用重启 DSH。
 */
let panelCache = { mtime: -1, html: '' };
function panelHtml() {
  try {
    const st = statSync(PANEL_HTML_FILE);
    if (st.mtimeMs !== panelCache.mtime) {
      panelCache = { mtime: st.mtimeMs, html: readFileSync(PANEL_HTML_FILE, 'utf8') };
    }
    return panelCache.html;
  } catch (error) {
    return '<!doctype html><meta charset="utf-8"><body style="font:14px -apple-system;padding:24px">面板页面读取失败：' + String(error) + '</body>';
  }
}

/* ─────────────────────────── 会话日志解码 ─────────────────────────── */

/** 多帧 zstd：按 magic 扫帧边界后逐帧解（Node 的 zstdDecompressSync 只认单帧）。 */
function decodeZstdFrames(buf) {
  const offsets = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    // 帧头 magic 是 28 B5 2F FD，按大端读出来才是 0x28b52ffd
    if (buf.readUInt32BE(i) === ZSTD_MAGIC) offsets.push(i);
  }
  if (offsets.length === 0) return '';
  const parts = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
    } catch {
      /* 尾部半帧：忽略 */
    }
  }
  return parts.join('');
}

function objectPathOf(attachmentId) {
  const hex = attachmentId.startsWith('sha256:') ? attachmentId.slice(7) : attachmentId;
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return join(OBJECTS_DIR, hex.slice(0, 2), hex);
}

/* ────────────────── 路径引用（@ 投送给 DSH 的文件） ────────────────── */

const PATH_ROOTS = ['/Users/', '/private/', '/tmp/', '/Volumes/', '/opt/', '/var/'];
const PATH_TAIL = /[`"'，。、；：！？）》」』>)\]】」]+$/;
const MENTION_QUOTED = /@"([^"\n]{1,2048})"/g;
const MENTION_BARE = /(?<![@\w])@(\/(?:[^\s"'`，。、；：！？（）【】「」『』《》〈〉<>|])+)/g;

/** 归一化一个候选路径；不像本机绝对路径就返回 null。 */
function normalizePath(raw) {
  let p = String(raw).trim();
  p = p.replace(PATH_TAIL, '');
  p = p.replace(/[，。、；：！？]+$/, '');
  if (p.length < 5 || p.length > 2048) return null;
  if (!PATH_ROOTS.some((root) => p.startsWith(root))) return null;
  if (p.includes('\u3000')) return null;
  return p;
}

/** 从一条用户消息里抽出被 @ 提到或直接写出来的本机绝对路径。 */
function extractPaths(text) {
  const out = new Set();
  if (typeof text !== 'string' || !text.includes('/')) return out;
  for (const re of [MENTION_QUOTED, MENTION_BARE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const p = normalizePath(m[1]);
      if (p !== null) out.add(p);
    }
  }
  return out;
}

/* ──────────────── 投送记录（从 tool/call 里的 tailscale file cp 还原） ──────────────── */

/** 重定向/管道残留 token，别当成文件名。 */
const SEND_REDIRECT = /^(?:\d?>|\d?>>|&>|\d?>&|<)/;
const SEND_TARGET = /^[A-Za-z0-9][\w.\-]*:$/;

/**
 * 从一条 shell 命令里抽出真正执行的 `tailscale file cp` 投送。
 * 返回 [{target, name, path}]；--help / --targets 这类不算投送。
 */
function parseSendCommand(command, cwd) {
  const out = [];
  const parts = String(command ?? '').split(/;|&&|\|\||\|/);
  for (const raw of parts) {
    const seg = raw.trim().replace(/^\(\s*/, '');
    if (!seg.startsWith('tailscale file cp')) continue;
    const tokens = seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const args = tokens.slice(3).map((t) => t.replace(/^["']|["']$/g, ''));
    let target = null;
    let nameOverride = null;
    const files = [];
    let bogus = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--targets' || a === '--help' || a === '--verbose' || a === '--update-interval') {
        bogus = true;
        break;
      }
      if (a === '--name') {
        nameOverride = args[i + 1] ?? null;
        i++;
        continue;
      }
      if (a.startsWith('--name=')) {
        nameOverride = a.slice(7);
        continue;
      }
      if (a.startsWith('--') || SEND_REDIRECT.test(a)) continue;
      if (SEND_TARGET.test(a)) {
        target = a.slice(0, -1);
        continue;
      }
      files.push(a);
    }
    if (bogus || target === null || files.length === 0) continue;
    const useOverride = files.length === 1 ? nameOverride : null;
    for (const f of files) {
      const p = f.startsWith('/') ? f : join(cwd ?? '', f);
      out.push({ target, name: useOverride ?? f.split('/').pop(), path: p, command: seg.slice(0, 400) });
    }
  }
  return out;
}

/* ─────────────────────────── 索引构建 ─────────────────────────── */

/** 会话日志清单 + 版本号（任一日志的 size/mtime 变了版本就变）。 */
function logFiles() {
  const out = [];
  let version = 0;
  let wsNames = [];
  try {
    wsNames = readdirSync(SESSIONS_DIR);
  } catch {
    return { files: out, version: 0 };
  }
  for (const ws of wsNames) {
    const wsDir = join(SESSIONS_DIR, ws);
    let wsStat;
    try {
      wsStat = statSync(wsDir);
    } catch {
      continue;
    }
    if (!wsStat.isDirectory()) continue;
    let sessionNames = [];
    try {
      sessionNames = readdirSync(wsDir);
    } catch {
      continue;
    }
    for (const s of sessionNames) {
      const log = join(wsDir, s, 'session.v4.jsonl.zstd');
      let st;
      try {
        st = statSync(log);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      version = (version * 31 + (st.size % 1e9) + Math.floor(st.mtimeMs)) % 2 ** 48;
      out.push({ file: log, ws, sessionId: s, size: st.size, mtime: st.mtimeMs });
    }
  }
  return { files: out, version: version + ':' + out.length };
}

/** 从一批日志里抽出所有附件引用。 */
function buildIndex() {
  const started = Date.now();
  const { files, version } = logFiles();
  const items = [];
  const byHash = new Map();
  const pathRefs = new Map();
  const sendRecords = [];
  let scanned = 0;

  for (const meta of files) {
    let text;
    try {
      text = decodeZstdFrames(readFileSync(meta.file));
    } catch {
      continue;
    }
    scanned++;
    let cwd = null;
    let createdAt = null;
    let title = null;
    const pending = [];
    const mentionTimes = [];
    const sessionSends = [];

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const isHeader = i === 0 && line.startsWith('{"type":"session"');
      if (isHeader) {
        try {
          const h = JSON.parse(line);
          cwd = typeof h.cwd === 'string' ? h.cwd : null;
          createdAt = typeof h.createdAt === 'number' ? h.createdAt : null;
        } catch {
          /* ignore */
        }
        continue;
      }
      const maybeSend = line.includes('tailscale file cp') && line.includes('"tool/call"');
      if (
        !line.includes('"attachmentId"') &&
        !line.includes('"session/title"') &&
        !line.includes('"type":"user/message"') &&
        !maybeSend
      )
        continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'session/title') {
        const t = ev.data?.title;
        if (typeof t === 'string' && t.trim() !== '') title = t;
        continue;
      }
      if (ev.type === 'tool/call') {
        let args = ev.data?.arguments;
        try {
          args = typeof args === 'string' ? JSON.parse(args) : args;
        } catch {
          args = null;
        }
        const command = typeof args?.command === 'string' ? args.command : '';
        if (command.includes('tailscale file cp')) {
          for (const rec of parseSendCommand(command, cwd)) {
            sessionSends.push({ ...rec, time: typeof ev.time === 'number' ? ev.time : createdAt });
          }
        }
        continue;
      }
      const isUser = ev.type === 'user/message';
      const isTool = ev.type === 'tool/result';
      if (!isUser && !isTool) continue;
      const content = isUser ? ev.data?.content : ev.data?.message?.content;
      if (!Array.isArray(content)) continue;
      const time = typeof ev.time === 'number' ? ev.time : createdAt;
      if (isUser) {
        for (const block of content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            for (const p of extractPaths(block.text)) mentionTimes.push({ path: p, time });
          }
        }
      }
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type !== 'image' && block.type !== 'file') continue;
        const a = block.attachment;
        if (!a || typeof a.attachmentId !== 'string') continue;
        pending.push({
          id: a.attachmentId,
          kind: isUser ? 'user' : 'tool',
          blockType: block.type,
          name: typeof a.name === 'string' ? a.name : '',
          mediaType: typeof a.mediaType === 'string' ? a.mediaType : '',
          bytes: typeof a.bytes === 'number' ? a.bytes : 0,
          width: typeof a.width === 'number' ? a.width : null,
          height: typeof a.height === 'number' ? a.height : null,
          time,
        });
      }
    }

    for (const rec of sessionSends) {
      sendRecords.push({ ...rec, sessionId: meta.sessionId, title });
    }

    for (const m of mentionTimes) {
      const cur = pathRefs.get(m.path);
      if (cur === undefined) {
        pathRefs.set(m.path, { count: 1, lastTime: m.time ?? 0, firstTime: m.time ?? 0, sessionId: meta.sessionId, title });
      } else {
        cur.count++;
        if ((m.time ?? 0) > cur.lastTime) {
          cur.lastTime = m.time ?? 0;
          cur.sessionId = meta.sessionId;
          cur.title = title;
        }
        if ((m.time ?? 0) < cur.firstTime) cur.firstTime = m.time ?? 0;
      }
    }

    for (const p of pending) {
      const path = objectPathOf(p.id);
      const exists = path !== null && existsSync(path);
      const item = {
        ...p,
        sessionId: meta.sessionId,
        cwd,
        title: title ?? null,
        path: exists ? path : null,
        exists,
      };
      items.push(item);
      if (exists && !byHash.has(p.id)) {
        byHash.set(p.id, { mediaType: item.mediaType, name: item.name, kind: item.kind });
      }
    }
  }

  const fileRefs = [];
  for (const [p, rec] of pathRefs) {
    let st = null;
    let denied = false;
    try {
      st = statSync(p);
    } catch (error) {
      denied = error && (error.code === 'EPERM' || error.code === 'EACCES');
    }
    const isDir = st !== null && st.isDirectory();
    const isFile = st !== null && st.isFile();
    fileRefs.push({
      path: p,
      name: p.split('/').filter(Boolean).pop() ?? p,
      ext: isDir ? '' : (p.includes('.') ? p.split('.').pop().toLowerCase() : ''),
      kind: st === null ? (denied ? 'denied' : 'missing') : isDir ? 'dir' : 'file',
      size: isFile ? st.size : 0,
      mtime: st !== null ? st.mtimeMs : null,
      count: rec.count,
      lastTime: rec.lastTime,
      firstTime: rec.firstTime,
      sessionId: rec.sessionId,
      title: rec.title ?? null,
    });
  }
  fileRefs.sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0));

  // 面板里直接投送过的（浏览器上传，本机本来就没有原文件；只留发送记录）
  try {
    const logText = readFileSync(SEND_LOG, 'utf8');
    for (const line of logText.split('\n')) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec.target !== 'string') continue;
      sendRecords.push({
        target: rec.target,
        name: typeof rec.name === 'string' ? rec.name : 'file',
        path: '',
        time: typeof rec.time === 'number' ? rec.time : Date.now(),
        size: typeof rec.size === 'number' ? rec.size : 0,
        source: 'panel',
        sessionId: null,
        title: '面板直接投送',
        command: 'panel:upload',
      });
    }
  } catch {
    /* 还没有面板投送记录 */
  }

  const sendMap = new Map();
  for (const rec of sendRecords) {
    const key = rec.target + '|' + (rec.path !== '' ? rec.path : 'panel#' + rec.time + '#' + rec.name);
    const cur = sendMap.get(key);
    if (cur === undefined) {
      sendMap.set(key, {
        target: rec.target,
        name: rec.name,
        path: rec.path,
        firstTime: rec.time,
        lastTime: rec.time,
        count: 1,
        sessionId: rec.sessionId,
        title: rec.title ?? null,
        command: rec.command,
      });
    } else {
      cur.count++;
      if ((rec.time ?? 0) > cur.lastTime) {
        cur.lastTime = rec.time;
        cur.sessionId = rec.sessionId;
        cur.title = rec.title ?? cur.title;
      }
      if ((rec.time ?? 0) < cur.firstTime) cur.firstTime = rec.time;
    }
  }
  const sends = [...sendMap.values()]
    .map((rec) => {
      if (rec.path === '') {
        // 面板直接投送：本机没有原文件，但确实发出去了
        return {
          ...rec,
          ext: rec.name.includes('.') ? rec.name.split('.').pop().toLowerCase() : '',
          kind: 'sent',
          size: typeof rec.size === 'number' ? rec.size : 0,
          exists: false,
        };
      }
      let st = null;
      try {
        st = statSync(rec.path);
      } catch {
        st = null;
      }
      return {
        ...rec,
        ext: rec.name.includes('.') ? rec.name.split('.').pop().toLowerCase() : '',
        kind: st === null ? 'missing' : st.isDirectory() ? 'dir' : 'file',
        size: st !== null && st.isFile() ? st.size : 0,
        exists: st !== null,
      };
    })
    .sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0));
  const targetCounts = new Map();
  for (const rec of sends) targetCounts.set(rec.target, (targetCounts.get(rec.target) ?? 0) + 1);
  const sendTargets = [...targetCounts.entries()]
    .map(([target, count]) => ({ target, count }))
    .sort((a, b) => b.count - a.count);

  const missing = items.filter((i) => !i.exists).length;
  items.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  const index = {
    version,
    builtAt: Date.now(),
    tookMs: Date.now() - started,
    scannedSessions: scanned,
    total: items.length,
    missing,
    userCount: items.filter((i) => i.kind === 'user').length,
    toolCount: items.filter((i) => i.kind === 'tool').length,
    totalBytes: items.reduce((n, i) => n + (i.bytes || 0), 0),
    sendCount: sends.length,
    sends,
    sendTargets,
    fileCount: fileRefs.length,
    filesMissing: fileRefs.filter((f) => f.kind === 'missing' || f.kind === 'denied').length,
    items,
    files: fileRefs,
  };
  return { index, byHash };
}

/* ─────────────────────────── 索引状态（内存 + 磁盘缓存） ─────────────────────────── */

let state = { index: null, byHash: new Map(), building: false, lastError: null };

function loadCache() {
  try {
    const raw = readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCache(index) {
  try {
    mkdirSync(ATTACH_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(index));
  } catch {
    /* 没缓存也能跑，只是每次慢 2 秒 */
  }
}

function adopt(index) {
  const byHash = new Map();
  for (const item of index.items) {
    if (item.exists && item.path && !byHash.has(item.id)) {
      byHash.set(item.id, { mediaType: item.mediaType, name: item.name, kind: item.kind });
    }
  }
  state.index = index;
  state.byHash = byHash;
}

function rebuildSync() {
  const { index } = buildIndex();
  adopt(index);
  saveCache(index);
  return index;
}

function rebuildAsync() {
  if (state.building) return;
  state.building = true;
  setImmediate(() => {
    try {
      rebuildSync();
      state.lastError = null;
    } catch (error) {
      state.lastError = String(error);
      try {
        ctxLoggerWarn(`[${PKG}] 索引重建失败：${String(error)}`);
      } catch {
        /* ignore */
      }
    } finally {
      state.building = false;
    }
  });
}

let ctxLoggerWarn = () => {};

/** 拿到当前索引；首次同步构建，之后版本变化走后台重建并先给旧数据。 */
function currentIndex() {
  if (state.index === null) {
    const cache = loadCache();
    const { version } = logFiles();
    if (cache && cache.version === version) {
      adopt(cache);
    } else if (cache) {
      adopt(cache);
      rebuildAsync();
    } else {
      rebuildSync();
    }
  } else {
    const { version } = logFiles();
    if (state.index.version !== version) rebuildAsync();
  }
  return state.index;
}

/* ─────────────────────────── 缩略图 ─────────────────────────── */

const inflightThumbs = new Map();

function thumbPath(hash, width) {
  return join(THUMBS_DIR, `${hash}@${width}.jpg`);
}

function runSips(src, dst, width) {
  // 缩略图靠 macOS 自带的 sips；其他平台直接放弃，前端会回落成原图
  if (!IS_MAC) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/sips',
      ['-Z', String(width), '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', src, '--out', dst],
      { timeout: 20000 },
      (error) => resolve(error ? null : dst),
    );
  });
}

async function ensureThumb(hash, width) {
  const dst = thumbPath(hash, width);
  if (existsSync(dst)) return dst;
  const key = hash + '@' + width;
  const running = inflightThumbs.get(key);
  if (running) return running;
  const src = objectPathOf('sha256:' + hash);
  if (src === null || !existsSync(src)) return null;
  try {
    mkdirSync(THUMBS_DIR, { recursive: true });
  } catch {
    return null;
  }
  const job = runSips(src, dst, width)
    .catch(() => null)
    .finally(() => inflightThumbs.delete(key));
  inflightThumbs.set(key, job);
  return job;
}

/* ─────────────────────────── HTTP ─────────────────────────── */

function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendText(res, code, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(text);
}

function guessType(hash, fallback) {
  if (typeof fallback === 'string' && fallback.startsWith('image/')) return fallback;
  const known = state.byHash.get('sha256:' + hash);
  if (known?.mediaType) return known.mediaType;
  return 'application/octet-stream';
}

async function handlePanelHtml(req, res) {
  try {
    sendText(res, 200, panelHtml(), 'text/html; charset=utf-8');
  } catch (error) {
    sendText(res, 500, 'panel html unavailable: ' + String(error));
  }
}

function handleIndex(req, res, url) {
  let index;
  try {
    index = currentIndex();
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: String(error) });
  }
  if (url.searchParams.get('refresh') === '1') rebuildAsync();
  const scope = url.searchParams.get('scope') ?? 'user';
  const items = scope === 'file' ? [] : index.items.filter((i) => (scope === 'all' ? true : i.kind === scope));
  return sendJson(res, 200, {
    ok: true,
    version: index.version,
    builtAt: index.builtAt,
    tookMs: index.tookMs,
    scope,
    stale: state.building,
    building: state.building,
    counts: {
      user: index.userCount,
      tool: index.toolCount,
      all: index.total,
      files: index.fileCount ?? 0,
      filesMissing: index.filesMissing ?? 0,
      sends: index.sendCount ?? 0,
      missing: index.missing,
      totalBytes: index.totalBytes,
    },
    items,
    files: index.files ?? [],
    sends: index.sends ?? [],
    sendTargets: index.sendTargets ?? [],
  });
}

function handleRaw(req, res, hash) {
  const path = objectPathOf('sha256:' + hash);
  if (path === null || !existsSync(path)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    /* ignore */
  }
  const type = guessType(hash);
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(size),
    'cache-control': 'public, max-age=31536000, immutable',
  });
  createReadStream(path)
    .on('error', () => res.destroy())
    .pipe(res);
}

async function handleThumb(req, res, hash, widthRaw) {
  let width = Number(widthRaw);
  if (!THUMB_WIDTHS.has(width)) width = 480;
  const thumb = await ensureThumb(hash, width);
  if (thumb !== null && existsSync(thumb)) {
    let size = 0;
    try {
      size = statSync(thumb).size;
    } catch {
      /* ignore */
    }
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': String(size),
      'cache-control': 'public, max-age=31536000, immutable',
    });
    createReadStream(thumb)
      .on('error', () => res.destroy())
      .pipe(res);
    return;
  }
  // sips 不支持这个格式（例如某些 webp）：退回原图，让浏览器自己缩。
  handleRaw(req, res, hash);
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/* ─────────────────────── 接收（Taildrop 收到的） ─────────────────────── */

function runPool(items, limit, worker) {
  return new Promise((resolve) => {
    let index = 0;
    let running = 0;
    let done = 0;
    const total = items.length;
    if (total === 0) return resolve();
    const next = () => {
      while (running < limit && index < total) {
        const item = items[index++];
        running++;
        Promise.resolve(worker(item))
          .catch(() => {})
          .finally(() => {
            running--;
            done++;
            if (done === total) resolve();
            else next();
          });
      }
    };
    next();
  });
}

/**
 * 一次读全一个文件的扩展属性名（xattr -l 的输出里含属性名）。
 * 用来判断来源：浏览器下载带 com.apple.quarantine，App 内传输带 com.apple.provenance，
 * Taildrop 收到的通常两个都没有（只剩 com.apple.macl 这种沙箱授权）。
 */
function readXattrs(path) {
  if (!IS_MAC) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    execFile('/usr/bin/xattr', ['-l', path], { timeout: 5000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      resolve(new Set(String(stdout ?? '').split('\n').map((l) => l.split(':')[0].trim()).filter((n) => n !== '')));
    });
  });
}

let receivedCache = { at: 0, key: '', data: null };

/**
 * 收到的文件。
 *   - inbox：/Library/Tailscale/incoming-files（准确，待接收）
 *   - 收件目录：默认 ~/Downloads 里近 45 天、且没有 com.apple.quarantine 的文件
 *     （浏览器下载都带这个标记；Taildrop/AirDrop 不带，所以只能是「疑似」）
 */
async function scanReceived(force = false) {
  const key = INCOMING_DIR + '|' + RECEIVE_DIRS.join(',');
  if (!force && receivedCache.data !== null && receivedCache.key === key && Date.now() - receivedCache.at < RECEIVE_TTL_MS) {
    return receivedCache.data;
  }
  const items = [];

  // 1) 待接收 inbox
  try {
    for (const name of readdirSync(INCOMING_DIR)) {
      if (name.startsWith('.')) continue;
      const path = join(INCOMING_DIR, name);
      let st = null;
      try {
        st = statSync(path);
      } catch {
        st = null;
      }
      if (st === null || !st.isFile()) continue;
      items.push({ name, path, size: st.size, time: st.mtimeMs, origin: 'inbox', pending: true, certain: true });
    }
  } catch {
    /* 没有这个目录或没权限 */
  }

  // 2) 收件目录里「没有浏览器下载标记」的近期文件
  const cutoff = Date.now() - RECEIVE_WINDOW_MS;
  for (const dir of RECEIVE_DIRS) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const candidates = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const path = join(dir, name);
      let st = null;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoff) continue;
      candidates.push({ name, path, size: st.size, time: st.mtimeMs, dir });
    }
    candidates.sort((a, b) => b.time - a.time);
    const top = candidates.slice(0, RECEIVE_MAX_PER_DIR);
    const marked = new Set();
    await runPool(top, 8, async (f) => {
      const attrs = await readXattrs(f.path);
      if (attrs.has('com.apple.quarantine') || attrs.has('com.apple.provenance')) marked.add(f.path);
    });
    for (const f of top) {
      if (marked.has(f.path)) continue;
      items.push({
        name: f.name,
        path: f.path,
        size: f.size,
        time: f.time,
        origin: 'dir',
        dir: f.dir,
        pending: false,
        certain: false,
      });
    }
  }

  items.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  const data = {
    ok: true,
    scannedAt: Date.now(),
    inboxDir: INCOMING_DIR,
    receiveDirs: RECEIVE_DIRS,
    pendingCount: items.filter((i) => i.pending).length,
    items: items.map((i) => ({
      ...i,
      ext: i.name.includes('.') ? i.name.split('.').pop().toLowerCase() : '',
      kind: 'file',
    })),
  };
  receivedCache = { at: Date.now(), key, data };
  return data;
}

/** 扫完之后才知道哪些路径允许操作，单独维护一个短名单。 */
function receivedPathAllowed(raw) {
  const data = receivedCache.data;
  if (data === null) return false;
  return data.items.some((i) => i.path === raw);
}

async function handleReceived(req, res, url) {
  try {
    const data = await scanReceived(url.searchParams.get('refresh') === '1');
    return sendJson(res, 200, data);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: String(error) });
  }
}

/** 待接收的文件：从 inbox 拉出来（tailscale file get）。 */
async function handleReceivePull(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad json' });
  }
  const dir = typeof body.dir === 'string' && body.dir.startsWith('/') ? body.dir : RECEIVE_DIRS[0];
  if (!RECEIVE_DIRS.includes(dir)) return sendJson(res, 400, { ok: false, error: '只能收到已配置的收件目录' });
  const out = await runTailscale(['file', 'get', '--conflict', 'rename', dir], 120000);
  receivedCache = { at: 0, key: '', data: null };
  return sendJson(res, out.code === 0 ? 200 : 502, {
    ok: out.code === 0,
    dir,
    stdout: out.stdout.trim(),
    error: out.code === 0 ? undefined : out.stderr.trim() || 'tailscale file get 退出码 ' + out.code,
  });
}

/* ─────────────────────── 面板里直接投送 ─────────────────────── */

function runTailscale(args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(TAILSCALE_BIN, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? (error ? error.message : '')),
      });
    });
  });
}

/** 能接收 Taildrop 的设备（tailscale debug localapi file-targets）。 */
async function listTargets() {
  const out = await runTailscale(['debug', 'localapi', 'file-targets'], 20000);
  if (out.code !== 0) throw new Error(out.stderr || 'file-targets failed');
  const line = out.stdout.split('\n').find((l) => l.trim().startsWith('['));
  if (line === undefined) throw new Error('file-targets 没有返回 JSON');
  const list = JSON.parse(line);
  return list
    .map((t) => {
      const node = t.Node ?? {};
      return {
        target: typeof node.ComputedName === 'string' ? node.ComputedName : '',
        dns: typeof node.Name === 'string' ? node.Name.replace(/\.$/, '') : '',
        host: typeof node.ComputedNameWithHost === 'string' ? node.ComputedNameWithHost : '',
        os: node.Hostinfo?.OS ?? '',
        online: node.Online === true,
        ip: (node.Addresses ?? [])[0]?.split('/')[0] ?? '',
      };
    })
    .filter((t) => t.target !== '');
}

/** 去掉路径分隔符/控制字符，只留一个安全文件名。 */
function safeFileName(raw) {
  const base = String(raw ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  const cut = base.slice(0, 180);
  return cut === '' ? 'file' : cut;
}

function appendSendLog(rec) {
  try {
    appendFileSync(SEND_LOG, JSON.stringify(rec) + '\n');
  } catch {
    /* 记不上也不影响投送本身 */
  }
}

async function handleTargets(req, res) {
  try {
    const targets = await listTargets();
    return sendJson(res, 200, { ok: true, targets });
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: String(error && error.message ? error.message : error) });
  }
}

/** 浏览器选的文件 → 临时目录 → tailscale file cp --name <n> <tmp> <target>: */
async function handleSend(req, res, url) {
  const wantedTarget = url.searchParams.get('target') ?? '';
  const rawName = url.searchParams.get('name') ?? '';
  let targets;
  try {
    targets = await listTargets();
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: '拿不到设备列表：' + String(error) });
  }
  const hit = targets.find((t) => t.target === wantedTarget);
  if (hit === undefined) return sendJson(res, 400, { ok: false, error: '未知的目标设备：' + wantedTarget });
  if (!hit.online) return sendJson(res, 409, { ok: false, error: hit.target + ' 当前离线，投送会失败' });

  const name = safeFileName(rawName);
  let tmpDir;
  try {
    mkdirSync(SEND_TMP_ROOT, { recursive: true });
    tmpDir = mkdtempSync(join(SEND_TMP_ROOT, 'send-'));
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: '临时目录建不出来：' + String(error) });
  }
  const tmpFile = join(tmpDir, name);
  let bytes = 0;
  try {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > SEND_MAX_BYTES) {
      req.resume();
      return sendJson(res, 413, { ok: false, error: '文件超过 2GB 上限' });
    }
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > SEND_MAX_BYTES) throw new Error('文件超过 2GB 上限');
          yield chunk;
        }
      },
      createWriteStream(tmpFile),
    );
  } catch (error) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return sendJson(res, 500, { ok: false, error: '接收上传失败：' + String(error) });
  }
  if (bytes === 0) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return sendJson(res, 400, { ok: false, error: '空文件，没发' });
  }

  const out = await runTailscale(['file', 'cp', '--name', name, tmpFile, hit.target + ':'], 180000);
  const ok = out.code === 0;
  if (ok) {
    appendSendLog({
      time: Date.now(),
      target: hit.target,
      name,
      path: '',
      size: bytes,
      source: 'panel',
      sessionId: null,
      title: '面板直接投送',
    });
  }
  setTimeout(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }, 5000);
  return sendJson(res, ok ? 200 : 502, {
    ok,
    target: hit.target,
    name,
    bytes,
    exitCode: out.code,
    error: ok ? undefined : out.stderr.trim() || 'tailscale file cp 退出码 ' + out.code,
  });
}

/** 索引里出现过的路径才允许操作，避免变成本机任意文件接口。 */
function indexedPath(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  const index = state.index;
  if (index === null || !Array.isArray(index.files)) return null;
  const hit = index.files.find((f) => f.path === raw);
  return hit ?? null;
}

async function handlePathAction(req, res, mode) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad json' });
  }
  let hit = indexedPath(body.path);
  if (hit === null && receivedPathAllowed(body.path)) {
    hit = { path: body.path, kind: 'file' };
  }
  if (hit === null) return sendJson(res, 404, { ok: false, error: 'path not indexed' });
  if (hit.kind === 'missing' || hit.kind === 'denied') {
    return sendJson(res, 404, { ok: false, error: hit.kind === 'denied' ? '没有权限访问' : '文件已不在原位置' });
  }
  if (OPENER === null) return sendJson(res, 501, { ok: false, error: '当前平台不支持用系统程序打开' });
  const args = mode === 'reveal' ? OPENER.reveal(hit.path) : OPENER.open(hit.path);
  execFile(OPENER.bin, args, { timeout: 10000 }, (error) => {
    if (error) sendJson(res, 500, { ok: false, error: String(error) });
    else sendJson(res, 200, { ok: true, path: hit.path });
  });
}

async function handleReveal(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad json' });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  const path = objectPathOf(id.startsWith('sha256:') ? id : 'sha256:' + id);
  if (path === null || !path.startsWith(OBJECTS_DIR) || !existsSync(path)) {
    return sendJson(res, 404, { ok: false, error: 'file not found' });
  }
  if (OPENER === null) return sendJson(res, 501, { ok: false, error: '当前平台不支持定位文件' });
  execFile(OPENER.bin, OPENER.reveal(path), { timeout: 10000 }, (error) => {
    if (error) sendJson(res, 500, { ok: false, error: String(error) });
    else sendJson(res, 200, { ok: true, path });
  });
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    return sendText(res, 400, 'bad url');
  }
  const pathname = url.pathname;
  const rest = pathname.slice(ROUTE.length).replace(/^\/+/, '');

  if (req.method === 'GET' && (rest === '' || rest === 'index.html')) return handlePanelHtml(req, res);
  if (req.method === 'GET' && rest === 'api/index') return handleIndex(req, res, url);
  if (req.method === 'GET' && rest === 'api/health') {
    const index = state.index;
    return sendJson(res, 200, {
      ok: true,
      pkg: PKG,
      hasIndex: index !== null,
      items: index?.total ?? 0,
      files: index?.fileCount ?? 0,
      code: 2,
      version: index?.version ?? null,
      building: state.building,
      error: state.lastError,
      objects: OBJECTS_DIR,
    });
  }
  const row = rest.match(/^api\/(raw|thumb)\/([0-9a-f]{64})(?:@(\d+))?$/);
  if (req.method === 'GET' && row !== null) {
    const [, what, hash, widthPart] = row;
    if (what === 'raw') return handleRaw(req, res, hash);
    return handleThumb(req, res, hash, url.searchParams.get('w') ?? widthPart ?? '480');
  }
  if (req.method === 'GET' && rest === 'api/received') {
    try {
      return await handleReceived(req, res, url);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error) });
    }
  }
  if (req.method === 'POST' && rest === 'api/receive-pull') {
    try {
      return await handleReceivePull(req, res);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error) });
    }
  }
  if (req.method === 'GET' && rest === 'api/targets') {
    try {
      return await handleTargets(req, res);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error) });
    }
  }
  if (req.method === 'POST' && rest === 'api/send') {
    try {
      return await handleSend(req, res, url);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error) });
    }
  }
  if (req.method === 'POST' && rest === 'api/reveal-path') {
    try {
      return await handlePathAction(req, res, 'reveal');
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error) });
    }
  }
  if (req.method === 'POST' && rest === 'api/open-path') {
    try {
      return await handlePathAction(req, res, 'open');
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error) });
    }
  }
  if (req.method === 'POST' && rest === 'api/reveal') {
    try {
      return await handleReveal(req, res);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error) });
    }
  }
  return sendText(res, 404, 'dsh-attachment-panel: unknown route ' + pathname);
}

/* ─────────────────────────── 插件入口 ─────────────────────────── */

export const inject = ['webServer'];

export function apply(ctx) {
  ctxLoggerWarn = (msg) => {
    try {
      ctx.logger?.warn?.(msg);
    } catch {
      /* ignore */
    }
  };
  try {
    const html = panelHtml();
    ctx.logger?.info?.(`[${PKG}] 面板页面已就绪（${Math.round(html.length / 1024)}KB，改 panel.html 后刷新即生效）`);
  } catch (error) {
    ctxLoggerWarn(`[${PKG}] 面板页面读取失败：${String(error)}`);
  }

  const registerRoute = () =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => {
        Promise.resolve()
          .then(() => handle(req, res))
          .catch((error) => {
            ctxLoggerWarn(`[${PKG}] 请求处理失败：${String(error)}`);
            try {
              if (!res.headersSent) sendText(res, 500, 'panel error: ' + String(error));
              else res.destroy();
            } catch {
              /* ignore */
            }
          });
      },
    });

  try {
    // 用 effect 包住：插件被热重载/卸载时先摘掉旧路由，免得撞 duplicate route
    if (typeof ctx.effect === 'function') ctx.effect(registerRoute, 'attachment-panel: route');
    else registerRoute();
    ctx.logger?.info?.(`[${PKG}] 已注册 ${ROUTE}`);
  } catch (error) {
    ctxLoggerWarn(`[${PKG}] 路由注册失败：${String(error)}`);
  }

  // 启动后空闲时预热索引，首次打开面板就不用等
  const timer = setTimeout(() => {
    try {
      currentIndex();
      ctx.logger?.info?.(`[${PKG}] 索引预热完成：${state.index?.total ?? 0} 条`);
    } catch (error) {
      ctxLoggerWarn(`[${PKG}] 索引预热失败：${String(error)}`);
    }
  }, 3000);
  timer.unref?.();
}

export default { inject, apply };
