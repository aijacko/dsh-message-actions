// dsh-message-actions — 会话管理（删除到回收站 / 恢复 / 彻底清理 / 归档）。
//
// 数据源与写入都走宿主官方服务：
//   - sessionQuery.listSessions / readSession / readTitleSnapshots：枚举与正文；
//   - sessionPersistence.open / create / append / stat：删除与恢复日志；
//   - workspaceRegistry：工作区分组、归档集与成员关系。
//
// 删除采用「整目录移入回收站」而不是删文件：恢复时原样移回，宿主无需迁移格式。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import pure from "./sessions.cjs";

const {
  isSessionId,
  isTrashId,
  isContainedPath,
  sessionDirOf,
  titleTextOf,
  normalizeTrashMeta,
  sortSessionsNewestFirst,
  sortTrashNewestFirst,
  TRASH_META_VERSION,
  MAX_TITLE_LENGTH
} = pure;

const TRASH_DIR_NAME = "dsh-message-actions-trash";
const TRASH_META_FILE = "meta.json";
const TRASH_SESSION_DIR = "session";
const TOMBSTONE_FILE = "purged.json";
const STAGING_PREFIX = "_staging-";
const MAX_TOMBSTONES = 500;
const MAX_BATCH = 50;
const MAX_TRASH_ENTRIES = 500;
const TITLE_CACHE_MS = 20000;
const TITLE_CACHE_MAX = 600;
const META_CONCURRENCY = 6;

/** 结果里区分「已完成」与「需要重启宿主才能看到分组」。 */
function resultOf(id, patch) {
  return Object.assign({ id, ok: true }, patch || {});
}

function failureOf(id, code, message) {
  return { id, ok: false, error: code, message: message || code };
}

function normalizePathKey(value) {
  if (typeof value !== "string" || value === "") return "";
  let key = path.resolve(value);
  if (process.platform === "win32") key = key.toLowerCase();
  return key.replace(/[\\/]+$/, "");
}

function isDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 会话日志读取（回收站校验 / 归档 / 恢复时确认归属）
// ---------------------------------------------------------------------------

const LOG_NAME_RE = /^session\.v\d+\.jsonl(?:\.zstd)?$/;
const ZSTD_MAGIC = 0x28b52ffd;
const zstdDecompressSync = typeof zlib.zstdDecompressSync === "function" ? zlib.zstdDecompressSync : null;
const zstdDecompress = typeof zlib.zstdDecompress === "function" ? promisify(zlib.zstdDecompress) : null;

function isZstdBuffer(buf) {
  return buf.length >= 4 && buf.readUInt32BE(0) === ZSTD_MAGIC;
}

/**
 * 扫描 zstd 压缩流里的每个独立帧，返回各自的字节区间。
 *
 * 宿主的会话日志是「多帧拼接」：首帧只压缩一行 header，之后每次追加写入
 * 的新事件各自成帧。Node 的 `zstdDecompress(Sync)` 只解首帧，所以移动日志
 * 时绝不能整段解压再压缩（那样会丢掉首帧之后的所有事件）；正确做法是
 * 只重写首帧、原样保留其余字节。
 *
 * 遇到被截断的帧时返回 `tornStart`，由调用方决定按损坏处理。
 */
function scanZstdFrames(buf) {
  const frames = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length || buf.readUInt32BE(pos) !== ZSTD_MAGIC) {
      return { frames, tornStart: pos };
    }
    const start = pos;
    pos += 4;
    if (pos >= buf.length) return { frames, tornStart: start };
    const descriptor = buf[pos];
    pos += 1;
    if ((descriptor & 0x08) !== 0) return { frames, tornStart: start };
    const fcsFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const checksumFlag = (descriptor >> 2) & 1;
    const dictFlag = descriptor & 0x03;
    let cursor = pos;
    if (!singleSegment) {
      if (cursor + 1 > buf.length) return { frames, tornStart: start };
      cursor += 1;
    }
    const dictSize = dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4;
    if (cursor + dictSize > buf.length) return { frames, tornStart: start };
    cursor += dictSize;
    const fcsSize = singleSegment ? [1, 2, 4, 8][fcsFlag] : [0, 2, 4, 8][fcsFlag];
    if (cursor + fcsSize > buf.length) return { frames, tornStart: start };
    cursor += fcsSize;
    while (true) {
      if (cursor + 3 > buf.length) return { frames, tornStart: start };
      const blockHeader = buf[cursor] | (buf[cursor + 1] << 8) | (buf[cursor + 2] << 16);
      cursor += 3;
      const lastBlock = blockHeader & 1;
      const blockType = (blockHeader >> 1) & 3;
      const blockSize = blockHeader >> 3;
      if (blockType === 3) return { frames, tornStart: start };
      if (blockType === 1) {
        if (cursor + 1 > buf.length) return { frames, tornStart: start };
        cursor += 1;
      } else {
        if (cursor + blockSize > buf.length) return { frames, tornStart: start };
        cursor += blockSize;
      }
      if (lastBlock) break;
    }
    if (checksumFlag) {
      if (cursor + 4 > buf.length) return { frames, tornStart: start };
      cursor += 4;
    }
    pos = cursor;
    frames.push({ start, end: pos });
  }
  return { frames, tornStart: undefined };
}

