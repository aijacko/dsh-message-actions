// 会话管理（删除到回收站 / 恢复 / 彻底清理 / 归档）的真实文件系统端到端测试。
//
// 用临时目录复制/合成会话目录，磁盘操作全部真实（mkdir、rename、rm），
// 仅把宿主的六个服务做成最小桩：sessionPersistence / sessionQuery /
// workspaceRegistry / agents / sessions / logger。
//
// 覆盖：冷会话删除、UI 中打开（live，写句柄被宿主占用）的会话删除、
// 运行中拒删、恢复、彻底清理、批量删除/恢复/清理、归档与取消归档、
// 「删除会话」开关（路由层 403）以及批量删除无 OK / 批量清理需 OK。

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { register } from "node:module";
import { createSessionManager } from "../src/session-manager.mjs";
import sessionsPure from "../src/sessions.cjs";

// 测试机没有安装宿主的 @deepseek-ai/schemastery，只用一个最小桩让
// src/index.mjs 可被真实导入（真实路由需要它做 Config 声明）。
const SCHEMASTERY_STUB = "function field(){const api={default:()=>api,min:()=>api,max:()=>api,volatile:()=>api};return api;}"
  + "export default {object:(value)=>value,boolean:field,number:field,string:field};";
const SCHEMASTERY_URL = "data:text/javascript," + encodeURIComponent(SCHEMASTERY_STUB);
register("data:text/javascript," + encodeURIComponent(
  "export async function resolve(specifier, context, next) {"
    + "if (specifier === '@deepseek-ai/schemastery') {"
    + "return { url: " + JSON.stringify(SCHEMASTERY_URL) + ", shortCircuit: true };"
    + "}"
    + "return next(specifier, context);"
    + "}"
));
const { makeSessionsHandler } = await import("../src/index.mjs");

const { sessionDirOf } = sessionsPure;
const LOG_NAME = "session.v4.jsonl.zstd";
const ZSTD_MAGIC = 0x28b52ffd;

function isZstd(buf) {
  return buf.length >= 4 && buf.readUInt32BE(0) === ZSTD_MAGIC;
}

function pathKey(value) {
  let key = path.resolve(String(value == null ? "" : value));
  if (process.platform === "win32") key = key.toLowerCase();
  return key.replace(/[\\/]+$/, "");
}

/** 与宿主一致的 zstd 帧扫描：日志由多个独立帧拼接而成。 */
function scanZstdFrames(buf) {
  const frames = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length || buf.readUInt32BE(pos) !== ZSTD_MAGIC) return { frames, tornStart: pos };
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
    if (!singleSegment) cursor += 1;
    cursor += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4;
    cursor += singleSegment ? [1, 2, 4, 8][fcsFlag] : [0, 2, 4, 8][fcsFlag];
    while (true) {
      if (cursor + 3 > buf.length) return { frames, tornStart: start };
      const header = buf[cursor] | (buf[cursor + 1] << 8) | (buf[cursor + 2] << 16);
      cursor += 3;
      const lastBlock = header & 1;
      const blockType = (header >> 1) & 3;
      const blockSize = header >> 3;
      if (blockType === 3) return { frames, tornStart: start };
      if (blockType === 1) cursor += 1;
      else {
        if (cursor + blockSize > buf.length) return { frames, tornStart: start };
        cursor += blockSize;
      }
      if (lastBlock) break;
    }
    if (checksumFlag) cursor += 4;
    if (cursor > buf.length) return { frames, tornStart: start };
    pos = cursor;
    frames.push({ start, end: pos });
  }
  return { frames, tornStart: undefined };
}

/** 真实宿主：整份日志是「首帧 header + 后续事件帧」，解压要逐帧拼起来。 */
function decodeLog(buf) {
  if (!isZstd(buf)) return buf.toString("utf8");
  const scan = scanZstdFrames(buf);
  if (scan.frames.length === 0 || scan.tornStart !== undefined) throw new Error("invalid zstd frame layout");
  return scan.frames.map((frame) => zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString("utf8")).join("");
}

