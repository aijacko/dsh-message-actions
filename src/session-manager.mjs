// dsh-message-actions — 会话管理（删除到回收站 / 恢复 / 彻底清理 / 移动到工作区）。
//
// 数据源与写入都走宿主官方服务：
//   - sessionQuery.listSessions / readSession / readTitleSnapshots：枚举与正文；
//   - sessionPersistence.open / create / append / stat：删除、恢复与迁移日志；
//   - workspaceRegistry：工作区分组、归档集与成员关系。
//
// 删除采用「整目录移入回收站」而不是删文件：恢复时原样移回，宿主无需迁移格式。
// 移动工作区采用「原日志迁移 + 只改写首行 header」：把会话目录从源项目目录
// 移到目标项目目录，再复制日志并替换首行 cwd。这样不调用
// `sessionPersistence.create`，避开「会话在 UI 中打开、宿主仍持有写句柄」
// 时抛出的 SessionAlreadyExistsError（真机移动失败并回滚的真实原因）。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import pure from "./sessions.cjs";

const {
  isSessionId,
  isWorkspaceId,
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
// 会话日志读取 / 改写（移动工作区时保留原事件字节）
// ---------------------------------------------------------------------------

const LOG_NAME_RE = /^session\.v\d+\.jsonl(?:\.zstd)?$/;
const ZSTD_MAGIC = 0x28b52ffd;
const zstdDecompressSync = typeof zlib.zstdDecompressSync === "function" ? zlib.zstdDecompressSync : null;
const zstdCompressSync = typeof zlib.zstdCompressSync === "function" ? zlib.zstdCompressSync : null;
const zstdDecompress = typeof zlib.zstdDecompress === "function" ? promisify(zlib.zstdDecompress) : null;
const zstdCompress = typeof zlib.zstdCompress === "function" ? promisify(zlib.zstdCompress) : null;
// 宿主的日志写入器给每一帧都带校验和；改写首帧时保持一致，避免行为差异。
const ZSTD_CHECKSUM_FLAG = typeof zlib.constants === "object" ? zlib.constants.ZSTD_c_checksumFlag : undefined;
const ZSTD_HEADER_OPTS = ZSTD_CHECKSUM_FLAG === undefined ? undefined : { params: { [ZSTD_CHECKSUM_FLAG]: 1 } };

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

async function compressZstdBuffer(buf) {
  try {
    if (zstdCompressSync) return ZSTD_HEADER_OPTS ? zstdCompressSync(buf, ZSTD_HEADER_OPTS) : zstdCompressSync(buf);
    if (zstdCompress) return Buffer.from(await zstdCompress(buf, ZSTD_HEADER_OPTS));
  } catch (err) {
    throw Object.assign(new Error(`could not encode session log: ${err instanceof Error ? err.message : String(err)}`), { code: "LOG_ENCODE_FAILED" });
  }
  throw Object.assign(new Error("zstd logs are not supported by this runtime"), { code: "ZSTD_UNAVAILABLE" });
}

function parseHeaderLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// 宿主 v4 header 的合法字段集（见 dsh-session-persistence-jsonl 的 HEADER_KEYS）。
// 旧版移动把 query 的 meta 直接写成 header，会丢掉 `type: "session"` 或混入
// `title` 等额外字段，宿主校验失败后整份日志被判为 corrupt，打开即
// `session/not-found`。迁移时按该白名单重整 header。
const SESSION_HEADER_KEYS = new Set([
  "type",
  "version",
  "id",
  "createdAt",
  "isSeeded",
  "delegationDepth",
  "cwd",
  "parentSession",
  "origin",
  "agentPreset"
]);

/** 只保留宿主允许的 header 字段，并补回旧版丢失的 `type`。 */
function sanitizeHeader(header) {
  const out = {};
  for (const key of Object.keys(header)) {
    if (SESSION_HEADER_KEYS.has(key)) out[key] = header[key];
  }
  if (out.type !== "session") out.type = "session";
  return out;
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

function countEvents(rest) {
  if (rest === "") return 0;
  return rest.split("\n").filter((line) => line.trim() !== "").length;
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

/** 统计一份多帧 zstd 日志里的事件行数（首帧的首行是 header，不算事件）。 */
async function countZstdEvents(buf, frames) {
  let count = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const text = (await decompressZstdBuffer(buf.subarray(frame.start, frame.end))).toString("utf8");
    const lines = text.split("\n");
    for (let line = index === 0 ? 1 : 0; line < lines.length; line += 1) {
      if (lines[line].trim() !== "") count += 1;
    }
  }
  return count;
}

function parseHeaderOrThrow(line, nextHeader) {
  const header = parseHeaderLine(line);
  if (!header || header.id !== nextHeader.id) {
    throw Object.assign(new Error("source log header does not match the session being moved"), { code: "LOG_VERIFY_FAILED" });
  }
  return header;
}

/**
 * 把源目录里的日志写到目标目录，只改写 header 的 cwd。
 *
 * zstd 日志按「帧」处理：仅重新压缩首帧（header），首帧之后的所有字节
 * 原样拼接。宿主日志是多帧拼接，Node 的 zstd 解压只看首帧；旧的
 * 「整段解压再压缩」会把首帧之后的事件全部丢掉。
 *
 * 明文 JSONL（测试桩 / 旧格式）仍按行处理。
 */
async function relocateLog(sourceDir, targetDir, nextHeader) {
  const sourceFile = findLogFile(sourceDir);
  if (sourceFile === "") {
    throw Object.assign(new Error(`session log not found in ${sourceDir}`), { code: "LOG_NOT_FOUND" });
  }
  const buf = await fsp.readFile(sourceFile);
  const targetFile = path.join(targetDir, path.basename(sourceFile));
  await fsp.mkdir(targetDir, { recursive: true, mode: 0o700 });

  if (!isZstdBuffer(buf)) {
    const text = buf.toString("utf8");
    const { firstLine, rest } = splitLogText(text);
    const header = parseHeaderOrThrow(firstLine, nextHeader);
    const eventCount = countEvents(rest);
    const nextHeaderObj = Object.assign(sanitizeHeader(header), { cwd: nextHeader.cwd });
    const data = Buffer.from(JSON.stringify(nextHeaderObj) + "\n" + rest, "utf8");
    await fsp.writeFile(targetFile, data, { mode: 0o600 });
    const verify = splitLogText(fs.readFileSync(targetFile, "utf8"));
    const verifyHeader = parseHeaderLine(verify.firstLine);
    if (!verifyHeader || verifyHeader.id !== nextHeader.id
      || verifyHeader.type !== "session"
      || normalizePathKey(verifyHeader.cwd) !== normalizePathKey(nextHeader.cwd)
      || verify.rest !== rest) {
      throw Object.assign(new Error("moved log did not verify at the target workspace"), { code: "LOG_VERIFY_FAILED" });
    }
    return { file: targetFile, header: nextHeaderObj, eventCount, compressed: false, frames: 0, bytes: data.length };
  }

  // ---- zstd：只重写首帧，保留其余所有帧的字节 ----
  const scan = scanZstdFrames(buf);
  if (scan.frames.length === 0 || scan.tornStart !== undefined) {
    throw Object.assign(new Error("source session log has an invalid Zstandard frame layout"), { code: "LOG_FORMAT_INVALID" });
  }
  const frames = scan.frames;
  const first = frames[0];
  const firstText = (await decompressZstdBuffer(buf.subarray(first.start, first.end))).toString("utf8");
  const firstLines = firstText.split("\n");
  const header = parseHeaderOrThrow(firstLines[0] || "", nextHeader);
  const nextHeaderObj = Object.assign(sanitizeHeader(header), { cwd: nextHeader.cwd });
  const tail = buf.subarray(first.end);

  // 兼容旧错误实现：若首帧里还被塞进了事件行，把它们单独成帧，避免丢弃。
  const salvage = firstLines.slice(1).filter((line) => line.trim() !== "");
  const salvageFrames = [];
  for (const line of salvage) {
    salvageFrames.push(await compressZstdBuffer(Buffer.from(line + "\n", "utf8")));
  }

  const sourceEventCount = await countZstdEvents(buf, frames);
  const newFrame0 = await compressZstdBuffer(Buffer.from(JSON.stringify(nextHeaderObj) + "\n", "utf8"));
  const data = Buffer.concat([newFrame0, ...salvageFrames, tail]);
  await fsp.writeFile(targetFile, data, { mode: 0o600 });

  // 读回校验：帧结构合法、首帧 header 正确、尾帧字节完全一致、事件数不减。
  const verifyBuf = fs.readFileSync(targetFile);
  const verify = scanZstdFrames(verifyBuf);
  const expectedFrames = 1 + salvageFrames.length + (frames.length - 1);
  if (verify.frames.length === 0 || verify.tornStart !== undefined || verify.frames.length !== expectedFrames) {
    throw Object.assign(new Error("moved log frame layout did not verify"), { code: "LOG_VERIFY_FAILED" });
  }
  const verifyHeader = parseHeaderLine(
    (await decompressZstdBuffer(verifyBuf.subarray(verify.frames[0].start, verify.frames[0].end))).toString("utf8").split("\n")[0]
  );
  if (!verifyHeader || verifyHeader.id !== nextHeader.id
    || verifyHeader.type !== "session"
    || normalizePathKey(verifyHeader.cwd) !== normalizePathKey(nextHeader.cwd)) {
    throw Object.assign(new Error("moved log header did not verify at the target workspace"), { code: "LOG_VERIFY_FAILED" });
  }
  if (tail.length > 0 && !verifyBuf.subarray(verifyBuf.length - tail.length).equals(tail)) {
    throw Object.assign(new Error("moved log tail bytes changed"), { code: "LOG_VERIFY_FAILED" });
  }
  const eventCount = await countZstdEvents(verifyBuf, verify.frames);
  if (eventCount !== sourceEventCount) {
    throw Object.assign(new Error(`moved log lost events: ${sourceEventCount} -> ${eventCount}`), { code: "LOG_VERIFY_FAILED" });
  }
  return {
    file: targetFile,
    header: nextHeaderObj,
    eventCount,
    compressed: true,
    frames: verify.frames.length,
    salvaged: salvage.length,
    bytes: data.length
  };
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

function firstStackLine(err) {
  const stack = err && typeof err.stack === "string" ? err.stack : "";
  if (stack === "") return "";
  return stack.split("\n")[0] || "";
}

function errorCodeOf(err) {
  const code = err && typeof err.code === "string" ? err.code : "";
  return /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "";
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
   * `lean` 只用于侧栏菜单的即时可用性判断（工作区 / canMove），
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
        canMove: false,
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
        canMove: false,
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
      canMove: typeof sp.stat === "function",
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

  /**
   * 宿主内存里若仍保留移动前的 header.cwd，`locate` 会指向已不存在的旧目录；
   * 这时按目录名（宿主启动扫描的同一套编码）在根下扫一遍，找到真正的源目录。
   */
  function findSessionDirOnDisk(root, sessionId) {
    let projectDirs;
    try {
      projectDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return "";
    }
    const leaf = path.basename(sessionDirOf(root, root, sessionId));
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, leaf);
      if (isDirectory(candidate)) return candidate;
    }
    return "";
  }

  /** 把源会话目录里除日志以外的附属文件复制到新目录（日志已按帧原样迁移）。 */
  async function copyArtifacts(sourceDir, targetDir) {
    let dirents;
    try {
      dirents = await fsp.readdir(sourceDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith("session.v") && dirent.name.includes(".jsonl")) continue;
      const from = path.join(sourceDir, dirent.name);
      const to = path.join(targetDir, dirent.name);
      if (!isContainedPath(sourceDir, from) || !isContainedPath(targetDir, to)) continue;
      try {
        await fsp.cp(from, to, { recursive: dirent.isDirectory(), force: true, errorOnExist: false });
      } catch (err) {
        warn(`could not copy session artifact "${dirent.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
   * 把宿主内存里的 live 会话对象与持久化层的写状态重定向到新 cwd。
   * 宿主的 `workspaceRegistry.readSessionHeader()` 会优先读 live header；
   * 若不改，attachSession 会因为 cwd 仍指向源工作区而拒绝。
   */
  function redirectLiveSession(sessionId, header, workspacePath) {
    const sessions = service("sessions");
    let live = false;
    let object = null;
    try {
      if (sessions && typeof sessions.get === "function") object = sessions.get(sessionId) || null;
    } catch {
      object = null;
    }
    if (object) {
      live = true;
      try { object.header = header; } catch { /* ignore */ }
      try { object.meta = header; } catch { /* ignore */ }
      try { object.cwd = workspacePath; } catch { /* ignore */ }
    }
    const sp = persistence();
    let state = false;
    try {
      const entry = sp && sp.states && typeof sp.states.get === "function" ? sp.states.get(sessionId) : null;
      if (entry && entry.meta && typeof entry.meta === "object") {
        entry.meta = Object.assign({}, entry.meta, { cwd: workspacePath });
        state = true;
      }
    } catch {
      /* 旧宿主没有 states：只靠 live 对象本身 */
    }
    return { live, state, object };
  }

  /**
   * 宿主的工作区索引是启动时扫描建立的。移动后主动触发它的重建入口，
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

  /** 用宿主自己的 `stat` 读回磁盘 header，作为「宿主确实能定位到该会话」的证据。 */
  async function statHeaderOf(sp, sessionId) {
    try {
      if (!sp || typeof sp.stat !== "function") return null;
      const snapshot = await sp.stat(sessionId);
      return snapshot && snapshot.header ? snapshot.header : null;
    } catch {
      return null;
    }
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

  /** 宿主写句柄已被占用（会话在 UI 中打开）。这不阻止目录迁移，只影响写入声明。 */
  function isOwnershipConflict(err) {
    if (!err) return false;
    if (err.name === "SessionAlreadyOwnedError") return true;
    if (err.code === "SESSION_OWNED" || err.code === "SESSION_LIVE") return true;
    return /already owned by an active write handle/i.test(String(err.message || ""));
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

  // -------------------------------------------------------------------------
  // 移动到其他工作区
  // -------------------------------------------------------------------------

  async function move(sessionId, workspaceId) {
    const sp = persistence();
    const queryService = query();
    const root = sessionRoot();
    const serviceValue = registry();
    if (!sp || !queryService || root === "" || !serviceValue) {
      return { ok: false, error: "MOVE_UNAVAILABLE" };
    }
    const target = serviceValue.get(workspaceId);
    if (!target || typeof target.path !== "string") return { ok: false, error: "WORKSPACE_NOT_FOUND" };
    if (!isDirectory(target.path)) return { ok: false, error: "WORKSPACE_MISSING" };
    // 列表是「live + 磁盘」的合并结果，可能因为宿主内存里的旧 header 与磁盘
    // 不一致而失败，也可能暂时漏掉刚移动过的会话。因此列表只作首选，
    // 找不到时回退到宿主自己的 stat / readSession，避免误报「目标消息不存在」。
    let records = null;
    try {
      records = await queryService.listSessions();
    } catch (err) {
      warn(`could not list sessions before move: ${err instanceof Error ? err.message : String(err)}`);
    }
    let record = records ? recordOf(records, sessionId) : null;
    let header = record && record.header ? record.header : null;
    if (!header) header = await statHeaderOf(sp, sessionId);
    if (!header && typeof queryService.readSession === "function") {
      try {
        const read = await queryService.readSession(sessionId, 0);
        if (read && read.meta && typeof read.meta === "object") header = read.meta;
      } catch {
        /* fall through */
      }
    }
    if (!header) return { ok: false, error: "TARGET_NOT_FOUND" };
    // 只拒绝「正在生成回复」的会话。仅在 UI 中打开（live）的会话允许移动：
    // 移动迁移的是磁盘目录，不依赖宿主的写句柄。
    if ((record && record.running === true) || runningSet().has(sessionId)) {
      return { ok: false, error: "SESSION_RUNNING" };
    }
    const canonical = normalizePathKey(target.path);
    if (normalizePathKey(header.cwd) === canonical && isDirectory(locatedDir(sp, header, root))) {
      return { ok: true, moved: false, already: true };
    }

    const workspaceList = workspaces();
    const sourceWorkspace = workspaceOf(header.cwd, sessionId, workspaceList);
    let nextHeader = Object.assign({}, header, { cwd: target.path });
    let sourceDir = locatedDir(sp, header, root);
    // 目标目录也走宿主的 locate（它和启动扫描、打开会话用的是同一套编码）。
    // 只有旧宿主没有 locate 时才回退到本插件的命名约定。
    const locatedTargetPath = locateLogPath(sp, nextHeader);
    let targetDir = locatedTargetPath !== "" ? path.dirname(locatedTargetPath) : "";
    if (targetDir === "" || !insideRoot(root, targetDir)) {
      targetDir = sessionDirOf(root, target.path, sessionId);
    }
    let stage = "prepare";
    let claim = null;
    let backupDir = "";
    let staging = "";
    let movedSource = false;
    let wroteTarget = false;
    let attached = false;
    let redirect = { live: false, state: false };
    try {
      // 目标目录已被同名会话占用：先检查再动源目录，避免覆盖别人的会话。
      if (fs.existsSync(targetDir)) {
        throw Object.assign(new Error(`target session directory already exists: ${targetDir}`), { code: "TARGET_EXISTS" });
      }

      try {
        claim = await sp.open(sessionId, "write");
        await claim.close();
        claim = null;
      } catch (err) {
        if (!isOwnershipConflict(err)) throw err;
        // 会话在 UI 中打开、宿主持有写句柄：跳过写声明，直接迁移目录。
        // 与删除路径一致：写声明只保护日志追加，不阻止目录迁移。
      }

      stage = "locate";
      sourceDir = locatedDir(sp, header, root);
      if (!isDirectory(sourceDir)) {
        const scanned = findSessionDirOnDisk(root, sessionId);
        if (scanned !== "") sourceDir = scanned;
      }
      if (!insideRoot(root, sourceDir)) {
        throw Object.assign(new Error(`source session path is outside the session root: ${sourceDir}`), { code: "SOURCE_OUTSIDE_ROOT" });
      }
      if (!isDirectory(sourceDir)) {
        throw Object.assign(new Error(`source session directory is missing: ${sourceDir}`), { code: "LOG_NOT_FOUND" });
      }

      stage = "stage";
      const trash = await ensureTrashRoot();
      staging = path.join(trash, STAGING_PREFIX + randomUUID());
      if (!isContainedPath(trash, staging)) {
        throw Object.assign(new Error("staging path is outside the trash root"), { code: "INTERNAL" });
      }
      await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
      backupDir = path.join(staging, TRASH_SESSION_DIR);

      stage = "move-source";
      await moveDirectory(sourceDir, backupDir);
      movedSource = true;

      // 不调用 sp.create（live 会话会抛 SessionAlreadyExistsError）：只重写日志
      // 首帧的 header.cwd，首帧之后的事件字节原样保留。
      stage = "write-target";
      wroteTarget = true;
      const relocated = await relocateLog(backupDir, targetDir, nextHeader);
      nextHeader = relocated.header;

      stage = "copy-artifacts";
      await copyArtifacts(backupDir, targetDir);

      // 源工作区先摘除，再重定向 live 状态，最后挂到目标并刷新宿主索引。
      stage = "index";
      for (const entity of serviceValue.list()) {
        if (!entity || !Array.isArray(entity.sessionIds) || !entity.sessionIds.includes(sessionId)) continue;
        try {
          await entity.detachSession(sessionId);
        } catch {
          /* ignore */
        }
      }
      // 必须在 attachSession 之前改：宿主的 readSessionHeader() 会优先读 live header。
      redirect = redirectLiveSession(sessionId, nextHeader, target.path);
      const attachSupported = typeof target.attachSession === "function";
      attached = await attachToWorkspace(sessionId, nextHeader, target.path);
      if (attachSupported && !attached) {
        throw Object.assign(new Error(`workspace did not accept the moved session: ${target.path}`), { code: "INDEX_ATTACH_FAILED" });
      }
      const indexRefreshed = await refreshRegistryIndex();

      // 用宿主自己的 stat 走一遍它打开会话时的查找路径，确认磁盘 header 与索引一致。
      const persisted = await statHeaderOf(sp, sessionId);
      if (!persisted || persisted.id !== sessionId || normalizePathKey(persisted.cwd) !== canonical) {
        throw Object.assign(new Error("host could not locate the moved session after relocation"), { code: "LOG_VERIFY_FAILED" });
      }
      const targetMember = Array.isArray(target.sessionIds) ? target.sessionIds.includes(sessionId) : null;
      let sourceStillMember = false;
      if (sourceWorkspace && typeof serviceValue.get === "function") {
        const sourceEntity = serviceValue.get(sourceWorkspace.id);
        sourceStillMember = !!(sourceEntity && Array.isArray(sourceEntity.sessionIds)
          && sourceEntity.sessionIds.includes(sessionId));
      }

      stage = "cleanup";
      let backupCleaned = true;
      try {
        await fsp.rm(backupDir, { recursive: true, force: true });
      } catch (err) {
        backupCleaned = false;
        warn(`moved session "${sessionId}" but could not remove backup "${backupDir}": ${err instanceof Error ? err.message : String(err)}`);
      }
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      forgetTitle(sessionId);
      const evidence = {
        sourceDir,
        targetDir,
        locatedTargetPath: locateLogPath(sp, nextHeader),
        headerCwd: nextHeader.cwd,
        diskHeaderCwd: persisted.cwd,
        sessionPaths: serviceValue.sessionPaths && typeof serviceValue.sessionPaths.get === "function"
          ? serviceValue.sessionPaths.get(sessionId)
          : null,
        targetMember,
        sourceStillMember,
        indexWritten: attached,
        indexRefreshed,
        live: redirect.live,
        liveStateRedirected: redirect.state,
        eventCount: relocated.eventCount,
        frames: relocated.frames,
        salvaged: relocated.salvaged,
        compressed: relocated.compressed
      };
      // 把每一环的实际值写进日志，便于真机取证。
      warn(`move evidence: ${JSON.stringify(evidence)}`);
      return {
        ok: true,
        moved: true,
        sessionId,
        workspaceId,
        workspaceTitle: typeof target.title === "string" ? target.title : target.path,
        sourceWorkspaceId: sourceWorkspace ? sourceWorkspace.id : "",
        sourceDir,
        targetDir,
        headerCwd: nextHeader.cwd,
        eventCount: relocated.eventCount,
        compressed: relocated.compressed,
        frames: relocated.frames,
        salvaged: relocated.salvaged,
        indexWritten: attached,
        indexRefreshed,
        backupCleaned,
        evidence,
        // live 对象或写状态没能重定向时，后续追加写仍可能落到旧路径：提示重启。
        restartRequired: !attached || (redirect.live && !redirect.state)
      };
    } catch (err) {
      if (claim) {
        try {
          await claim.close();
        } catch {
          /* ignore */
        }
      }
      stage = stage || "unknown";
      let rollbackError = "";
      if (movedSource && backupDir !== "") {
        // 清掉本次已经生成的目标日志，再把原目录放回原处。
        if (wroteTarget) {
          try {
            await fsp.rm(targetDir, { recursive: true, force: true });
          } catch (cleanupError) {
            rollbackError = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            warn(`could not remove partially written target "${targetDir}": ${rollbackError}`);
          }
        }
        try {
          if (isDirectory(backupDir)) {
            await fsp.mkdir(path.dirname(sourceDir), { recursive: true, mode: 0o700 });
            await moveDirectory(backupDir, sourceDir);
          }
        } catch (restoreError) {
          rollbackError = restoreError instanceof Error ? restoreError.message : String(restoreError);
          warn(`could not roll back moved session "${sessionId}": ${rollbackError}`);
        }
        // 索引与 live 状态也要一起回滚，避免「文件恢复了、分组却还挂在目标工作区」。
        try {
          if (attached && typeof target.detachSession === "function") {
            await target.detachSession(sessionId);
          }
        } catch {
          /* ignore */
        }
        try {
          const sourcePath = sourceWorkspace && typeof sourceWorkspace.path === "string"
            ? sourceWorkspace.path
            : header.cwd;
          redirectLiveSession(sessionId, header, sourcePath);
          await attachToWorkspace(sessionId, header, sourcePath);
          await refreshRegistryIndex();
        } catch (indexError) {
          const text = indexError instanceof Error ? indexError.message : String(indexError);
          rollbackError = rollbackError === "" ? text : `${rollbackError}; ${text}`;
          warn(`could not roll back session index "${sessionId}": ${text}`);
        }
      }
      if (staging !== "") await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      const detail = {
        sessionId,
        workspaceId,
        workspaceTitle: typeof target.title === "string" ? target.title : target.path,
        sourceWorkspaceId: sourceWorkspace ? sourceWorkspace.id : "",
        sourceDir,
        targetDir,
        stage,
        name: err && err.name ? err.name : "Error",
        code: err && typeof err.code === "string" ? err.code : "",
        message: err instanceof Error ? err.message : String(err),
        stackLine: firstStackLine(err),
        rollbackError
      };
      warn(`move failed: ${JSON.stringify(detail)}`);
      return {
        ok: false,
        error: errorCodeOf(err) || "MOVE_FAILED",
        message: detail.message,
        detail
      };
    }
  }

  // -------------------------------------------------------------------------
  // 批量操作（移动 / 归档）
  // -------------------------------------------------------------------------

  /**
   * 批量移动：逐条独立执行，失败项不影响已成功项。
   * 每条结果都带 ok 标志，便于前端汇总「成功 n / 失败 m」。
   */
  async function moveMany(ids, workspaceId) {
    const results = [];
    for (const id of ids) {
      if (!isSessionId(id)) {
        results.push(failureOf(id, "INVALID_REQUEST"));
        continue;
      }
      let outcome;
      try {
        outcome = await move(id, workspaceId);
      } catch (err) {
        outcome = { ok: false, error: "MOVE_FAILED", message: err instanceof Error ? err.message : String(err) };
      }
      if (outcome && outcome.ok === true) {
        results.push(resultOf(id, {
          sessionId: id,
          workspaceId,
          workspaceTitle: outcome.workspaceTitle,
          already: outcome.already === true,
          restartRequired: outcome.restartRequired === true
        }));
      } else {
        const failure = failureOf(id, (outcome && outcome.error) || "MOVE_FAILED", outcome && outcome.message);
        if (outcome && outcome.detail) failure.detail = outcome.detail;
        results.push(failure);
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

  return { payload, removeToTrash, restore, purge, move, moveMany, archive, sweepStaging };
}