async function decompressZstdBuffer(buf) {
  try {
    if (zstdDecompressSync) return zstdDecompressSync(buf);
    if (zstdDecompress) return Buffer.from(await zstdDecompress(buf));
  } catch (err) {
    throw Object.assign(new Error(`could not decode session log: ${err instanceof Error ? err.message : String(err)}`), { code: "LOG_DECODE_FAILED" });
  }
  throw Object.assign(new Error("zstd logs are not supported by this runtime"), { code: "ZSTD_UNAVAILABLE" });
}

/** 在会话目录里找日志文件（`session.v4.jsonl.zstd` / 明文测试桩同名文件）。 */
function findLogFile(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return "";
  }
  const hit = names.find((name) => LOG_NAME_RE.test(name));
  return hit ? path.join(dir, hit) : "";
}

function splitLogText(text) {
  const index = text.indexOf("\n");
  if (index === -1) return { firstLine: text, rest: "" };
  return { firstLine: text.slice(0, index), rest: text.slice(index + 1) };
}

/**
 * 读取会话日志的「首帧 / 首行」。zstd 日志的首帧只含 header，
 * 这里只解首帧，避免把整个多帧日志读进内存。
 */
async function readLogText(dir) {
  const file = findLogFile(dir);
  if (file === "") {
    throw Object.assign(new Error(`session log not found in ${dir}`), { code: "LOG_NOT_FOUND" });
  }
  const buf = await fsp.readFile(file);
  if (!isZstdBuffer(buf)) return { file, compressed: false, text: buf.toString("utf8") };
  const scan = scanZstdFrames(buf);
  if (scan.frames.length === 0) {
    throw Object.assign(new Error(`session log is not a valid Zstandard stream: ${file}`), { code: "LOG_DECODE_FAILED" });
  }
  const first = scan.frames[0];
  const text = (await decompressZstdBuffer(buf.subarray(first.start, first.end))).toString("utf8");
  return { file, compressed: true, text, scan, buf };
}

/** 校验目录里的日志首行 header.id 是否就是目标会话（防止误删/误恢复同目录的其他日志）。 */
async function logBelongsTo(dir, sessionId) {
  try {
    const log = await readLogText(dir);
    const header = JSON.parse(splitLogText(log.text).firstLine);
    return !!header && header.id === sessionId;
  } catch {
    return false;
  }
}

