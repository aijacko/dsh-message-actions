// 会话删除 / 移动的真实文件系统端到端测试。
//
// 用临时目录复制/合成会话目录，磁盘操作全部真实（mkdir、rename、rm），
// 仅把宿主的六个服务做成最小桩：sessionPersistence / sessionQuery /
// workspaceRegistry / agents / sessions / logger。
//
// 覆盖：冷会话删除、UI 中打开（live，写句柄被宿主占用）的会话删除、
// 运行中拒删、恢复、彻底清理、跨工作区移动、同工作区移动、目标不存在回滚。

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createSessionManager } from "../src/session-manager.mjs";
import sessionsPure from "../src/sessions.cjs";

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

  // 6. 跨工作区移动
  const movable = seedSession(host, {
    id: "session-44444444-4444-4444-8444-444444444444",
    cwd: wsDirA,
    title: "move me",
    events: [{ type: "user/message", data: { content: "hello" } }, { type: "assistant/message", data: { content: "hi" } }]
  });
  const fromDir = sessionDirOf(sessionsRoot, wsDirA, movable.id);
  const toDir = sessionDirOf(sessionsRoot, wsDirB, movable.id);
  const moved = await manager.move(movable.id, "ws-b");
  note(`跨工作区移动 source=${fromDir} target=${moved.targetDir} events=${moved.eventCount} header.cwd=${moved.headerCwd} index=${moved.indexWritten}`);
  check("跨工作区移动成功", moved.ok === true && moved.moved === true);
  check("移动结果带源/目标目录与事件数",
    moved.sourceDir === fromDir && moved.targetDir === toDir && moved.eventCount === 2);
  check("源目录已清理", !fs.existsSync(fromDir));
  const movedHeader = JSON.parse(fs.readFileSync(path.join(toDir, LOG_NAME), "utf8").split("\n")[0]);
  check("目标 header.cwd 已更新", movedHeader.cwd === wsDirB);
  const movedEvents = fs.readFileSync(path.join(toDir, LOG_NAME), "utf8").split("\n").slice(1).filter(Boolean);
  check("事件数量完整保留", movedEvents.length === 2);
  check("工作区索引已挂载", host.registry.get("ws-b").sessionIds.includes(movable.id));

  // 7. 同工作区移动：幂等成功
  const same = await manager.move(movable.id, "ws-b");
  check("同工作区移动幂等", same.ok === true && same.already === true);

  // 8. 目标工作区不存在：失败但原目录不动
  const rollbackHeader = seedSession(host, {
    id: "session-55555555-5555-4555-8555-555555555555",
    cwd: wsDirA,
    title: "rollback",
    events: []
  });
  const rollbackDir = sessionDirOf(sessionsRoot, wsDirA, rollbackHeader.id);
  const failed = await manager.move(rollbackHeader.id, "ws-missing");
  check("目标工作区不存在时报错", failed.ok === false && failed.error === "WORKSPACE_NOT_FOUND");
  check("失败回滚后目录仍在", fs.existsSync(rollbackDir));

  // 8b. 工作区已注册但目录被删：明确返回 WORKSPACE_MISSING
  const missing = await manager.move(rollbackHeader.id, "ws-deleted");
  note(`目标目录缺失 => code=${missing.error} src=${missing.detail ? missing.detail.sourceDir : ""}`);
  check("目标目录缺失时返回 WORKSPACE_MISSING", missing.ok === false && missing.error === "WORKSPACE_MISSING");
  check("目标目录缺失后源目录未动", fs.existsSync(rollbackDir));

  // 8c. 目标已有同名会话：返回 TARGET_EXISTS，源目录保持原样
  const clashHeader = seedSession(host, {
    id: "session-abababab-abab-4bab-8bab-abababababab",
    cwd: wsDirA,
    title: "clash",
    events: []
  });
  const clashFromDir = sessionDirOf(sessionsRoot, wsDirA, clashHeader.id);
  const clashToDir = sessionDirOf(sessionsRoot, wsDirB, clashHeader.id);
  fs.mkdirSync(clashToDir, { recursive: true });
  fs.writeFileSync(path.join(clashToDir, LOG_NAME), JSON.stringify(Object.assign({}, clashHeader, { cwd: wsDirB })) + "\n", "utf8");
  const clash = await manager.move(clashHeader.id, "ws-b");
  note(`目标同名 => code=${clash.error} stage=${clash.detail ? clash.detail.stage : ""} source=${clash.detail ? clash.detail.sourceDir : ""}`);
  check("目标已有同名会话时返回 TARGET_EXISTS", clash.ok === false && clash.error === "TARGET_EXISTS");
  check("同名冲突后源目录未动", fs.existsSync(clashFromDir));
  fs.rmSync(clashToDir, { recursive: true, force: true });
  fs.rmSync(clashFromDir, { recursive: true, force: true });

  // 9. 打开中（live）的会话移动：写句柄被占用仍应放行
  const liveMoveHeader = seedSession(host, {
    id: "session-66666666-6666-4666-8666-666666666666",
    cwd: wsDirA,
    title: "live move",
    events: [
      { type: "user/message", data: { content: "a" } },
      { type: "assistant/message", data: { content: "b" } },
      { type: "user/message", data: { content: "c" } }
    ]
  });
  host.live.add(liveMoveHeader.id);
  host.owned.add(liveMoveHeader.id);
  const liveFromDir = sessionDirOf(sessionsRoot, wsDirA, liveMoveHeader.id);
  const liveToDir = sessionDirOf(sessionsRoot, wsDirB, liveMoveHeader.id);
  let createErr = null;
  try {
    await host.persistence.create(Object.assign({}, liveMoveHeader, { cwd: wsDirB }));
  } catch (err) {
    createErr = err;
  }
  check("桩复现真实根因：live 会话 create 抛 SessionAlreadyExistsError",
    createErr !== null && createErr.name === "SessionAlreadyExistsError");
  const liveMove = await manager.move(liveMoveHeader.id, "ws-b");
  note(`live 移动 source=${liveFromDir} target=${liveMove.targetDir} events=${liveMove.eventCount} header.cwd=${liveMove.headerCwd} index=${liveMove.indexWritten} restart=${liveMove.restartRequired}`);
  check("live 会话移动放行（写句柄被占用）", liveMove.ok === true && liveMove.moved === true);
  check("live 移动失败路径不再回滚（无 MOVE_FAILED）", liveMove.error === undefined);
  check("live 移动后旧目录已清理", !fs.existsSync(liveFromDir));
  const liveMovedHeader = JSON.parse(fs.readFileSync(path.join(liveToDir, LOG_NAME), "utf8").split("\n")[0]);
  check("live 移动后 header.cwd 更新", liveMovedHeader.cwd === wsDirB);
  const liveMovedEvents = fs.readFileSync(path.join(liveToDir, LOG_NAME), "utf8").split("\n").slice(1).filter(Boolean);
  check("live 移动后事件数量完整", liveMovedEvents.length === 3);
  check("live 移动后新工作区索引已挂载", host.registry.get("ws-b").sessionIds.includes(liveMoveHeader.id));
  host.live.delete(liveMoveHeader.id);
  host.owned.delete(liveMoveHeader.id);

  // 9b. 跨盘符边界：会话日志始终在 sessionsRoot 下，只是 header.cwd 指向另一盘符的工作区。
  const currentDrive = path.parse(sessionsRoot).root;
  const otherDrive = ["D:\\", "E:\\", "F:\\", "G:\\"]
    .find((drive) => fs.existsSync(drive) && drive.toLowerCase() !== currentDrive.toLowerCase());
  if (otherDrive) {
    const crossRoot = path.join(otherDrive, `dma-e2e-cross-${Date.now().toString(36)}`);
    fs.mkdirSync(crossRoot, { recursive: true });
    const crossEntity = {
      id: "ws-cross",
      title: "Cross drive",
      path: crossRoot,
      sessionIds: [],
      attachSession(id) {
        if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
      },
      detachSession(id) {
        this.sessionIds = this.sessionIds.filter((value) => value !== id);
      }
    };
    host.registry.list().push(crossEntity);
    const crossHeader = seedSession(host, {
      id: "session-acacacac-acac-4cac-8cac-acacacacacac",
      cwd: wsDirA,
      title: "cross drive",
      events: [{ type: "user/message", data: { content: "cross" } }]
    });
    const cross = await manager.move(crossHeader.id, "ws-cross");
    const crossTarget = sessionDirOf(sessionsRoot, crossRoot, crossHeader.id);
    note(`跨盘符 ${currentDrive} -> ${otherDrive} target=${cross.targetDir} events=${cross.eventCount} header.cwd=${cross.headerCwd} index=${cross.indexWritten}`);
    check("跨盘符移动成功", cross.ok === true && cross.moved === true);
    check("跨盘符 header.cwd 指向另一盘符工作区",
      cross.headerCwd === crossRoot
        && JSON.parse(fs.readFileSync(path.join(crossTarget, LOG_NAME), "utf8").split("\n")[0]).cwd === crossRoot);
    check("跨盘符会话日志仍在 sessionsRoot 下", fs.existsSync(crossTarget) && fs.existsSync(path.join(crossRoot, "..")));
    check("跨盘符索引已挂载", crossEntity.sessionIds.includes(crossHeader.id));
    fs.rmSync(crossRoot, { recursive: true, force: true });
  } else {
    note("跨盘符边界 N/A：当前环境没有第二个可用盘符");
  }

  // 10. 运行中会话移动被拒绝，原目录不动
  host.running.add(rollbackHeader.id);
  const runningMove = await manager.move(rollbackHeader.id, "ws-b");
  check("运行中会话移动被拒绝", runningMove.ok === false && runningMove.error === "SESSION_RUNNING");
  check("被拒绝后目录仍在", fs.existsSync(rollbackDir));
  host.running.delete(rollbackHeader.id);

  // 11. 批量移动：混入一条 running，单独失败、其余成功、已成功项不回滚
  const batchA = seedSession(host, {
    id: "session-77777777-7777-4777-8777-777777777777",
    cwd: wsDirA,
    title: "batch a",
    events: [{ type: "user/message", data: { content: "a" } }]
  });
  const batchB = seedSession(host, {
    id: "session-88888888-8888-4888-8888-888888888888",
    cwd: wsDirA,
    title: "batch b",
    events: [{ type: "user/message", data: { content: "b" } }]
  });
  const batchRunning = seedSession(host, {
    id: "session-99999999-9999-4999-8999-999999999999",
    cwd: wsDirA,
    title: "batch running",
    events: []
  });
  host.running.add(batchRunning.id);
  const batchFromA = sessionDirOf(sessionsRoot, wsDirA, batchA.id);
  const batchFromB = sessionDirOf(sessionsRoot, wsDirA, batchB.id);
  const batchRunningDir = sessionDirOf(sessionsRoot, wsDirA, batchRunning.id);
  const batchMoved = await manager.moveMany([batchA.id, batchRunning.id, batchB.id], "ws-b");
  check("批量移动返回逐条结果", batchMoved.results.length === 3);
  check("批量移动成功项 a", batchMoved.results[0].ok === true);
  check("批量移动 running 单独失败",
    batchMoved.results[1].ok === false && batchMoved.results[1].error === "SESSION_RUNNING");
  check("批量移动其余项 b 成功", batchMoved.results[2].ok === true);
  check("批量移动成功项不回滚", !fs.existsSync(batchFromA) && !fs.existsSync(batchFromB));
  check("批量移动 running 目录未动", fs.existsSync(batchRunningDir));
  host.running.delete(batchRunning.id);

  // 12. 批量删除进回收站并恢复
  const trashBatchA = seedSession(host, {
    id: "session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    cwd: wsDirB,
    title: "trash a",
    events: [{ type: "user/message", data: { content: "a" } }]
  });
  const trashBatchB = seedSession(host, {
    id: "session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    cwd: wsDirB,
    title: "trash b",
    events: []
  });
  const trashDirA = sessionDirOf(sessionsRoot, wsDirB, trashBatchA.id);
  const trashDirB = sessionDirOf(sessionsRoot, wsDirB, trashBatchB.id);
  const trashBatch = await manager.removeToTrash([trashBatchA.id, trashBatchB.id]);
  check("批量删除两条均成功", trashBatch.every((item) => item.ok === true));
  check("软回收站：批量删除后日志仍在原位", fs.existsSync(trashDirA) && fs.existsSync(trashDirB));
  check("批量删除后列表立即不含这两条",
    !(await manager.payload({ lean: true })).sessions.some((row) => row.id === trashBatchA.id || row.id === trashBatchB.id));
  const restoredBatch = await manager.restore(trashBatch.map((item) => item.trashId));
  check("批量恢复两条均成功", restoredBatch.every((item) => item.ok === true));
  check("批量恢复无需重启", restoredBatch.every((item) => item.restartRequired === false));
  check("批量恢复后目录与日志仍在", fs.existsSync(trashDirA) && fs.existsSync(trashDirB));

  // 12b. 批量删除混入 running：单独失败，其余成功
  const trashBatchC = seedSession(host, {
    id: "session-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    cwd: wsDirA,
    title: "trash c",
    events: []
  });
  const trashDirC = sessionDirOf(sessionsRoot, wsDirA, trashBatchC.id);
  host.running.add(batchRunning.id);
  const mixedDelete = await manager.removeToTrash([trashBatchC.id, batchRunning.id]);
  check("批量删除成功项 c", mixedDelete[0].ok === true);
  check("批量删除 running 单独失败",
    mixedDelete[1].ok === false && mixedDelete[1].error === "SESSION_RUNNING");
  check("批量删除部分成功后源目录仍在（软回收站）", fs.existsSync(trashDirC));
  host.running.delete(batchRunning.id);
  await manager.restore([mixedDelete[0].trashId]);

  // 13. 批量归档：running 单独失败，其余成功；列表标记一致
  const archiveA = seedSession(host, {
    id: "session-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    cwd: wsDirB,
    title: "archive a",
    events: []
  });
  const archiveB = seedSession(host, {
    id: "session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    cwd: wsDirB,
    title: "archive b",
    events: []
  });
  const archiveRunning = seedSession(host, {
    id: "session-ffffffff-ffff-4fff-8fff-ffffffffffff",
    cwd: wsDirB,
    title: "archive running",
    events: []
  });
  host.running.add(archiveRunning.id);
  const archived = await manager.archive([archiveA.id, archiveRunning.id, archiveB.id]);
  check("批量归档返回逐条结果", archived.results.length === 3);
  check("批量归档成功项 a", archived.results[0].ok === true);
  check("批量归档 running 单独失败",
    archived.results[1].ok === false && archived.results[1].error === "SESSION_RUNNING");
  check("批量归档成功项 b", archived.results[2].ok === true);
  check("归档索引包含成功项、不含 running",
    host.registry.archivedSessionIds.includes(archiveA.id)
      && host.registry.archivedSessionIds.includes(archiveB.id)
      && !host.registry.archivedSessionIds.includes(archiveRunning.id));
  const payload = await manager.payload({});
  const payloadRows = new Map(payload.sessions.map((row) => [row.id, row]));
  check("列表归档标记与归档结果一致",
    payloadRows.get(archiveA.id).archived === true
      && payloadRows.get(archiveB.id).archived === true
      && payloadRows.get(archiveRunning.id).archived === false);
  const archiveMissing = await manager.archive(["session-00000000-0000-4000-8000-000000000000"]);
  check("批量归档不存在的会话返回 TARGET_NOT_FOUND",
    archiveMissing.results[0].ok === false && archiveMissing.results[0].error === "TARGET_NOT_FOUND");
  host.running.delete(archiveRunning.id);

  // 15. 真实 zstd 日志：移动后仍是 zstd，首行 cwd 已改写、事件完整
  const zstdHeader = seedSession(host, {
    id: "session-15151515-1515-4515-8515-151515151515",
    cwd: wsDirA,
    title: "zstd move",
    events: [
      { type: "user/message", data: { content: "z1" } },
      { type: "assistant/message", data: { content: "z2" } },
      { type: "user/message", data: { content: "z3" } }
    ],
    zstd: true
  });
  const zstdTargetDir = sessionDirOf(sessionsRoot, wsDirB, zstdHeader.id);
  const zstdMove = await manager.move(zstdHeader.id, "ws-b");
  note(`zstd 移动 target=${zstdMove.targetDir} events=${zstdMove.eventCount} compressed=${zstdMove.compressed} header.cwd=${zstdMove.headerCwd}`);
  check("zstd 日志移动成功", zstdMove.ok === true && zstdMove.compressed === true && zstdMove.eventCount === 3);
  const zstdBuf = fs.readFileSync(path.join(zstdTargetDir, LOG_NAME));
  check("zstd 移动后文件仍是 zstd 压缩", isZstd(zstdBuf));
  const zstdText = decodeLog(zstdBuf);
  check("zstd 移动后 header.cwd 更新", JSON.parse(zstdText.split("\n")[0]).cwd === wsDirB);
  check("zstd 移动后事件完整", zstdText.split("\n").slice(1).filter(Boolean).length === 3);

  // 14. 批量删除 3 条（含 live 内存残留）→ 立即不可见 → 批量恢复当场回原工作区 → 批量彻底清理
  const groupIds = [
    "session-12121212-1212-4212-8212-121212121212",
    "session-13131313-1313-4313-8313-131313131313",
    "session-14141414-1414-4414-8414-141414141414"
  ];
  const groupDirs = new Map();
  for (const id of groupIds) {
    seedSession(host, { id, cwd: wsDirA, title: id.slice(-6), events: [{ type: "user/message", data: { content: id } }] });
    groupDirs.set(id, sessionDirOf(sessionsRoot, wsDirA, id));
  }
  // 中间一条模拟「UI 中打开」：删除后宿主内存里的 live 记录仍会被 listSessions 返回。
  host.live.add(groupIds[1]);
  const trashBefore = (await manager.payload({})).trash.count;
  const groupDelete = await manager.removeToTrash(groupIds);
  check("批量删除三条均成功", groupDelete.every((item) => item.ok === true));
  check("软回收站保留三条日志", groupIds.every((id) => fs.existsSync(groupDirs.get(id))));
  const afterDelete = await manager.payload({});
  const afterDeleteIds = new Set(afterDelete.sessions.map((row) => row.id));
  check("删除后列表立即不含这三条", groupIds.every((id) => !afterDeleteIds.has(id)));
  check("删除后列表无「未分组」残留",
    afterDelete.sessions.every((row) => row.workspaceId !== "" && row.workspaceId !== undefined));
  const hiddenAfterDelete = await manager.payload({ hiddenOnly: true });
  check("删除后 hidden 快照包含三条", groupIds.every((id) => hiddenAfterDelete.trashedIds.includes(id)));
  const afterRefresh = await manager.payload({});
  const afterRefreshIds = new Set(afterRefresh.sessions.map((row) => row.id));
  check("刷新（再次拉取列表）后仍不含这三条", groupIds.every((id) => !afterRefreshIds.has(id)));
  check("回收站里 3 条都在",
    afterRefresh.trash.count === trashBefore + 3
      && groupIds.every((id) => afterRefresh.trash.entries.some((entry) => entry.id === id)));
  note(`批量删除后 rows=${afterRefresh.sessions.length} trash=${afterRefresh.trash.count} 未分组=${afterRefresh.sessions.filter((row) => row.workspaceId === "").length}`);
  const restoredGroup = await manager.restore(groupDelete.map((item) => item.trashId));
  check("批量恢复三条均成功", restoredGroup.every((item) => item.ok === true));
  check("批量恢复无需重启", restoredGroup.every((item) => item.restartRequired === false));
  check("恢复后回收站条目全部移除",
    groupDelete.every((item) => !fs.existsSync(path.join(trashRoot, item.trashId))));
  const afterGroupRestore = await manager.payload({});
  const afterGroupRestoreRows = new Map(afterGroupRestore.sessions.map((row) => [row.id, row]));
  check("恢复后立即回到原工作区分组（不重启、不重新挂载）",
    groupIds.every((id) => afterGroupRestoreRows.get(id) && afterGroupRestoreRows.get(id).workspaceId === "ws-a"));
  check("恢复后回收站回到删除前数量", afterGroupRestore.trash.count === trashBefore);

  // 14b. 批量彻底清理：不可恢复；日志删除、墓碑隐藏 live 残留
  const regrab = await manager.removeToTrash(groupIds);
  const groupPurge = await manager.purge(regrab.map((item) => item.trashId), false);
  check("批量彻底清理三条均成功", groupPurge.results.every((item) => item.ok === true));
  check("批量彻底清理删除全部日志", groupIds.every((id) => !fs.existsSync(groupDirs.get(id))));
  const afterPurge = await manager.payload({});
  const afterPurgeIds = new Set(afterPurge.sessions.map((row) => row.id));
  check("清理后列表不含三条且无未分组",
    groupIds.every((id) => !afterPurgeIds.has(id))
      && afterPurge.sessions.every((row) => row.workspaceId !== "" && row.workspaceId !== undefined));
  check("清理后回收站恢复原数量", afterPurge.trash.count === trashBefore);
  const hiddenAfterPurge = await manager.payload({ hiddenOnly: true });
  check("清理后 hidden 快照按墓碑隐藏", groupIds.every((id) => hiddenAfterPurge.purgedIds.includes(id)));
  host.live.delete(groupIds[1]);

  // 14c. 旧版物理回收站条目仍可恢复（向后兼容）
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

  // 16. 宿主查找路径：移动后用宿主同一条磁盘扫描路径打开、可再次移回、来回两次无脏数据
  const rtId = "session-17171717-1717-4717-8717-171717171717";
  const rtEvents = [
    { type: "user/message", data: { content: "hello" } },
    { type: "assistant/message", data: { content: "hi" } },
    { type: "user/message", data: { content: "again" } },
    { type: "assistant/message", data: { content: "ok" } }
  ];
  seedSession(host, { id: rtId, cwd: wsDirA, title: "Greeting", events: rtEvents, zstd: true });
  const rtDirA = sessionDirOf(sessionsRoot, wsDirA, rtId);
  const rtDirB = sessionDirOf(sessionsRoot, wsDirB, rtId);

  const rt1 = await manager.move(rtId, "ws-b");
  check("往返：A→B 移动成功且事件数不变", rt1.ok === true && rt1.eventCount === 4 && rt1.frames === 5);
  const rtOpenB = host.hostOpen(rtId);
  check("往返：A→B 后宿主扫描路径能打开并读到事件",
    !!rtOpenB && rtOpenB.header.cwd === wsDirB && rtOpenB.events.length === 4);
  check("往返：A→B 后 sessionPaths 指向工作区路径而不是会话目录",
    pathKey(host.registry.sessionPaths.get(rtId)) === pathKey(wsDirB));
  check("往返：A→B 后 headers 索引是新的 cwd",
    host.registry.headers.get(rtId) && host.registry.headers.get(rtId).cwd === wsDirB);
  check("往返：A→B 后源工作区不再包含、目标工作区包含",
    !host.registry.get("ws-a").sessionIds.includes(rtId)
      && host.registry.get("ws-b").sessionIds.includes(rtId));
  check("往返：移动时用宿主 locate 算出了目标路径",
    host.locateCalls.some((call) => call.id === rtId && pathKey(call.cwd) === pathKey(wsDirB)));
  const rtPayloadB = await manager.payload({});
  check("往返：A→B 后列表在 B 分组且只有一条",
    rtPayloadB.sessions.filter((row) => row.id === rtId).length === 1
      && rtPayloadB.sessions.find((row) => row.id === rtId).workspaceId === "ws-b");

  const rt2 = await manager.move(rtId, "ws-a");
  check("往返：B→A 移回成功且事件数不变", rt2.ok === true && rt2.eventCount === 4);
  const rtOpenA = host.hostOpen(rtId);
  check("往返：B→A 后宿主扫描路径仍能打开并读到事件",
    !!rtOpenA && rtOpenA.header.cwd === wsDirA && rtOpenA.events.length === 4);
  const rtPayloadA = await manager.payload({});
  check("往返：B→A 后列表回到 A 分组且 B 分组消失",
    rtPayloadA.sessions.find((row) => row.id === rtId).workspaceId === "ws-a"
      && !host.registry.get("ws-b").sessionIds.includes(rtId));

  const rt3 = await manager.move(rtId, "ws-b");
  const rt4 = await manager.move(rtId, "ws-a");
  check("往返：再连续来回一次仍成功", rt3.ok === true && rt4.ok === true && rt4.eventCount === 4);
  const dirsWithId = [];
  for (const projectDir of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const candidate = path.join(sessionsRoot, projectDir.name, rtId);
    if (fs.existsSync(candidate)) dirsWithId.push(candidate);
  }
  check("往返：磁盘上只有一份会话目录", dirsWithId.length === 1 && pathKey(dirsWithId[0]) === pathKey(rtDirA));
  const rtFinal = await manager.payload({});
  check("往返：列表里没有重复条目",
    rtFinal.sessions.filter((row) => row.id === rtId).length === 1);
  check("往返：没有「未分组」错位条目",
    rtFinal.sessions.filter((row) => row.id === rtId && row.workspaceId === "").length === 0);
  check("往返：最终仍在 A 分组", rtFinal.sessions.find((row) => row.id === rtId).workspaceId === "ws-a");
  check("往返：源目录 B 已清理", !fs.existsSync(rtDirB) && fs.existsSync(rtDirA));

  // 17. 目标工作区已有同名会话目录：明确冲突、源端不动
  const clashId = "session-18181818-1818-4818-8818-181818181818";
  seedSession(host, { id: clashId, cwd: wsDirA, title: "clash", events: rtEvents, zstd: true });
  const clashTarget = sessionDirOf(sessionsRoot, wsDirB, clashId);
  fs.mkdirSync(clashTarget, { recursive: true });
  fs.writeFileSync(path.join(clashTarget, LOG_NAME), encodeLog(
    [JSON.stringify({ type: "session", version: 4, id: "session-19191919-1919-4919-8919-191919191919", createdAt: 1000, cwd: wsDirB, isSeeded: false, delegationDepth: 0 })].join("\n") + "\n",
    true
  ));
  const clashMove = await manager.move(clashId, "ws-b");
  check("同名目录：返回 TARGET_EXISTS 且不回滚源", clashMove.ok === false && clashMove.error === "TARGET_EXISTS"
    && fs.existsSync(sessionDirOf(sessionsRoot, wsDirA, clashId)));
  fs.rmSync(clashTarget, { recursive: true, force: true });

  // 18. 列表暂时失败时仍能移回（用宿主 stat 兜底，不再报「目标消息不存在」）
  const originalList = host.query.listSessions;
  host.query.listSessions = async () => { throw new Error("temporary list failure"); };
  const fallbackMove = await manager.move(clashId, "ws-b");
  host.query.listSessions = originalList;
  check("列表失败时移动仍成功（stat 兜底）", fallbackMove.ok === true && fallbackMove.eventCount === 4);
  check("列表失败时移动后宿主扫描路径可打开",
    host.hostOpen(clashId) && host.hostOpen(clashId).events.length === 4);

  // 19. 旧插件留下的「整段压成一帧」坏日志：移动时把事件行拆成独立帧，事件不丢
  const salvageId = "session-20202020-2020-4020-8020-202020202020";
  const salvageDir = sessionDirOf(sessionsRoot, wsDirA, salvageId);
  fs.mkdirSync(salvageDir, { recursive: true });
  const salvageText = [JSON.stringify({
    type: "session", version: 4, id: salvageId, createdAt: 1000, cwd: wsDirA, isSeeded: false, delegationDepth: 0
  })].concat(rtEvents.map((event) => JSON.stringify(event))).join("\n") + "\n";
  fs.writeFileSync(path.join(salvageDir, LOG_NAME), zlib.zstdCompressSync(Buffer.from(salvageText, "utf8")));
  host.headers.set(salvageId, { type: "session", version: 4, id: salvageId, createdAt: 1000, cwd: wsDirA, isSeeded: false, delegationDepth: 0 });
  const salvageMove = await manager.move(salvageId, "ws-b");
  note(`坏日志修复 salvaged=${salvageMove.salvaged} frames=${salvageMove.frames} events=${salvageMove.eventCount}`);
  check("坏日志：移动成功并保留全部事件", salvageMove.ok === true && salvageMove.eventCount === 4);
  check("坏日志：首帧里的事件被拆成独立帧", salvageMove.salvaged === 4 && salvageMove.frames === 5);
  const salvageOpen = host.hostOpen(salvageId);
  check("坏日志：移动后宿主扫描路径可读且事件完整",
    !!salvageOpen && salvageOpen.header.cwd === wsDirB && salvageOpen.events.length === 4);

  // 20. live 会话移动：live 对象与持久化写状态都必须重定向
  const liveRtId = "session-21212121-2121-4121-8121-212121212121";
  seedSession(host, { id: liveRtId, cwd: wsDirA, title: "live roundtrip", events: rtEvents, zstd: true });
  host.live.add(liveRtId);
  host.owned.add(liveRtId);
  const liveBefore = host.liveObjects.get(liveRtId);
  const liveMoveRt = await manager.move(liveRtId, "ws-b");
  const liveAfter = host.liveObjects.get(liveRtId) || liveBefore;
  check("live 往返：移动成功且无需重启", liveMoveRt.ok === true && liveMoveRt.restartRequired === false);
  check("live 往返：live header/meta/cwd 已重定向",
    liveAfter && liveAfter.header.cwd === wsDirB && liveAfter.meta.cwd === wsDirB && liveAfter.cwd === wsDirB);
  check("live 往返：持久化 states.meta.cwd 已重定向",
    host.states.get(liveRtId) && host.states.get(liveRtId).meta.cwd === wsDirB);
  check("live 往返：宿主扫描路径可打开", host.hostOpen(liveRtId)
    && host.hostOpen(liveRtId).header.cwd === wsDirB && host.hostOpen(liveRtId).events.length === 4);
  host.live.delete(liveRtId);
  host.owned.delete(liveRtId);

  // 21. 「删除 / 未分组」若只是普通会话标题，应正常保留，不是墓碑
  const titleDeleteId = "session-24242424-2424-4424-8424-242424242424";
  seedSession(host, { id: titleDeleteId, cwd: wsDirA, title: "删除 未分组", events: rtEvents, zstd: true });
  const titlePayload = await manager.payload({});
  const titleRow = titlePayload.sessions.find((row) => row.id === titleDeleteId);
  const titleHidden = await manager.payload({ hiddenOnly: true });
  check("标题为「删除」的普通会话仍按所在工作区分组",
    !!titleRow && titleRow.workspaceId === "ws-a" && titleRow.title === "删除 未分组");
  check("标题为「删除」的普通会话不会被墓碑/回收站过滤",
    !titleHidden.trashedIds.includes(titleDeleteId) && !titleHidden.purgedIds.includes(titleDeleteId));

  // 22. 只有 header、没有事件（真机 Greeting 的现状）也能移动与打开
  const headerOnlyId = "session-23232323-2323-4323-8323-232323232323";
  seedSession(host, { id: headerOnlyId, cwd: wsDirA, title: "Greeting", events: [], zstd: true });
  const headerOnlyMove = await manager.move(headerOnlyId, "ws-b");
  check("空日志：移动成功且事件数为 0", headerOnlyMove.ok === true && headerOnlyMove.eventCount === 0);
  check("空日志：移动后宿主扫描路径可打开", host.hostOpen(headerOnlyId)
    && host.hostOpen(headerOnlyId).header.cwd === wsDirB && host.hostOpen(headerOnlyId).events.length === 0);
  const headerOnlyBack = await manager.move(headerOnlyId, "ws-a");
  check("空日志：可再次移回并打开", headerOnlyBack.ok === true
    && host.hostOpen(headerOnlyId).header.cwd === wsDirA);

  // 23. 跨盘符：rename 抛 EXDEV 时必须回退到 cp + rm，且事件不丢
  const exdevId = "session-25252525-2525-4525-8525-252525252525";
  seedSession(host, { id: exdevId, cwd: wsDirA, title: "exdev", events: rtEvents, zstd: true });
  const realRename = fsp.rename;
  let exdevHits = 0;
  fsp.rename = async (from, to) => {
    exdevHits += 1;
    throw Object.assign(new Error(`cross-device link not permitted: ${from} -> ${to}`), { code: "EXDEV" });
  };
  let exdevMove;
  try {
    exdevMove = await manager.move(exdevId, "ws-b");
  } finally {
    fsp.rename = realRename;
  }
  check("跨盘符：EXDEV 触发并回退成功", exdevHits >= 1 && exdevMove.ok === true && exdevMove.eventCount === 4);
  check("跨盘符：目标工作区可打开且事件完整", !!host.hostOpen(exdevId)
    && host.hostOpen(exdevId).header.cwd === wsDirB && host.hostOpen(exdevId).events.length === 4);
  check("跨盘符：源目录已清理", !fs.existsSync(sessionDirOf(sessionsRoot, wsDirA, exdevId)));
  const exdevBack = await manager.move(exdevId, "ws-a");
  check("跨盘符：可再次移回", exdevBack.ok === true && !!host.hostOpen(exdevId)
    && host.hostOpen(exdevId).header.cwd === wsDirA);

  // 24. 旧版移动留下的 corrupt header（缺 type / 混入 title）：移动时修复，宿主可打开
  const legacyId = "session-26262626-2626-4626-8626-262626262626";
  seedSession(host, { id: legacyId, cwd: wsDirA, title: "Greeting", events: rtEvents, zstd: true });
  const legacyFile = path.join(sessionDirOf(sessionsRoot, wsDirA, legacyId), LOG_NAME);
  const legacyBadHeader = {
    version: 4, id: legacyId, createdAt: 1000, cwd: wsDirA,
    isSeeded: false, delegationDepth: 0, title: "Greeting"
  };
  const legacyText = [JSON.stringify(legacyBadHeader)]
    .concat(rtEvents.map((event) => JSON.stringify(event))).join("\n") + "\n";
  fs.writeFileSync(legacyFile, encodeLog(legacyText, true));
  check("旧坏 header：宿主确实打不开", host.hostOpen(legacyId) === null);
  const legacyMove = await manager.move(legacyId, "ws-b");
  check("旧坏 header：移动成功且事件不丢", legacyMove.ok === true && legacyMove.eventCount === 4);
  const legacyTextAfter = decodeLog(fs.readFileSync(path.join(sessionDirOf(sessionsRoot, wsDirB, legacyId), LOG_NAME)));
  const legacyHeaderAfter = JSON.parse(legacyTextAfter.split("\n")[0]);
  check("旧坏 header：补回 type 并剔除非法字段",
    legacyHeaderAfter.type === "session"
      && !Object.hasOwn(legacyHeaderAfter, "title")
      && legacyHeaderAfter.cwd === wsDirB);
  check("旧坏 header：移动后宿主可打开并读到事件",
    !!host.hostOpen(legacyId) && host.hostOpen(legacyId).events.length === 4);

  // 25. 宿主内存里的 header 仍指旧 cwd：scan 磁盘按目录名找到真实源目录
  const staleId = "session-27272727-2727-4727-8727-272727272727";
  seedSession(host, { id: staleId, cwd: wsDirB, title: "stale", events: rtEvents, zstd: true });
  const staleHeader = {
    type: "session", version: 4, id: staleId, createdAt: 1000,
    cwd: wsDirA, isSeeded: false, delegationDepth: 0
  };
  host.headers.set(staleId, staleHeader);
  const realListSessions = host.query.listSessions;
  host.query.listSessions = async () => [{ header: staleHeader, live: false, running: false }];
  let staleMove;
  try {
    staleMove = await manager.move(staleId, "ws-a");
  } finally {
    host.query.listSessions = realListSessions;
  }
  check("旧内存 header：扫描找到真实目录并移动成功",
    staleMove.ok === true && staleMove.moved === true && staleMove.eventCount === 4);
  check("旧内存 header：目标可打开且事件完整", !!host.hostOpen(staleId)
    && host.hostOpen(staleId).header.cwd === wsDirA && host.hostOpen(staleId).events.length === 4);
  check("旧内存 header：旧目录已清理", !fs.existsSync(sessionDirOf(sessionsRoot, wsDirB, staleId)));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(report.join("\n"));
  console.log(`\n${report.length} 项真实文件系统端到端检查全部通过`);
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exitCode = 1;
});
