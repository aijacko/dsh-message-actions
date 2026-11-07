// dsh-message-actions — 会话管理（删除到回收站 / 恢复 / 彻底清理 / 移动到工作区）。
//
// 数据源与写入都走宿主官方服务：
//   - sessionQuery.listSessions / readSession / readTitleSnapshots：枚举与正文；
//   - sessionPersistence.open / create / append / stat：删除、恢复与迁移日志；
//   - workspaceRegistry：工作区分组、归档集与成员关系。
//
// 删除采用「整目录移入回收站」而不是删文件：恢复时原样移回，宿主无需迁移格式。
// 移动工作区采用「按事件重放」：用官方 create + append 生成目标工作区的新日志，
// 校验 header.cwd 与事件数量后才删除备份，避免半成品日志污染历史。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
const STAGING_PREFIX = "_staging-";
const APPEND_CHUNK = 400;
const MAX_BATCH = 50;
const MAX_TRASH_ENTRIES = 500;
const TITLE_CACHE_MS = 20000;
const TITLE_CACHE_MAX = 600;

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

export function createSessionManager(ctx) {
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
        const sessionDir = path.join(dir, TRASH_SESSION_DIR);
        entries.push(Object.assign({}, meta, {
          missing: !isDirectory(sessionDir)
        }));
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
      if (!isContainedPath(dir, sessionDir) || !isDirectory(sessionDir)) return null;
      return { meta, dir, sessionDir };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 列表
  // -------------------------------------------------------------------------

  async function payload() {
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
        canMove: false,
        canReset: false
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
    const ids = [];
    for (const record of list) {
      const id = record && record.header && record.header.id;
      if (typeof id === "string" && isSessionId(id)) ids.push(id);
    }
    const titles = await titlesFor(ids);
    const running = runningSet();
    const archived = archivedSet();
    const rows = [];
    for (const record of list) {
      const header = record && record.header;
      if (!header || typeof header.id !== "string") continue;
      const id = header.id;
      const ws = workspaceOf(header.cwd, id, wsList);
      rows.push({
        id,
        title: titles.get(id) || "",
        cwd: typeof header.cwd === "string" ? header.cwd : "",
        workspaceId: ws ? ws.id : "",
        workspaceTitle: ws ? ws.title : "",
        createdAt: header.createdAt !== undefined ? header.createdAt : 0,
        live: record.live === true,
        running: running.has(id),
        archived: archived.has(id),
        child: typeof header.parentSession === "string" && header.parentSession !== ""
      });
    }
    const sorted = sortSessionsNewestFirst(rows);
    let trashEntries = [];
    try {
      trashEntries = await readTrashEntries();
    } catch (err) {
      warn(`trash list failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      canMove: typeof sp.locate === "function" && typeof sp.create === "function" && typeof sp.stat === "function",
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

  function locatedDir(sp, header, fallbackRoot) {
    let logPath = "";
    try {
      if (typeof sp.locate === "function") {
        const located = sp.locate(header);
        if (located && typeof located.path === "string") logPath = located.path;
      }
    } catch {
      logPath = "";
    }
    if (logPath !== "") return path.dirname(logPath);
    return sessionDirOf(fallbackRoot, header.cwd, header.id);
  }

  function insideRoot(root, dir) {
    return isContainedPath(root, dir) && normalizePathKey(root) !== normalizePathKey(dir);
  }

  /** 把源会话目录里除日志以外的附属文件复制到新目录（日志由 create+append 重建）。 */
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

  async function attachToWorkspace(sessionId, header, sessionDir) {
    const serviceValue = registry();
    if (!serviceValue) return false;
    try {
      if (serviceValue.headers && typeof serviceValue.headers.set === "function") {
        serviceValue.headers.set(sessionId, header);
      }
      if (serviceValue.sessionPaths && typeof serviceValue.sessionPaths.set === "function") {
        serviceValue.sessionPaths.set(sessionId, sessionDir);
      }
      if (serviceValue.missingSessionPaths && typeof serviceValue.missingSessionPaths.delete === "function") {
        serviceValue.missingSessionPaths.delete(sessionId);
      }
    } catch {
      /* 旧宿主没有这些内部索引：交给重启后的启动索引 */
    }
    // 按会话 header 的 cwd 找目标工作区；sessionDir 是会话目录，不能拿来比。
    const key = normalizePathKey(header && header.cwd);
    for (const entity of serviceValue.list()) {
      if (!entity || normalizePathKey(entity.path) !== key) continue;
      if (typeof entity.attachSession !== "function") return false;
      try {
        await entity.attachSession(sessionId);
        return true;
      } catch (err) {
        warn(`could not attach session "${sessionId}" to workspace: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
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

  function liveSession(id) {
    try {
      const agents = service("agents");
      if (agents && typeof agents.get === "function" && agents.get(id) !== undefined) return true;
    } catch {
      /* ignore */
    }
    try {
      const sessions = service("sessions");
      if (sessions && typeof sessions.get === "function" && sessions.get(id) !== undefined) return true;
    } catch {
      /* ignore */
    }
    return false;
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
    const records = await queryService.listSessions();
    const wsList = workspaces();
    const titles = await titlesFor(ids);
    const trash = await ensureTrashRoot();
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
      if (record.live === true || liveSession(id)) {
        results.push(failureOf(id, "SESSION_LIVE"));
        continue;
      }
      let claim = null;
      let moved = false;
      let staging = "";
      try {
        claim = await sp.open(id, "write");
        await claim.close();
        claim = null;
        const snapshot = await sp.stat(id);
        if (!snapshot || !snapshot.header) {
          results.push(failureOf(id, "TARGET_NOT_FOUND"));
          continue;
        }
        const header = snapshot.header;
        const sourceDir = locatedDir(sp, header, root);
        if (!insideRoot(root, sourceDir)) {
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
        await moveDirectory(sourceDir, path.join(staging, TRASH_SESSION_DIR));
        moved = true;
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
        await detachFromWorkspaces(id);
        forgetTitle(id);
        results.push(resultOf(id, { trashId }));
      } catch (err) {
        if (claim) {
          try {
            await claim.close();
          } catch {
            /* ignore */
          }
        }
        if (moved) {
          // 元数据写失败：把目录放回原位，别留下「看不见又不在回收站」的会话。
          try {
            await fsp.mkdir(path.dirname(locatedDir(sp, record.header, root)), { recursive: true, mode: 0o700 });
            await moveDirectory(path.join(staging, TRASH_SESSION_DIR), locatedDir(sp, record.header, root));
          } catch (rollbackError) {
            warn(`could not roll back trashed session "${id}": ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
        }
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
      const { meta, dir, sessionDir } = entry;
      const targetDir = locatedDir(sp, meta.header, root);
      if (!insideRoot(root, targetDir)) {
        results.push(failureOf(trashId, "INTERNAL"));
        continue;
      }
      if (fs.existsSync(targetDir)) {
        results.push(failureOf(trashId, "TRASH_CONFLICT"));
        continue;
      }
      try {
        await fsp.mkdir(path.dirname(targetDir), { recursive: true, mode: 0o700 });
        await moveDirectory(sessionDir, targetDir);
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        await unarchive(meta.id);
        const attached = await attachToWorkspace(meta.id, meta.header, targetDir);
        forgetTitle(meta.id);
        results.push(resultOf(trashId, {
          sessionId: meta.id,
          title: meta.title,
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
    const root = trashRoot();
    if (root === "") return { results: trashIds.map((id) => failureOf(id, "TRASH_UNAVAILABLE")) };
    let targets = trashIds;
    if (all) {
      try {
        targets = (await readTrashEntries()).map((entry) => entry.trashId);
      } catch {
        targets = [];
      }
    }
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
      try {
        await fsp.rm(entry.dir, { recursive: true, force: true });
        await unarchive(entry.meta.id);
        forgetTitle(entry.meta.id);
        results.push(resultOf(trashId, { sessionId: entry.meta.id }));
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
    const records = await queryService.listSessions();
    const record = recordOf(records, sessionId);
    if (!record) return { ok: false, error: "TARGET_NOT_FOUND" };
    if (record.live === true || liveSession(sessionId)) return { ok: false, error: "SESSION_LIVE" };
    const header = record.header;
    const canonical = normalizePathKey(target.path);
    if (normalizePathKey(header.cwd) === canonical) {
      return { ok: true, moved: false, already: true };
    }

    let claim = null;
    let handle = null;
    let sourceDir = "";
    let backupDir = "";
    let staging = "";
    try {
      claim = await sp.open(sessionId, "write");
      await claim.close();
      claim = null;

      const snapshot = await queryService.readSession(sessionId);
      const events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : null;
      if (events === null) return { ok: false, error: "TARGET_NOT_FOUND" };

      sourceDir = locatedDir(sp, header, root);
      if (!insideRoot(root, sourceDir)) return { ok: false, error: "INTERNAL" };
      const trash = await ensureTrashRoot();
      staging = path.join(trash, STAGING_PREFIX + randomUUID());
      if (!isContainedPath(trash, staging)) return { ok: false, error: "INTERNAL" };
      await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
      backupDir = path.join(staging, TRASH_SESSION_DIR);
      await moveDirectory(sourceDir, backupDir);

      const nextHeader = Object.assign({}, header, { cwd: target.path });
      handle = await sp.create(nextHeader);
      for (let index = 0; index < events.length; index += APPEND_CHUNK) {
        await handle.append(events.slice(index, index + APPEND_CHUNK));
      }
      await handle.flush();
      await handle.close();
      handle = null;

      const verify = await sp.stat(sessionId);
      if (!verify || !verify.header || normalizePathKey(verify.header.cwd) !== canonical) {
        throw new Error("moved log did not verify at the target workspace");
      }
      const targetDir = locatedDir(sp, nextHeader, root);
      if (!insideRoot(root, targetDir)) throw new Error("target session path is outside the session root");
      await copyArtifacts(backupDir, targetDir);

      // 源工作区先摘除，再挂到目标；内部索引可用时一并刷新，避免旧 header 命中原分组。
      for (const entity of serviceValue.list()) {
        if (!entity || !Array.isArray(entity.sessionIds) || !entity.sessionIds.includes(sessionId)) continue;
        try {
          await entity.detachSession(sessionId);
        } catch {
          /* ignore */
        }
      }
      const attached = await attachToWorkspace(sessionId, verify.header, targetDir);
      await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      forgetTitle(sessionId);
      return {
        ok: true,
        moved: true,
        sessionId,
        workspaceId,
        workspaceTitle: typeof target.title === "string" ? target.title : target.path,
        restartRequired: !attached
      };
    } catch (err) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* ignore */
        }
      }
      if (staging !== "" && backupDir !== "") {
        // 清掉可能已经生成的目标日志，再把原目录放回原处。
        try {
          const nextHeader = Object.assign({}, header, { cwd: target.path });
          const partialDir = locatedDir(sp, nextHeader, root);
          if (insideRoot(root, partialDir) && isDirectory(partialDir)) {
            await fsp.rm(partialDir, { recursive: true, force: true });
          }
        } catch {
          /* ignore */
        }
        try {
          if (isDirectory(backupDir)) {
            await fsp.mkdir(path.dirname(sourceDir), { recursive: true, mode: 0o700 });
            await moveDirectory(backupDir, sourceDir);
          }
        } catch (rollbackError) {
          warn(`could not roll back moved session "${sessionId}": ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (staging !== "") await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      warn(`move failed for "${sessionId}": ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: "MOVE_FAILED", message: err instanceof Error ? err.message : String(err) };
    }
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

  return { payload, removeToTrash, restore, purge, move, sweepStaging };
}