export function createSessionManager(ctx, options) {
  const opts = options && typeof options === "object" ? options : {};
  const warn = (message) => {
    if (typeof ctx.logger?.warn === "function") ctx.logger.warn(`[dsh-message-actions] ${message}`);
  };

  function service(name) {
    try {
      return ctx.get(name);
    } catch {
      return null;
    }
  }

  const persistence = () => service("sessionPersistence");
  const query = () => {
    const value = service("sessionQuery");
    return value && typeof value.listSessions === "function" ? value : null;
  };
  const registry = () => {
    const value = service("workspaceRegistry");
    return value && typeof value.list === "function" ? value : null;
  };

  function sessionRoot() {
    const sp = persistence();
    const root = sp && typeof sp.root === "string" ? sp.root : "";
    if (root === "" || !path.isAbsolute(root)) return "";
    return path.resolve(root);
  }

  function trashRoot() {
    const root = sessionRoot();
    if (root === "") return "";
    return path.join(path.dirname(root), TRASH_DIR_NAME);
  }

  async function ensureTrashRoot() {
    const root = trashRoot();
    if (root === "") throw Object.assign(new Error("session persistence is unavailable"), { code: "TRASH_UNAVAILABLE" });
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    return root;
  }

  // -------------------------------------------------------------------------
  // 已彻底清理的墓碑
  //
  // 物理删除日志后，宿主内存里可能仍持有 live 会话，listSessions 会把它以
  // 「未分组」返回。墓碑记录这些 id：只有磁盘日志确实不存在时才隐藏，
  // 同名会话被重新创建后会自然失效。
  // -------------------------------------------------------------------------

  function tombstonePath() {
    const root = trashRoot();
    return root === "" ? "" : path.join(root, TOMBSTONE_FILE);
  }

  function normalizeTombstone(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (!isSessionId(raw.id)) return null;
    const header = raw.header;
    if (!header || typeof header !== "object" || Array.isArray(header)) return null;
    if (header.id !== raw.id) return null;
    if (typeof header.cwd !== "string" || header.cwd.length > 4096) return null;
    if (!Number.isFinite(raw.purgedAt) || raw.purgedAt <= 0) return null;
    return { id: raw.id, header, purgedAt: Math.trunc(raw.purgedAt) };
  }

  async function readTombstones() {
    const file = tombstonePath();
    if (file === "") return [];
    try {
      const raw = JSON.parse(await fsp.readFile(file, "utf8"));
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        const value = normalizeTombstone(item);
        if (value) out.push(value);
        if (out.length >= MAX_TOMBSTONES) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  async function writeTombstones(list) {
    const file = tombstonePath();
    if (file === "") return false;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = file + ".tmp";
      await fsp.writeFile(temp, JSON.stringify(list.slice(0, MAX_TOMBSTONES)), { mode: 0o600 });
      await fsp.rename(temp, file);
      return true;
    } catch (err) {
      warn(`could not write purge tombstones: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async function addTombstone(header) {
    if (!header || !isSessionId(header.id)) return false;
    const list = (await readTombstones()).filter((item) => item.id !== header.id);
    list.unshift({ id: header.id, header, purgedAt: Date.now() });
    return writeTombstones(list);
  }

  async function removeTombstone(sessionId) {
    const list = await readTombstones();
    const next = list.filter((item) => item.id !== sessionId);
    if (next.length === list.length) return true;
    return writeTombstones(next);
  }

  /** 只返回「日志确实不在磁盘上」的墓碑 id，避免误隐藏重建后的同名会话。 */
  async function activePurgedIds(sp, root) {
    const list = await readTombstones();
    const out = [];
    for (const item of list) {
      const dir = locatedDir(sp, item.header, root);
      if (insideRoot(root, dir) && findLogFile(dir) !== "") continue;
      out.push(item.id);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 工作区
  // -------------------------------------------------------------------------

  function workspaces() {
    const serviceValue = registry();
    if (!serviceValue) return [];
    let list = [];
    try {
      list = serviceValue.list();
    } catch (err) {
      warn(`workspace list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const out = [];
    for (const entity of Array.isArray(list) ? list : []) {
      if (!entity || typeof entity.id !== "string" || typeof entity.path !== "string") continue;
      out.push({
        id: entity.id,
        title: typeof entity.title === "string" ? entity.title : entity.path,
        path: entity.path
      });
    }
    return out;
  }

  function workspaceOf(cwd, sessionId, list) {
    const key = normalizePathKey(cwd);
    for (const item of list) {
      if (key !== "" && normalizePathKey(item.path) === key) return item;
    }
    // cwd 被重命名 / 软链接时，按 registry 已记录的成员关系兜底。
    const serviceValue = registry();
    if (serviceValue) {
      for (const item of list) {
        try {
          const entity = serviceValue.get(item.id);
          if (entity && Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId)) return item;
        } catch {
          /* ignore */
        }
      }
    }
    return null;
  }

  function archivedSet() {
    const serviceValue = registry();
    if (!serviceValue) return new Set();
    try {
      return new Set(Array.isArray(serviceValue.archivedSessionIds) ? serviceValue.archivedSessionIds : []);
    } catch {
      return new Set();
    }
  }

  function runningSet() {
    const running = new Set();
    try {
      const agents = service("agents");
      if (agents && typeof agents.list === "function") {
        for (const agent of agents.list()) {
          if (!agent || agent.status !== "running") continue;
          const id = agent.session && typeof agent.session.id === "string" ? agent.session.id : agent.id;
          if (typeof id === "string") running.add(id);
        }
      }
    } catch {
      /* 运行状态只是装饰 */
    }
    return running;
  }

  // -------------------------------------------------------------------------
  // 标题
  // -------------------------------------------------------------------------

  const titleCache = new Map();

  function cacheTitle(id, title) {
    if (titleCache.size >= TITLE_CACHE_MAX && !titleCache.has(id)) {
      const oldest = titleCache.keys().next();
      if (!oldest.done) titleCache.delete(oldest.value);
    }
    titleCache.set(id, { at: Date.now(), title });
  }

  function forgetTitle(id) {
    titleCache.delete(id);
  }

  async function titlesFor(ids) {
    const out = new Map();
    const missing = [];
    const now = Date.now();
    for (const id of ids) {
      const cached = titleCache.get(id);
      if (cached && now - cached.at < TITLE_CACHE_MS) out.set(id, cached.title);
      else missing.push(id);
    }
    if (missing.length === 0) return out;
    const serviceValue = query();
    if (!serviceValue || typeof serviceValue.readTitleSnapshots !== "function") {
      for (const id of missing) out.set(id, "");
      return out;
    }
    let results;
    try {
      results = await serviceValue.readTitleSnapshots(missing);
    } catch (err) {
      warn(`title lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      for (const id of missing) out.set(id, "");
      return out;
    }
    for (let index = 0; index < missing.length; index += 1) {
      const id = missing[index];
      const outcome = Array.isArray(results) ? results[index] : null;
      const title = outcome && outcome.status === "fulfilled"
        ? titleTextOf(outcome.value && outcome.value.title).slice(0, MAX_TITLE_LENGTH)
        : "";
      cacheTitle(id, title);
      out.set(id, title);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 回收站读取
  // -------------------------------------------------------------------------

  async function readTrashEntries() {
    const root = trashRoot();
    if (root === "") return [];
    let dirents;
    try {
      dirents = await fsp.readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === "ENOENT") return [];
      throw err;
    }
    const entries = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !isTrashId(dirent.name) || dirent.name.startsWith(STAGING_PREFIX)) continue;
      if (entries.length >= MAX_TRASH_ENTRIES) break;
      const dir = path.join(root, dirent.name);
      if (!isContainedPath(root, dir)) continue;
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(dir, TRASH_META_FILE), "utf8"));
        const meta = normalizeTrashMeta(raw);
        if (!meta || meta.trashId !== dirent.name) {
          warn(`skipping malformed trash entry "${dirent.name}"`);
          continue;
        }
        // 新格式是「软回收站」：日志留在原工作区，回收站条目只有 meta.json。
        // 旧格式（物理移入 session/ 子目录）继续兼容。
        const sessionDir = path.join(dir, TRASH_SESSION_DIR);
        const soft = !isDirectory(sessionDir);
        let missing = false;
        if (soft) {
          const sp = persistence();
          const rootPath = sessionRoot();
          const currentDir = sp && rootPath ? locatedDir(sp, meta.header, rootPath) : "";
          missing = !(currentDir !== ""
            && insideRoot(rootPath, currentDir)
            && isDirectory(currentDir)
            && findLogFile(currentDir) !== "");
        }
        entries.push(Object.assign({}, meta, { soft, missing }));
      } catch (err) {
        if (!err || err.code !== "ENOENT") {
          warn(`could not read trash entry "${dirent.name}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return sortTrashNewestFirst(entries);
  }

  async function entryFor(trashId) {
    if (!isTrashId(trashId)) return null;
    const root = trashRoot();
    if (root === "") return null;
    const dir = path.join(root, trashId);
    if (!isContainedPath(root, dir)) return null;
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(dir, TRASH_META_FILE), "utf8"));
      const meta = normalizeTrashMeta(raw);
      if (!meta || meta.trashId !== trashId) return null;
      const sessionDir = path.join(dir, TRASH_SESSION_DIR);
      if (!isContainedPath(dir, sessionDir)) return null;
      const soft = !isDirectory(sessionDir);
      return { meta, dir, sessionDir: soft ? "" : sessionDir, soft };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 列表
  // -------------------------------------------------------------------------

  /**
   * 补充模型 / 消息数等展示字段。
   * 数据来自宿主的统计服务（内部带 revision 缓存），这里只做并发节流；
   * 任何一条失败都留空，绝不影响列表本身。
   */
  async function enrichRows(paired) {
    const metaFn = typeof opts.sessionMeta === "function" ? opts.sessionMeta : null;
    if (!metaFn || paired.length === 0) return;
    let cursor = 0;
    const worker = async () => {
      while (cursor < paired.length) {
        const index = cursor;
        cursor += 1;
        const { row, record } = paired[index];
        let meta = null;
        try {
          meta = await metaFn(record);
        } catch {
          meta = null;
        }
        if (!meta) continue;
        if (typeof meta.model === "string" && meta.model !== "") row.model = meta.model;
        if (typeof meta.provider === "string" && meta.provider !== "") row.provider = meta.provider;
        if (Number.isFinite(meta.messages) && meta.messages > 0) row.messages = meta.messages;
        if (Number.isFinite(meta.turns) && meta.turns > 0) row.turns = meta.turns;
        if (Number.isFinite(meta.tokens) && meta.tokens > 0) row.tokens = meta.tokens;
        if (row.title === "" && typeof meta.title === "string" && meta.title !== "") row.title = meta.title;
        if (Number.isFinite(meta.lastActiveAt) && meta.lastActiveAt > row.updatedAt) {
          row.updatedAt = meta.lastActiveAt;
        }
      }
    };
    const size = Math.min(META_CONCURRENCY, paired.length);
    await Promise.all(Array.from({ length: size }, worker));
  }

  /**
   * 会话管理快照。
   * `lean` 用于跳过逐条正文统计（只返回工作区与会话基础字段）。
   * 跳过模型、消息数等需要折叠日志的补充字段，避免菜单打开时等待。
   */
  async function payload(options) {
    const lean = !!(options && options.lean);
    const hiddenOnly = !!(options && options.hiddenOnly);
    const serviceValue = query();
    const sp = persistence();
    const root = sessionRoot();
    const available = serviceValue !== null && sp !== null && root !== "";
    const wsList = workspaces();
    if (!available) {
      return {
        available: false,
        sessions: [],
        workspaces: wsList,
        trash: { count: 0, bytes: 0, entries: [] },
        trashedIds: [],
        purgedIds: [],
        canReset: false
      };
    }
    // 侧边栏隐藏行只需要两个 id 列表：不枚举会话、不折叠日志。
    if (hiddenOnly) {
      let trashEntries = [];
      let purgedIds = [];
      try {
        trashEntries = await readTrashEntries();
      } catch {
        trashEntries = [];
      }
      try {
        purgedIds = await activePurgedIds(sp, root);
      } catch {
        purgedIds = [];
      }
      return {
        available: true,
        trashedIds: trashEntries.map((entry) => entry.id),
        purgedIds,
        trashCount: trashEntries.length
      };
    }
    let records = [];
    try {
      records = await serviceValue.listSessions();
    } catch (err) {
      warn(`session list failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        available: false,
        sessions: [],
        workspaces: wsList,
        trash: { count: 0, bytes: 0, entries: await readTrashEntries().catch(() => []) },
        canReset: false
      };
    }
    const list = Array.isArray(records) ? records : [];
    // 先读回收站再组装列表：删除后宿主可能仍把 live 会话留在内存里返回，
    // 这些 id 必须从列表里剔掉，否则会以「未分组」形态残留在界面上。
    let trashEntries = [];
    try {
      trashEntries = await readTrashEntries();
    } catch (err) {
      warn(`trash list failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const trashedIds = new Set(trashEntries.map((entry) => entry.id));
    let purgedIds = [];
    try {
      purgedIds = await activePurgedIds(sp, root);
    } catch {
      purgedIds = [];
    }
    const purgedSet = new Set(purgedIds);
    const ids = [];
    for (const record of list) {
      const id = record && record.header && record.header.id;
      if (typeof id === "string" && isSessionId(id) && !trashedIds.has(id) && !purgedSet.has(id)) ids.push(id);
    }
    const titles = await titlesFor(ids);
    const running = runningSet();
    const archived = archivedSet();
    const rows = [];
    const paired = [];
    for (const record of list) {
      const header = record && record.header;
      if (!header || typeof header.id !== "string") continue;
      const id = header.id;
      if (trashedIds.has(id) || purgedSet.has(id)) continue;
      // 兜底：live 会话目录已被移走（旧版物理回收站）时，宿主内存仍会返回该行。
      // 直接看物理日志是否存在，避免回收站元数据暂时不可读时又落回「未分组」。
      if (record.live === true && findLogFile(locatedDir(sp, header, root)) === "") continue;
      const ws = workspaceOf(header.cwd, id, wsList);
      const createdAt = header.createdAt !== undefined ? header.createdAt : 0;
      const row = {
        id,
        title: titles.get(id) || "",
        cwd: typeof header.cwd === "string" ? header.cwd : "",
        workspaceId: ws ? ws.id : "",
        workspaceTitle: ws ? ws.title : "",
        createdAt,
        updatedAt: createdAt,
        model: "",
        provider: "",
        messages: 0,
        turns: 0,
        tokens: 0,
        live: record.live === true,
        running: running.has(id),
        archived: archived.has(id),
        child: typeof header.parentSession === "string" && header.parentSession !== ""
      };
      rows.push(row);
      paired.push({ row, record });
    }
    if (!lean) await enrichRows(paired);
    const sorted = sortSessionsNewestFirst(rows);
    const trashBytes = trashEntries.reduce((sum, entry) => sum + (Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : 0), 0);
    return {
      available: true,
      sessions: sorted,
      workspaces: wsList,
      trash: {
        count: trashEntries.length,
        bytes: trashBytes,
        entries: trashEntries
      },
      trashedIds: trashEntries.map((entry) => entry.id),
      purgedIds,
      canReset: true
    };
  }

  // -------------------------------------------------------------------------
  // 目录搬移
  // -------------------------------------------------------------------------

  async function moveDirectory(source, target) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (err) {
      if (!err || err.code !== "EXDEV") throw err;
    }
    await fsp.cp(source, target, { recursive: true, errorOnExist: true, force: false });
    await fsp.rm(source, { recursive: true, force: true });
  }

  /**
   * 宿主自己的路径编码入口。移动时必须用它同时算出源 / 目标路径，
   * 否则插件自研的 projectKey 一旦与宿主不同，日志就会写到宿主扫不到的目录。
   */
  function locateLogPath(sp, header) {
    try {
      if (sp && typeof sp.locate === "function") {
        const located = sp.locate(header);
        if (located && typeof located.path === "string" && located.path !== "") return located.path;
      }
    } catch {
      /* 旧宿主没有 locate：回退到公开的命名约定 */
    }
    return "";
  }

  function locatedDir(sp, header, fallbackRoot) {
    const logPath = locateLogPath(sp, header);
    if (logPath !== "") return path.dirname(logPath);
    return sessionDirOf(fallbackRoot, header.cwd, header.id);
  }

  function insideRoot(root, dir) {
    return isContainedPath(root, dir) && normalizePathKey(root) !== normalizePathKey(dir);
  }

  // -------------------------------------------------------------------------
  // 工作区成员同步
  // -------------------------------------------------------------------------

  async function detachFromWorkspaces(sessionId) {
    const serviceValue = registry();
    if (!serviceValue) return false;
    let touched = false;
    try {
      for (const entity of serviceValue.list()) {
        if (!entity || !Array.isArray(entity.sessionIds) || !entity.sessionIds.includes(sessionId)) continue;
        if (typeof entity.detachSession !== "function") continue;
        try {
          await entity.detachSession(sessionId);
          touched = true;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    // 清理宿主内存索引，避免「文件已不在原处、侧边栏仍命中」。
    for (const key of ["sessionPaths", "missingSessionPaths", "headers"]) {
      const map = serviceValue[key];
      if (map && typeof map.delete === "function") {
        try {
          map.delete(sessionId);
        } catch {
          /* ignore */
        }
      }
    }
    return touched;
  }

  /**
   * 把会话挂到目标工作区。
   *
   * `sessionPaths` 的语义是「会话所属工作区的规范路径」，不是会话日志目录；
   * 宿主的 `entity.sessionIds` 会用 `sessionPaths.get(id) === entity.path`
   * 过滤成员，写错就会让会话从分组里消失、掉进「未分组」。
   */
  async function attachToWorkspace(sessionId, header, workspacePath) {
    const serviceValue = registry();
    if (!serviceValue) return false;
    const canonical = typeof workspacePath === "string" && workspacePath !== ""
      ? workspacePath
      : (header && typeof header.cwd === "string" ? header.cwd : "");
    try {
      if (serviceValue.headers && typeof serviceValue.headers.set === "function") {
        serviceValue.headers.set(sessionId, header);
      }
      if (serviceValue.sessionPaths && typeof serviceValue.sessionPaths.set === "function") {
        serviceValue.sessionPaths.set(sessionId, canonical);
      }
      if (serviceValue.missingSessionPaths && typeof serviceValue.missingSessionPaths.delete === "function") {
        serviceValue.missingSessionPaths.delete(sessionId);
      }
    } catch {
      /* 旧宿主没有这些内部索引：交给重启后的启动索引 */
    }
    const key = normalizePathKey(canonical);
    for (const entity of serviceValue.list()) {
      if (!entity || normalizePathKey(entity.path) !== key) continue;
      if (typeof entity.attachSession !== "function") return false;
      try {
        await entity.attachSession(sessionId);
      } catch (err) {
        warn(`could not attach session "${sessionId}" to workspace: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      // attachSession 在「记录里已存在该 id」时会跳过写入；再用 sessionIds 确认一次。
      const ids = Array.isArray(entity.sessionIds) ? entity.sessionIds : [];
      if (!ids.includes(sessionId)) {
        warn(`workspace "${key}" did not accept session "${sessionId}" after attach`);
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * 宿主的工作区索引是启动时扫描建立的。恢复后主动触发它的重建入口，
   * 把 headers / sessionPaths / missingSessionPaths 全部按磁盘现状重算。
   */
  async function refreshRegistryIndex() {
    const serviceValue = registry();
    if (!serviceValue) return false;
    try {
      if (typeof serviceValue.listStoredHeaders === "function"
        && typeof serviceValue.replaceHeaderIndex === "function") {
        const headers = await serviceValue.listStoredHeaders();
        await serviceValue.replaceHeaderIndex(headers);
        if (typeof serviceValue.indexLiveSessions === "function") await serviceValue.indexLiveSessions();
        return true;
      }
    } catch (err) {
      warn(`registry index refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }

  async function unarchive(sessionId) {
    const serviceValue = registry();
    if (!serviceValue || typeof serviceValue.unarchiveSession !== "function") return;
    try {
      await serviceValue.unarchiveSession(sessionId);
    } catch {
      /* ignore */
    }
  }

  function recordOf(records, id) {
    for (const record of Array.isArray(records) ? records : []) {
      if (record && record.header && record.header.id === id) return record;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 删除到回收站
  // -------------------------------------------------------------------------

  async function removeToTrash(ids) {
    const sp = persistence();
    const queryService = query();
    const root = sessionRoot();
    if (!sp || !queryService || root === "") {
      return ids.map((id) => failureOf(id, "TRASH_UNAVAILABLE"));
    }
    const records = await queryService.listSessions().catch((err) => {
      warn(`session list failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!records) return ids.map((id) => failureOf(id, "TRASH_UNAVAILABLE"));
    const wsList = workspaces();
    const titles = await titlesFor(ids).catch(() => new Map());
    let trash = "";
    try {
      trash = await ensureTrashRoot();
    } catch (err) {
      warn(`trash root is unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return ids.map((id) => failureOf(id, "TRASH_UNAVAILABLE"));
    }
    const results = [];
    for (const id of ids) {
      if (!isSessionId(id)) {
        results.push(failureOf(id, "INVALID_REQUEST"));
        continue;
      }
      const record = recordOf(records, id);
      if (!record) {
        results.push(failureOf(id, "TARGET_NOT_FOUND"));
        continue;
      }
      // 只拒绝「正在生成」的会话。仅被宿主打开（live）的会话可以删除：
      // 软回收站只写索引，不碰日志，因此对写句柄完全无影响。
      if (record.running === true || runningSet().has(id)) {
        results.push(failureOf(id, "SESSION_RUNNING"));
        continue;
      }
      let staging = "";
      try {
        const snapshot = await sp.stat(id);
        if (!snapshot || !snapshot.header) {
          results.push(failureOf(id, "TARGET_NOT_FOUND"));
          continue;
        }
        const header = snapshot.header;
        const sourceDir = locatedDir(sp, header, root);
        if (!insideRoot(root, sourceDir) || !isDirectory(sourceDir) || findLogFile(sourceDir) === "") {
          results.push(failureOf(id, "TARGET_NOT_FOUND"));
          continue;
        }
        const workspace = workspaceOf(header.cwd, id, wsList) || workspaceOf(record.header.cwd, id, wsList);
        const trashId = "trash-" + Date.now().toString(36) + "-" + randomUUID();
        staging = path.join(trash, trashId);
        if (!isContainedPath(trash, staging)) {
          results.push(failureOf(id, "INTERNAL"));
          continue;
        }
        await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
        const meta = {
          version: TRASH_META_VERSION,
          trashId,
          id,
          deletedAt: Date.now(),
          title: (titles.get(id) || "").slice(0, MAX_TITLE_LENGTH),
          header,
          originalDir: sourceDir,
          sizeBytes: Number.isFinite(snapshot.sizeBytes) ? snapshot.sizeBytes : 0,
          workspaceId: workspace ? workspace.id : "",
          workspaceTitle: workspace ? workspace.title : ""
        };
        const metaPath = path.join(staging, TRASH_META_FILE);
        const tempPath = metaPath + ".tmp";
        await fsp.writeFile(tempPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
        await fsp.rename(tempPath, metaPath);
        // 软回收站：日志留在原工作区目录，不动文件、不解除工作区成员关系。
        // 这样恢复只需删索引，宿主侧栏无需重新挂载即可立刻显示；
        // 也不会因为把文件移出工作区而落入 DSH 的「未分组」。
        await removeTombstone(id);
        forgetTitle(id);
        results.push(resultOf(id, { trashId, soft: true, restartRequired: false }));
      } catch (err) {
        if (staging !== "") await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
        results.push(failureOf(id, "WRITE_FAILED", err instanceof Error ? err.message : String(err)));
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // 恢复
  // -------------------------------------------------------------------------

  async function restore(trashIds) {
    const sp = persistence();
    const root = sessionRoot();
    if (!sp || root === "") return trashIds.map((id) => failureOf(id, "TRASH_UNAVAILABLE"));
    const results = [];
    for (const trashId of trashIds) {
      const entry = await entryFor(trashId);
      if (!entry) {
        results.push(failureOf(trashId, "TRASH_NOT_FOUND"));
        continue;
      }
      const { meta, dir, sessionDir, soft } = entry;
      const targetDir = locatedDir(sp, meta.header, root);
      if (!insideRoot(root, targetDir)) {
        results.push(failureOf(trashId, "INTERNAL"));
        continue;
      }
      // 软回收站：日志从未离开原工作区，恢复 = 删除索引。
      // 不移动文件、不重新挂载工作区，宿主侧栏行当场恢复，无需重启。
      if (soft) {
        if (!isDirectory(targetDir) || findLogFile(targetDir) === "" || !(await logBelongsTo(targetDir, meta.id))) {
          results.push(failureOf(trashId, "TRASH_LOG_MISSING"));
          continue;
        }
        try {
          await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
          await removeTombstone(meta.id);
          forgetTitle(meta.id);
          results.push(resultOf(trashId, {
            sessionId: meta.id,
            title: meta.title,
            soft: true,
            restartRequired: false
          }));
        } catch (err) {
          results.push(failureOf(trashId, "WRITE_FAILED", err instanceof Error ? err.message : String(err)));
        }
        continue;
      }
      // 旧版物理回收站：日志曾被移到 session/ 子目录，需要移回原工作区并重新挂载。
      if (fs.existsSync(targetDir)) {
        results.push(failureOf(trashId, "TRASH_CONFLICT"));
        continue;
      }
      try {
        await fsp.mkdir(path.dirname(targetDir), { recursive: true, mode: 0o700 });
        await moveDirectory(sessionDir, targetDir);
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        await removeTombstone(meta.id);
        await unarchive(meta.id);
        const attached = await attachToWorkspace(meta.id, meta.header, meta.header.cwd);
        if (attached) await refreshRegistryIndex();
        forgetTitle(meta.id);
        results.push(resultOf(trashId, {
          sessionId: meta.id,
          title: meta.title,
          soft: false,
          restartRequired: !attached
        }));
      } catch (err) {
        results.push(failureOf(trashId, "WRITE_FAILED", err instanceof Error ? err.message : String(err)));
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // 彻底清理
  // -------------------------------------------------------------------------

  async function purge(trashIds, all) {
    const sp = persistence();
    const root = trashRoot();
    const sessionRootPath = sessionRoot();
    if (root === "") return { results: trashIds.map((id) => failureOf(id, "TRASH_UNAVAILABLE")) };
    let targets = trashIds;
    if (all) {
      try {
        targets = (await readTrashEntries()).map((entry) => entry.trashId);
      } catch {
        targets = [];
      }
    }
    const running = runningSet();
    const results = [];
    for (const trashId of targets) {
      const entry = await entryFor(trashId);
      if (!entry) {
        results.push(failureOf(trashId, "TRASH_NOT_FOUND"));
        continue;
      }
      if (!isContainedPath(root, entry.dir)) {
        results.push(failureOf(trashId, "INTERNAL"));
        continue;
      }
      const sessionId = entry.meta.id;
      if (running.has(sessionId)) {
        results.push(failureOf(trashId, "SESSION_RUNNING"));
        continue;
      }
      try {
        if (entry.soft) {
          const targetDir = sessionRootPath === "" ? "" : locatedDir(sp, entry.meta.header, sessionRootPath);
          // 只删除能确认属于该会话的目录，绝不动来源不明的路径。
          if (!insideRoot(sessionRootPath, targetDir) || !(await logBelongsTo(targetDir, sessionId))) {
            results.push(failureOf(trashId, "TRASH_LOG_MISSING"));
            continue;
          }
          await fsp.rm(targetDir, { recursive: true, force: true });
          await detachFromWorkspaces(sessionId);
          await unarchive(sessionId);
          forgetTitle(sessionId);
          await addTombstone(entry.meta.header);
          await fsp.rm(entry.dir, { recursive: true, force: true });
        } else {
          await fsp.rm(entry.dir, { recursive: true, force: true });
          await detachFromWorkspaces(sessionId);
          await unarchive(sessionId);
          forgetTitle(sessionId);
          await addTombstone(entry.meta.header);
        }
        results.push(resultOf(trashId, { sessionId, soft: entry.soft }));
      } catch (err) {
        results.push(failureOf(trashId, "WRITE_FAILED", err instanceof Error ? err.message : String(err)));
      }
    }
    return { results };
  }

  /**
   * 批量归档：逐条独立执行；已归档的会话视为成功（宿主归档是幂等的）。
   * 正在生成回复的会话按 SESSION_RUNNING 单独失败，其余继续。
   */
  async function archive(ids) {
    const serviceValue = registry();
    if (!serviceValue || typeof serviceValue.archiveSession !== "function") {
      return { results: ids.map((id) => failureOf(id, "ARCHIVE_UNAVAILABLE")) };
    }
    const queryService = query();
    const records = queryService
      ? await queryService.listSessions().catch((err) => {
          warn(`session list failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        })
      : null;
    const running = runningSet();
    const results = [];
    for (const id of ids) {
      if (!isSessionId(id)) {
        results.push(failureOf(id, "INVALID_REQUEST"));
        continue;
      }
      if (running.has(id)) {
        results.push(failureOf(id, "SESSION_RUNNING"));
        continue;
      }
      if (!records || !recordOf(records, id)) {
        results.push(failureOf(id, "TARGET_NOT_FOUND"));
        continue;
      }
      try {
        await serviceValue.archiveSession(id);
        forgetTitle(id);
        results.push(resultOf(id, { sessionId: id }));
      } catch (err) {
        const code = err && err.name === "WorkspaceUnknownSessionError"
          ? "TARGET_NOT_FOUND"
          : err && err.name === "WorkspaceActiveSessionError"
            ? "SESSION_RUNNING"
            : "WRITE_FAILED";
        results.push(failureOf(id, code, err instanceof Error ? err.message : String(err)));
      }
    }
    return { results };
  }

  // -------------------------------------------------------------------------
  // 审计清理：移除上次崩溃残留的 _staging-* 目录
  // -------------------------------------------------------------------------

  async function sweepStaging() {
    const root = trashRoot();
    if (root === "") return;
    try {
      const dirents = await fsp.readdir(root, { withFileTypes: true });
      for (const dirent of dirents) {
        if (!dirent.isDirectory() || !dirent.name.startsWith(STAGING_PREFIX)) continue;
        const dir = path.join(root, dirent.name);
        if (!isContainedPath(root, dir)) continue;
        // 只清理超过一小时的残留，避免多开宿主时删掉另一个实例正在用的暂存目录。
        try {
          const info = await fsp.stat(dir);
          if (Date.now() - info.mtimeMs < 3600000) continue;
        } catch {
          continue;
        }
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    } catch {
      /* 回收站尚未创建 */
    }
  }

  return { payload, removeToTrash, restore, purge, archive, unarchive, sweepStaging };
}