/** 真实宿主写入格式：首帧只放 header，每行事件各自成帧。 */
function encodeLog(text, compressed) {
  if (!compressed) return Buffer.from(text, "utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const frames = [zlib.zstdCompressSync(Buffer.from(lines[0] + "\n", "utf8"))];
  for (const line of lines.slice(1)) {
    frames.push(zlib.zstdCompressSync(Buffer.from(line + "\n", "utf8")));
  }
  return Buffer.concat(frames);
}

function tempRoot() {
  return path.join(os.tmpdir(), `dma-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}

/**
 * 直接用真实会话路由处理器驱动一次请求（真实 req 流 + 假 res 收集响应）。
 * 用于验证「删除会话」开关的宿主侧拦截，而不是只测管理器内部函数。
 */
/** 精确控制请求头 / 方法 / 原始请求体，用于安全围栏验证。 */
function callRaw(handler, options) {
  return new Promise((resolve) => {
    const opts = options || {};
    const raw = opts.body === undefined ? "" : opts.body;
    const req = Readable.from(raw === "" ? [] : [Buffer.from(raw, "utf8")]);
    req.method = opts.method || "POST";
    req.url = opts.url || "/dsh-message-actions/sessions";
    req.headers = Object.assign({
      host: "127.0.0.1:1",
      origin: "http://127.0.0.1:1",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw))
    }, opts.headers || {});
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
        this.headersSent = true;
      },
      end(body) {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        resolve({ status: this.status, body: parsed, headers: this.headers });
      },
      destroy() {
        resolve({ status: 0, body: null, headers: null });
      }
    };
    handler(req, res).catch((err) => resolve({ status: -1, body: { error: String(err) }, headers: null }));
  });
}

function callRoute(handler, method, payload) {
  return new Promise((resolve) => {
    const raw = payload === undefined ? "" : JSON.stringify(payload);
    const req = Readable.from(raw === "" ? [] : [Buffer.from(raw, "utf8")]);
    req.method = method;
    req.url = "/dsh-message-actions/sessions";
    req.headers = {
      host: "127.0.0.1:1",
      origin: "http://127.0.0.1:1",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw))
    };
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
        this.headersSent = true;
      },
      end(body) {
        resolve({ status: this.status, body: JSON.parse(body), headers: this.headers });
      },
      destroy() {
        resolve({ status: 0, body: null, headers: null });
      }
    };
    handler(req, res).catch((err) => resolve({ status: -1, body: { error: String(err) }, headers: null }));
  });
}

/**
 * 忠实还原宿主的关键行为：
 *   - 日志是多帧 zstd（首帧 header、其余事件帧）；
 *   - `stat` / `open` 按磁盘扫描定位（不是内存缓存）；
 *   - 工作区成员的 `sessionIds` 按 `sessionPaths` 过滤（写错会掉进「未分组」）；
 *   - `attachSession` 会读 live header 并校验 cwd；
 *   - `replaceHeaderIndex` / `listStoredHeaders` / `indexLiveSessions` 是索引刷新入口。
 */
function makeHost(root, workspaces) {
  const owned = new Set();
  const running = new Set();
  const live = new Set();
  const liveObjects = new Map();
  const titles = new Map();
  const headers = new Map();
  const sessionPaths = new Map();
  const missingSessionPaths = new Map();
  const states = new Map();
  const locateCalls = [];

  const entityOf = (value) => {
    const key = pathKey(value);
    return ws.find((item) => pathKey(item.path) === key) || null;
  };

  const ws = workspaces.map((item) => ({
    id: item.id,
    title: item.title,
    path: item.path,
    _ids: [],
    get sessionIds() {
      return this._ids.filter((id) => pathKey(sessionPaths.get(id)) === pathKey(this.path) || missingSessionPaths.has(id));
    },
    async attachSession(id) {
      const header = readSessionHeader(id);
      if (!header) throw Object.assign(new Error(`unknown session ${id}`), { name: "WorkspaceUnknownSessionError" });
      if (pathKey(header.cwd) !== pathKey(this.path)) {
        throw Object.assign(
          new Error(`session ${id} cwd ${header.cwd} does not resolve to ${this.path}`),
          { name: "WorkspaceSessionPathMismatchError" }
        );
      }
      sessionPaths.set(id, this.path);
      missingSessionPaths.delete(id);
      if (!this._ids.includes(id)) this._ids.push(id);
    },
    async detachSession(id) {
      this._ids = this._ids.filter((value) => value !== id);
      if (sessionPaths.get(id) === this.path) sessionPaths.delete(id);
    }
  }));

  const dirOf = (header) => sessionDirOf(root, header.cwd, header.id);
  const fileOf = (header) => path.join(dirOf(header), LOG_NAME);

  function listRecords() {
    const out = [];
    if (!fs.existsSync(root)) return out;
    for (const projectDir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;
      const base = path.join(root, projectDir.name);
      for (const sessionDir of fs.readdirSync(base, { withFileTypes: true })) {
        if (!sessionDir.isDirectory() || !sessionDir.name.startsWith("session-")) continue;
        const logPath = path.join(base, sessionDir.name, LOG_NAME);
        if (!fs.existsSync(logPath)) continue;
        const text = decodeLog(fs.readFileSync(logPath));
        const header = JSON.parse(text.split("\n")[0]);
        // 宿主 listArtifacts 对非法 header 直接跳过（metadata undefined）；
        // 缺 type 或混入额外字段都会让 stat/open 报 corrupt → session/not-found。
        if (!isHostHeader(header)) continue;
        out.push({
          header,
          dir: path.join(base, sessionDir.name),
          live: live.has(header.id),
          running: running.has(header.id),
          events: text.split("\n").slice(1).filter(Boolean).map((line) => JSON.parse(line))
        });
      }
    }
    return out;
  }

  function diskHeader(id) {
    const record = listRecords().find((item) => item.header.id === id);
    return record ? record.header : null;
  }

  /** 宿主 readSessionHeader：live 优先，其次启动索引，最后扫描磁盘。 */
  function readSessionHeader(id) {
    const object = liveObjects.get(id);
    if (object && object.header) return object.header;
    if (headers.has(id)) return headers.get(id);
    return diskHeader(id);
  }

  function liveObjectOf(id) {
    if (!live.has(id)) return null;
    let object = liveObjects.get(id);
    if (object) return object;
    const header = readSessionHeader(id);
    if (!header) return null;
    object = {
      id,
      header: Object.assign({}, header),
      meta: Object.assign({}, header),
      cwd: header.cwd
    };
    liveObjects.set(id, object);
    states.set(id, { meta: Object.assign({}, header) });
    return object;
  }

  const persistence = {
    root,
    states,
    locate(header) {
      const located = fileOf(header);
      locateCalls.push({ id: header.id, cwd: header.cwd, path: located });
      return { path: located };
    },
    async open(id, mode) {
      const header = diskHeader(id) || readSessionHeader(id);
      if (!header) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      if (!fs.existsSync(fileOf(header)) && !live.has(id)) {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }
      if (mode === "write" && owned.has(id)) {
        const err = new Error(`session ${id} is already owned by an active write handle`);
        err.name = "SessionAlreadyOwnedError";
        err.sessionId = id;
        throw err;
      }
      return { async close() {}, async append() {}, async flush() {} };
    },
    async stat(id) {
      // 真实宿主按磁盘扫描定位；磁盘上不存在才是 not-found。
      const header = diskHeader(id);
      if (header) {
        return { header, sizeBytes: fs.statSync(fileOf(header)).size };
      }
      const object = liveObjectOf(id);
      return object ? { header: object.header, sizeBytes: 0 } : null;
    },
    async create(header) {
      if (owned.has(header.id)) {
        const err = new Error(`session ${header.id} is already owned by an active write handle`);
        err.name = "SessionAlreadyExistsError";
        throw err;
      }
      const dir = dirOf(header);
      await fsp.mkdir(dir, { recursive: true });
      const events = [];
      await fsp.writeFile(fileOf(header), JSON.stringify(header) + "\n", "utf8");
      return {
        async append(batch) {
          events.push(...batch);
        },
        async flush() {
          await fsp.appendFile(fileOf(header), events.map((event) => JSON.stringify(event) + "\n").join(""), "utf8");
        },
        async close() {}
      };
    }
  };

  const query = {
    async listSessions() {
      const out = listRecords().map((record) => ({ header: record.header, live: record.live, running: record.running }));
      const seen = new Set(out.map((record) => record.header.id));
      for (const id of live) {
        if (seen.has(id)) continue;
        const header = headers.get(id);
        if (!header) continue;
        out.push({ header, live: true, running: running.has(id) });
      }
      // 宿主 query 的投影索引可能仍知道一个 header 非法（corrupt）的会话：
      // 侧栏能列出标题，但 stat/open 会失败。日志确实在磁盘上才补这一行。
      for (const [id, header] of headers) {
        if (seen.has(id)) continue;
        if (!fs.existsSync(path.join(dirOf(header), LOG_NAME))) continue;
        out.push({ header, live: false, running: running.has(id) });
      }
      return out;
    },
    async readSession(id) {
      const record = listRecords().find((item) => item.header.id === id);
      return record ? { meta: record.header, events: record.events } : null;
    },
    async readTitleSnapshots(ids) {
      return ids.map((id) => ({
        status: "fulfilled",
        value: { title: titles.get(id) || "" }
      }));
    }
  };

  const registry = {
    archivedSessionIds: [],
    headers,
    sessionPaths,
    missingSessionPaths,
    locateCalls,
    list: () => ws,
    get: (id) => ws.find((item) => item.id === id),
    getOrigin: () => "http://127.0.0.1:1",
    async listStoredHeaders() {
      return listRecords().map((record) => record.header);
    },
    async replaceHeaderIndex(list) {
      headers.clear();
      sessionPaths.clear();
      missingSessionPaths.clear();
      for (const header of Array.isArray(list) ? list : []) {
        if (!header || !header.id) continue;
        headers.set(header.id, header);
        sessionPaths.set(header.id, path.resolve(header.cwd));
      }
    },
    async indexLiveSessions() {
      for (const [id, object] of liveObjects) {
        if (!object || !object.header) continue;
        headers.set(id, object.header);
        sessionPaths.set(id, path.resolve(object.header.cwd));
      }
    },
    async archiveSession(id) {
      const record = listRecords().find((item) => item.header.id === id);
      if (!record) throw Object.assign(new Error(`unknown session ${id}`), { name: "WorkspaceUnknownSessionError" });
      if (running.has(id)) throw Object.assign(new Error(`session ${id} is active`), { name: "WorkspaceActiveSessionError" });
      if (!this.archivedSessionIds.includes(id)) this.archivedSessionIds.push(id);
    },
    async unarchiveSession(id) {
      this.archivedSessionIds = this.archivedSessionIds.filter((value) => value !== id);
    }
  };

  const agents = {
    list: () => [...running].map((id) => ({ id, session: { id }, status: "running" }))
  };

  const ctx = {
    get(name) {
      if (name === "sessionPersistence") return persistence;
      if (name === "sessionQuery") return query;
      if (name === "workspaceRegistry") return registry;
      if (name === "agents") return agents;
      if (name === "sessions") return { get: (id) => liveObjectOf(id) };
      if (name === "logger") return { warn() {} };
      return null;
    }
  };

  /** 模拟宿主打开会话：只按磁盘扫描，不读内存索引。 */
  function hostOpen(id) {
    const record = listRecords().find((item) => item.header.id === id);
    return record ? { header: record.header, events: record.events, dir: record.dir } : null;
  }

  return {
    ctx, registry, persistence, query, owned, running, live, liveObjects, titles, headers,
    sessionPaths, states, locateCalls, entityOf, listRecords, hostOpen, readSessionHeader
  };
}

const HEADER_KEYS = new Set([
  "type", "version", "id", "createdAt", "isSeeded", "delegationDepth",
  "cwd", "parentSession", "origin", "agentPreset"
]);

/** 与宿主 isHeaderLine 一致：缺 type 或混入额外字段都会被判为 corrupt。 */
function isHostHeader(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !HEADER_KEYS.has(key))) return false;
  for (const key of ["type", "version", "id", "createdAt", "isSeeded", "delegationDepth"]) {
    if (!Object.hasOwn(value, key)) return false;
  }
  return value.type === "session"
    && typeof value.version === "number"
    && typeof value.id === "string"
    && Number.isSafeInteger(value.createdAt)
    && typeof value.isSeeded === "boolean"
    && typeof value.delegationDepth === "number"
    && (value.cwd === undefined || (typeof value.cwd === "string" && path.isAbsolute(value.cwd)));
}

function seedSession(host, { id, cwd, title, events = [], zstd = false }) {
  const header = {
    type: "session",
    version: 4,
    id,
    createdAt: 1000,
    cwd,
    isSeeded: false,
    delegationDepth: 0
  };
  const dir = sessionDirOf(host.persistence.root, cwd, id);
  fs.mkdirSync(dir, { recursive: true });
  const text = [JSON.stringify(header)].concat(events.map((event) => JSON.stringify(event))).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, LOG_NAME), encodeLog(text, zstd), "utf8");
  host.titles.set(id, title);
  host.headers.set(id, header);
  const entity = host.entityOf(cwd);
  if (entity) {
    host.sessionPaths.set(id, entity.path);
    if (!entity._ids.includes(id)) entity._ids.push(id);
  }
  return header;
}

async function main() {
  const root = tempRoot();
  const sessionsRoot = path.join(root, "sessions");
  const wsDirA = path.join(root, "ws-a");
  const wsDirB = path.join(root, "ws-b");
  for (const dir of [sessionsRoot, wsDirA, wsDirB]) fs.mkdirSync(dir, { recursive: true });

  const host = makeHost(sessionsRoot, [
    { id: "ws-a", title: "Work A", path: wsDirA },
    { id: "ws-b", title: "Work B", path: wsDirB },
    { id: "ws-deleted", title: "Deleted", path: path.join(root, "ws-deleted-missing") }
  ]);
  const manager = createSessionManager(host.ctx, {});
  const report = [];
  const check = (name, condition) => {
    assert.ok(condition, name);
    report.push(`PASS  ${name}`);
  };
  const note = (text) => {
    report.push(`INFO  ${text}`);
  };

  // 1. 冷会话删除（标题为「问」，验证特殊标题不受影响）
  const cold = seedSession(host, {
    id: "session-11111111-1111-4111-8111-111111111111",
    cwd: wsDirA,
    title: "问",
    events: [{ type: "user/message", data: { content: "问" } }]
  });
  const coldDir = sessionDirOf(sessionsRoot, wsDirA, cold.id);
  let result = await manager.removeToTrash([cold.id]);
  check("删除冷会话", result[0].ok === true);
  check("软回收站：日志留在原工作区", fs.existsSync(coldDir) && fs.existsSync(path.join(coldDir, LOG_NAME)));
  check("软回收站：恢复无需重启", result[0].soft === true && result[0].restartRequired === false);
  const trashRoot = path.join(root, "dsh-message-actions-trash");
  const trashEntry = path.join(trashRoot, result[0].trashId);
  const meta = JSON.parse(fs.readFileSync(path.join(trashEntry, "meta.json"), "utf8"));
  check("回收站标题保留「问」", meta.title === "问");
  check("回收站条目只有索引、没有 session/ 子目录", !fs.existsSync(path.join(trashEntry, "session")));
  check("删除后列表立即过滤", !(await manager.payload({ lean: true })).sessions.some((row) => row.id === cold.id));
  check("hidden 快照返回删除 id", (await manager.payload({ hiddenOnly: true })).trashedIds.includes(cold.id));

  // 2. UI 中打开（live）的会话删除：宿主写句柄被占用，目录仍应迁移成功
  const liveHeader = seedSession(host, {
    id: "session-22222222-2222-4222-8222-222222222222",
    cwd: wsDirA,
    title: "12",
    events: [{ type: "user/message", data: { content: "12" } }]
  });
  host.owned.add(liveHeader.id);
  host.live.add(liveHeader.id);
  const liveDir = sessionDirOf(sessionsRoot, wsDirA, liveHeader.id);
  result = await manager.removeToTrash([liveHeader.id]);
  check("删除 live 会话（写句柄被占用）成功", result[0].ok === true);
  check("live 会话日志仍留在原位", fs.existsSync(liveDir) && fs.existsSync(path.join(liveDir, LOG_NAME)));

  // 3. 运行中的会话拒绝删除
  const runningHeader = seedSession(host, {
    id: "session-33333333-3333-4333-8333-333333333333",
    cwd: wsDirA,
    title: "running",
    events: []
  });
  host.running.add(runningHeader.id);
  const runningDir = sessionDirOf(sessionsRoot, wsDirA, runningHeader.id);
  result = await manager.removeToTrash([runningHeader.id]);
  check("运行中会话拒删", result[0].ok === false && result[0].error === "SESSION_RUNNING");
  check("运行中会话目录未动", fs.existsSync(runningDir));

  // 4. 恢复：软回收站只删索引，工作区列表当场可见（不重启）
  result = await manager.restore([meta.trashId]);
  check("恢复会话", result[0].ok === true && fs.existsSync(coldDir));
  check("恢复无需重启", result[0].restartRequired === false && result[0].soft === true);
  check("恢复后回收站条目删除", !fs.existsSync(trashEntry));
  const afterRestore = await manager.payload({ lean: true });
  const restoredRow = afterRestore.sessions.find((row) => row.id === cold.id);
  check("恢复后立即回到原工作区分组", !!restoredRow && restoredRow.workspaceId === "ws-a");
  check("恢复后 hidden 快照不再包含该 id", !(await manager.payload({ hiddenOnly: true })).trashedIds.includes(cold.id));

  // 5. 重新删除并彻底清理：软条目清理会真正删除日志并留下墓碑
  result = await manager.removeToTrash([cold.id]);
  const purgeId = result[0].trashId;
  result = await manager.purge([purgeId], false);
  check("彻底清理", result.results[0].ok === true && !fs.existsSync(path.join(trashRoot, purgeId)));
  check("彻底清理删除原日志", !fs.existsSync(coldDir));
  const tombstones = JSON.parse(fs.readFileSync(path.join(trashRoot, "purged.json"), "utf8"));
  check("彻底清理写入墓碑", Array.isArray(tombstones) && tombstones.some((item) => item.id === cold.id));
  check("墓碑让残留 live 行继续被过滤", !(await manager.payload({ lean: true })).sessions.some((row) => row.id === cold.id));
  check("hidden 快照返回墓碑 id", (await manager.payload({ hiddenOnly: true })).purgedIds.includes(cold.id));

  // 6. 归档与取消归档：真实工作区索引 + 列表标记
  const archId = "session-34343434-3434-4434-8434-343434343434";
  seedSession(host, {
    id: archId,
    cwd: wsDirA,
    title: "archive me",
    events: [{ type: "user/message", data: { content: "a" } }]
  });
  const archDir = sessionDirOf(sessionsRoot, wsDirA, archId);
  const archived = await manager.archive([archId]);
  check("归档单条成功", archived.results[0].ok === true);
  check("归档后工作区索引包含该 id", host.registry.archivedSessionIds.includes(archId));
  check("归档后列表标记 archived=true",
    (await manager.payload({ lean: true })).sessions.find((row) => row.id === archId).archived === true);
  check("归档不移动、不删除日志", fs.existsSync(archDir) && fs.existsSync(path.join(archDir, LOG_NAME)));
  await manager.unarchive(archId);
  check("取消归档后工作区索引移除该 id", !host.registry.archivedSessionIds.includes(archId));
  check("取消归档后列表标记 archived=false",
    (await manager.payload({ lean: true })).sessions.find((row) => row.id === archId).archived === false);

  // 7. 批量删除到回收站（无 OK）→ 列表无「未分组」残留 → 批量恢复当场回原分组
  const batchIds = [
    "session-12121212-1212-4212-8212-121212121212",
    "session-13131313-1313-4313-8313-131313131313",
    "session-14141414-1414-4414-8414-141414141414"
  ];
  const batchDirs = new Map();
  for (const id of batchIds) {
    seedSession(host, { id, cwd: wsDirA, title: id.slice(-6), events: [{ type: "user/message", data: { content: id } }] });
    batchDirs.set(id, sessionDirOf(sessionsRoot, wsDirA, id));
  }
  // 中间一条模拟「UI 中打开」：删除后宿主内存里的 live 记录仍会被 listSessions 返回。
  host.live.add(batchIds[1]);
  const trashBefore = (await manager.payload({})).trash.count;
  const batchDelete = await manager.removeToTrash(batchIds);
  check("批量删除三条均成功", batchDelete.every((item) => item.ok === true));
  check("软回收站：三条日志仍在原位", batchIds.every((id) => fs.existsSync(batchDirs.get(id))));
  const afterDelete = await manager.payload({});
  const afterDeleteIds = new Set(afterDelete.sessions.map((row) => row.id));
  check("删除后列表立即不含这三条", batchIds.every((id) => !afterDeleteIds.has(id)));
  check("删除后列表无「未分组」残留",
    afterDelete.sessions.every((row) => row.workspaceId !== "" && row.workspaceId !== undefined));
  check("删除后 hidden 快照包含三条",
    batchIds.every((id) => (afterDelete.trashedIds || []).includes(id)
      || afterDelete.trash.entries.some((entry) => entry.id === id)));
  const hiddenAfterDelete = await manager.payload({ hiddenOnly: true });
  check("hidden 快照按 trashedIds 标记", batchIds.every((id) => hiddenAfterDelete.trashedIds.includes(id)));
  const afterRefresh = await manager.payload({});
  check("再次拉取列表仍不含这三条",
    batchIds.every((id) => !new Set(afterRefresh.sessions.map((row) => row.id)).has(id)));
  check("回收站里 3 条都在",
    afterRefresh.trash.count === trashBefore + 3
      && batchIds.every((id) => afterRefresh.trash.entries.some((entry) => entry.id === id)));
  note(`批量删除后 rows=${afterRefresh.sessions.length} trash=${afterRefresh.trash.count} 未分组=${afterRefresh.sessions.filter((row) => row.workspaceId === "").length}`);
  const restoredBatch = await manager.restore(batchDelete.map((item) => item.trashId));
  check("批量恢复三条均成功", restoredBatch.every((item) => item.ok === true));
  check("批量恢复无需重启", restoredBatch.every((item) => item.restartRequired === false));
  check("恢复后回收站条目全部移除",
    batchDelete.every((item) => !fs.existsSync(path.join(trashRoot, item.trashId))));
  const afterBatchRestore = await manager.payload({});
  const restoredRows = new Map(afterBatchRestore.sessions.map((row) => [row.id, row]));
  check("恢复后立即回到原工作区分组",
    batchIds.every((id) => restoredRows.get(id) && restoredRows.get(id).workspaceId === "ws-a"));
  check("恢复后回收站回到删除前数量", afterBatchRestore.trash.count === trashBefore);

  // 8. 批量彻底清理（不可恢复）：日志删除、墓碑过滤 live 残留、列表无未分组
  const regrab = await manager.removeToTrash(batchIds);
  const groupPurge = await manager.purge(regrab.map((item) => item.trashId), false);
  check("批量彻底清理三条均成功", groupPurge.results.every((item) => item.ok === true));
  check("批量彻底清理删除全部日志", batchIds.every((id) => !fs.existsSync(batchDirs.get(id))));
  const afterPurge = await manager.payload({});
  check("清理后列表不含三条且无未分组",
    batchIds.every((id) => !new Set(afterPurge.sessions.map((row) => row.id)).has(id))
      && afterPurge.sessions.every((row) => row.workspaceId !== "" && row.workspaceId !== undefined));
  check("清理后回收站恢复原数量", afterPurge.trash.count === trashBefore);
  const hiddenAfterPurge = await manager.payload({ hiddenOnly: true });
  check("清理后 hidden 快照按墓碑隐藏",
    batchIds.every((id) => hiddenAfterPurge.purgedIds.includes(id)));
  host.live.delete(batchIds[1]);

  // 9. 旧版物理回收站条目仍可恢复（向后兼容）
  const legacyHeader = seedSession(host, {
    id: "session-16161616-1616-4616-8616-161616161616",
    cwd: wsDirA,
    title: "legacy trash",
    events: [{ type: "user/message", data: { content: "legacy" } }]
  });
  const legacyDir = sessionDirOf(sessionsRoot, wsDirA, legacyHeader.id);
  const legacyTrashId = "trash-legacy-" + Date.now().toString(36);
  const legacyEntry = path.join(trashRoot, legacyTrashId);
  fs.mkdirSync(legacyEntry, { recursive: true });
  fs.renameSync(legacyDir, path.join(legacyEntry, "session"));
  fs.writeFileSync(path.join(legacyEntry, "meta.json"), JSON.stringify({
    version: 1,
    trashId: legacyTrashId,
    id: legacyHeader.id,
    deletedAt: Date.now(),
    title: "legacy trash",
    header: legacyHeader,
    originalDir: legacyDir,
    sizeBytes: 0,
    workspaceId: "ws-a",
    workspaceTitle: "Work A"
  }), "utf8");
  const legacyRestore = await manager.restore([legacyTrashId]);
  check("旧版物理回收站条目可恢复", legacyRestore[0].ok === true
    && fs.existsSync(legacyDir)
    && !fs.existsSync(legacyEntry));

  // 10. 「删除 / 未分组」若只是普通会话标题，应正常保留，不是墓碑
  const titleDeleteId = "session-24242424-2424-4424-8424-242424242424";
  seedSession(host, { id: titleDeleteId, cwd: wsDirA, title: "删除 未分组", events: [], zstd: true });
  const titlePayload = await manager.payload({});
  const titleRow = titlePayload.sessions.find((row) => row.id === titleDeleteId);
  const titleHidden = await manager.payload({ hiddenOnly: true });
  check("标题为「删除」的普通会话仍按所在工作区分组",
    !!titleRow && titleRow.workspaceId === "ws-a" && titleRow.title === "删除 未分组");
  check("标题为「删除」的普通会话不会被墓碑/回收站过滤",
    !titleHidden.trashedIds.includes(titleDeleteId) && !titleHidden.purgedIds.includes(titleDeleteId));

  // 11. 「删除会话」开关：关闭时宿主拒绝 delete / purge，恢复与归档不受影响
  const routeCtx = Object.assign({}, host.ctx, {
    webServer: { getOrigin: () => "http://127.0.0.1:1" },
    logger: { warn() {} }
  });
  const handlerOff = makeSessionsHandler(routeCtx, manager, { sessionsDelete: false });
  const switchVictim = seedSession(host, {
    id: "session-28282828-2828-4828-8828-282828282828",
    cwd: wsDirA,
    title: "switch victim",
    events: [{ type: "user/message", data: { content: "keep" } }]
  });
  const switchVictimDir = sessionDirOf(sessionsRoot, wsDirA, switchVictim.id);
  let routeRes = await callRoute(handlerOff, "POST", { action: "delete", sessionIds: [switchVictim.id] });
  check("开关关闭：delete 被宿主拒绝（403 SESSIONS_DELETE_DISABLED）",
    routeRes.status === 403 && routeRes.body.error.code === "SESSIONS_DELETE_DISABLED");
  check("开关关闭：日志未被删除", fs.existsSync(switchVictimDir));
  const purgeVictim = seedSession(host, {
    id: "session-29292929-2929-4929-8929-292929292929",
    cwd: wsDirA,
    title: "purge victim",
    events: []
  });
  const purgeVictimDir = sessionDirOf(sessionsRoot, wsDirA, purgeVictim.id);
  const purgePrepared = await manager.removeToTrash([purgeVictim.id]);
  routeRes = await callRoute(handlerOff, "POST", {
    action: "purge",
    trashIds: [purgePrepared[0].trashId],
    confirm: "OK"
  });
  check("开关关闭：purge 被宿主拒绝（403 SESSIONS_DELETE_DISABLED）",
    routeRes.status === 403 && routeRes.body.error.code === "SESSIONS_DELETE_DISABLED");
  check("开关关闭：回收站条目与日志仍在",
    fs.existsSync(path.join(trashRoot, purgePrepared[0].trashId)) && fs.existsSync(purgeVictimDir));
  routeRes = await callRoute(handlerOff, "POST", {
    action: "restore",
    trashIds: [purgePrepared[0].trashId]
  });
  check("开关关闭：恢复仍可用（200）", routeRes.status === 200 && routeRes.body.ok === true);
  routeRes = await callRoute(handlerOff, "POST", { action: "archive", sessionIds: [switchVictim.id] });
  check("开关关闭：归档仍可用（200）", routeRes.status === 200 && routeRes.body.ok === true);
  routeRes = await callRoute(handlerOff, "GET");
  check("开关关闭：列表读取仍可用（200）", routeRes.status === 200 && routeRes.body.ok === true);

  // 开关开启：同一路由允许删除到回收站
  const handlerOn = makeSessionsHandler(routeCtx, manager, { sessionsDelete: true });
  routeRes = await callRoute(handlerOn, "POST", { action: "delete", sessionIds: [switchVictim.id] });
  check("开关开启：delete 成功（200）",
    routeRes.status === 200 && routeRes.body.ok === true
      && routeRes.body.value.results[0].ok === true);
  check("开关开启：会话进入回收站",
    !fs.existsSync(switchVictimDir)
      || routeRes.body.value.results[0].trashId !== undefined);

  // 12. 路由层确认策略：批量删除到回收站不需要 OK；批量彻底清理仍需要 OK
  const routeIds = [
    "session-30303030-3030-4030-8030-303030303030",
    "session-31313131-3131-4131-8131-313131313131"
  ];
  const routeDirs = new Map();
  for (const id of routeIds) {
    seedSession(host, { id, cwd: wsDirB, title: id.slice(-6), events: [] });
    routeDirs.set(id, sessionDirOf(sessionsRoot, wsDirB, id));
  }
  routeRes = await callRoute(handlerOn, "POST", { action: "delete", sessionIds: routeIds });
  check("批量删除到回收站：无 confirm 直接执行",
    routeRes.status === 200 && routeRes.body.ok === true
      && routeRes.body.value.results.every((item) => item.ok === true));
  check("批量删除到回收站：日志仍留在原位",
    routeIds.every((id) => fs.existsSync(routeDirs.get(id))));
  const trashIds = routeRes.body.value.results.map((item) => item.trashId);
  routeRes = await callRoute(handlerOn, "POST", { action: "purge", trashIds });
  check("批量彻底清理：缺 OK 被拒绝（400 CONFIRM_REQUIRED）",
    routeRes.status === 400 && routeRes.body.error.code === "CONFIRM_REQUIRED");
  check("批量彻底清理：被拒绝后条目与日志未动",
    trashIds.every((id) => fs.existsSync(path.join(trashRoot, id)))
      && routeIds.every((id) => fs.existsSync(routeDirs.get(id))));
  routeRes = await callRoute(handlerOn, "POST", { action: "purge", trashIds, confirm: "ok" });
  check("批量彻底清理：输入小写 ok 也可执行",
    routeRes.status === 200 && routeRes.body.value.results.every((item) => item.ok === true));
  check("批量彻底清理：日志已删除", routeIds.every((id) => !fs.existsSync(routeDirs.get(id))));
  routeRes = await callRoute(handlerOn, "POST", { action: "purge", all: true });
  check("清空回收站：缺 OK 被拒绝（400 CONFIRM_REQUIRED）",
    routeRes.status === 400 && routeRes.body.error.code === "CONFIRM_REQUIRED");
  routeRes = await callRoute(handlerOn, "POST", { action: "purge", all: true, confirm: "OK" });
  check("清空回收站：输入 OK 后执行成功",
    routeRes.status === 200 && routeRes.body.ok === true);
  check("清空回收站后回收站为空", (await manager.payload({})).trash.count === 0);

  // 13. 路由安全围栏：伪造来源、跨站、路径穿越、批量上限、请求体与响应头
  let secRes = await callRaw(handlerOn, { method: "GET", headers: { host: "evil.example:80" } });
  check("伪造 Host（非回环）→ 403 FORBIDDEN",
    secRes.status === 403 && secRes.body.error.code === "FORBIDDEN");
  secRes = await callRaw(handlerOn, {
    method: "GET",
    headers: { "sec-fetch-site": "cross-site", origin: "http://evil.example" }
  });
  check("跨站请求（cross-site + 异源 Origin）→ 403", secRes.status === 403);
  secRes = await callRaw(handlerOn, {
    method: "GET",
    headers: { "sec-fetch-site": "same-site", origin: "http://127.0.0.1:2" }
  });
  check("同站不同端口（same-site）→ 403", secRes.status === 403);
  secRes = await callRaw(handlerOn, { method: "GET", headers: { origin: "http://127.0.0.1:2" } });
  check("同源校验：Origin 与宿主不一致 → 403", secRes.status === 403);
  const noOriginCtx = Object.assign({}, routeCtx, {
    webServer: { getOrigin: () => { throw new Error("web server unavailable"); } }
  });
  const handlerNoOrigin = makeSessionsHandler(noOriginCtx, manager, { sessionsDelete: true });
  secRes = await callRaw(handlerNoOrigin, { method: "GET" });
  check("宿主无法给出同源地址时，带 Origin 请求被拒（失败即关闭）", secRes.status === 403);
  secRes = await callRaw(handlerOn, { method: "GET" });
  check("正常同源 GET 仍为 200", secRes.status === 200 && secRes.body.ok === true);
  check("响应不带 CORS 放行头",
    secRes.headers["access-control-allow-origin"] === undefined);
  check("响应带 nosniff / 同源 CORP / no-store",
    secRes.headers["x-content-type-options"] === "nosniff"
      && secRes.headers["cross-origin-resource-policy"] === "same-origin"
      && secRes.headers["cache-control"] === "no-store");

  secRes = await callRaw(handlerOn, {
    body: JSON.stringify({ action: "delete", sessionIds: ["../../etc/passwd"] })
  });
  check("会话 id 路径穿越 → 400 INVALID_REQUEST",
    secRes.status === 400 && secRes.body.error.code === "INVALID_REQUEST");
  secRes = await callRaw(handlerOn, {
    body: JSON.stringify({ action: "restore", trashIds: ["trash-../../escape"] })
  });
  check("回收站 id 路径穿越 → 400 INVALID_REQUEST", secRes.status === 400);
  const manyIds = Array.from({ length: 51 }, (_, i) =>
    `session-${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
  secRes = await callRaw(handlerOn, {
    body: JSON.stringify({ action: "delete", sessionIds: manyIds })
  });
  check("批量超过 50 条 → 400", secRes.status === 400);
  const duplicateId = "session-00000000-0000-4000-8000-000000000000";
  secRes = await callRaw(handlerOn, {
    body: JSON.stringify({ action: "delete", sessionIds: [duplicateId, duplicateId] })
  });
  check("重复 id → 400", secRes.status === 400);
  secRes = await callRaw(handlerOn, {
    body: JSON.stringify({ action: "delete", sessionIds: [duplicateId] }),
    headers: { "content-type": "text/plain" }
  });
  check("非 JSON Content-Type → 400", secRes.status === 400);
  secRes = await callRaw(handlerOn, {
    body: "{}",
    headers: { "content-length": String(2 * 1024 * 1024) }
  });
  check("请求体超过 1MB → 413 PAYLOAD_TOO_LARGE",
    secRes.status === 413 && secRes.body.error.code === "PAYLOAD_TOO_LARGE");
  secRes = await callRaw(handlerOn, { method: "PUT", body: "{}" });
  check("不支持的 HTTP 方法 → 405 且声明 Allow",
    secRes.status === 405 && String(secRes.headers.allow || "").includes("POST"));
  secRes = await callRaw(handlerOn, { body: JSON.stringify({ action: "unknown" }) });
  check("未知 action → 400 INVALID_REQUEST", secRes.status === 400);
  check("错误响应不泄露内部路径",
    !String(secRes.body.error.message || "").includes(root)
      && !String(secRes.body.error.message || "").includes("\\\\"));

  // 彻底清理不可恢复：清理后同一条目无法恢复，日志也不在磁盘上
  const irreversibleId = "session-32323232-3232-4232-8232-323232323232";
  seedSession(host, { id: irreversibleId, cwd: wsDirA, title: "irreversible", events: [] });
  const irreversibleDir = sessionDirOf(sessionsRoot, wsDirA, irreversibleId);
  const irreversible = await manager.removeToTrash([irreversibleId]);
  secRes = await callRaw(handlerOn, {
    body: JSON.stringify({ action: "purge", trashIds: [irreversible[0].trashId], confirm: "OK" })
  });
  const restoreAfterPurge = await manager.restore([irreversible[0].trashId]);
  check("彻底清理后恢复失败（条目已不可恢复）",
    secRes.status === 200 && restoreAfterPurge[0].ok === false);
  check("彻底清理后日志与回收站条目都已删除",
    !fs.existsSync(irreversibleDir) && !fs.existsSync(path.join(trashRoot, irreversible[0].trashId)));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(report.join("\n"));
  console.log(`\n${report.length} 项真实文件系统端到端检查全部通过`);
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exitCode = 1;
});
