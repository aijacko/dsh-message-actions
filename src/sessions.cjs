'use strict';

/**
 * dsh-message-actions — 会话管理的纯函数（无 DSH 依赖，可离线测试）。
 *
 * 这里只放不产生副作用的逻辑：参数校验、路径包含判断、会话目录命名
 * （与宿主 session-persistence 的公开命名约定一致）、标题快照取值、
 * 回收站元数据校验与排序。真正的文件移动 / 删除在 session-manager.mjs。
 */

const path = require('node:path');

// ---------------------------------------------------------------------------
// 标识符校验
// ---------------------------------------------------------------------------

/** 会话 id：宿主生成的 `session-<uuid>`；禁止任何路径分隔符与控制字符。 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
/** 工作区 id：宿主持久化的 UUID。 */
const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
/** 回收站条目 id：本插件生成，带 `trash-` 前缀便于人工识别。 */
const TRASH_ID_RE = /^trash-[A-Za-z0-9-]{8,80}$/;

function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

function isWorkspaceId(value) {
  return typeof value === 'string' && WORKSPACE_ID_RE.test(value);
}

function isTrashId(value) {
  return typeof value === 'string' && TRASH_ID_RE.test(value);
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32';

/**
 * child 是否等于 parent 或位于 parent 之内（只做字符串级规范化，不触碰磁盘）。
 * Windows 下大小写不敏感，避免 `C:\A` 与 `c:\a` 被误判为目录穿越。
 */
function isContainedPath(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false;
  if (parent === '' || child === '') return false;
  const base = path.resolve(parent);
  const target = path.resolve(child);
  const a = IS_WINDOWS ? base.toLowerCase() : base;
  const b = IS_WINDOWS ? target.toLowerCase() : target;
  if (a === b) return true;
  return b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/**
 * 会话 id 的单段路径编码（宿主公开约定）：
 * 仅 [A-Za-z0-9._-] 原样保留，其余 UTF-16 码元写成 `~XXXX`。
 * 这里为无法提供 `sessionPersistence.locate` 的旧宿主保留兜底实现。
 */
function encodeSegment(raw) {
  const text = String(raw == null ? '' : raw);
  if (text === '') throw new Error('cannot encode an empty path segment');
  if (text === '.') return '~002E';
  if (text === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * 会话所属项目目录的目录名（宿主公开约定）：
 * 路径分隔符与盘符收敛为单个 `-`，其余不安全码元按 `~XXXX` 转义，
 * 首尾用 `--` 包裹并截断到 251 字符。
 */
function projectKeyOf(cwd) {
  const text = String(cwd == null ? '' : cwd);
  if (text === '') throw new Error('cannot encode an empty project path');
  let readable = '';
  let separated = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separated) readable += '-';
      separated = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separated = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separated = false;
    }
  }
  const head = readable.replace(/^-+/, '') || 'root';
  return '--' + head.slice(0, 251) + '--';
}

/** 会话日志所在目录：`<root>/<projectKey(cwd)>/<encodeSegment(id)>`。 */
function sessionDirOf(root, cwd, id) {
  if (cwd === undefined || cwd === null || cwd === '') return path.join(root, '_no-cwd', encodeSegment(id));
  return path.join(root, projectKeyOf(cwd), encodeSegment(id));
}

// ---------------------------------------------------------------------------
// 标题与元数据
// ---------------------------------------------------------------------------

/** 从宿主的标题快照（字符串 / {title} / {value:{title}}）取出纯文本。 */
function titleTextOf(snapshot) {
  if (typeof snapshot === 'string') return snapshot.trim();
  if (!snapshot || typeof snapshot !== 'object') return '';
  if (typeof snapshot.title === 'string') return snapshot.title.trim();
  if (snapshot.value && typeof snapshot.value.title === 'string') return snapshot.value.title.trim();
  return '';
}

/** 回收站元数据的字段白名单与长度上限（防止被篡改的 meta.json 撑爆界面）。 */
const TRASH_META_VERSION = 1;
const MAX_TITLE_LENGTH = 300;
const MAX_PATH_LENGTH = 4096;

/**
 * 校验并收敛一份回收站元数据。任何必需字段不合法都返回 null，
 * 调用方据此跳过损坏条目，而不是把任意 JSON 当路径使用。
 */
function normalizeTrashMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== TRASH_META_VERSION) return null;
  if (!isTrashId(raw.trashId)) return null;
  if (!isSessionId(raw.id)) return null;
  const header = raw.header;
  if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
  if (header.id !== raw.id) return null;
  if (typeof header.cwd !== 'string' || header.cwd.length > MAX_PATH_LENGTH) return null;
  if (!Number.isFinite(raw.deletedAt) || raw.deletedAt <= 0) return null;
  if (typeof raw.originalDir !== 'string' || raw.originalDir.length > MAX_PATH_LENGTH) return null;
  const sizeBytes = Number.isFinite(raw.sizeBytes) && raw.sizeBytes >= 0 ? Math.trunc(raw.sizeBytes) : 0;
  const title = typeof raw.title === 'string' ? raw.title.slice(0, MAX_TITLE_LENGTH) : '';
  const workspaceId = typeof raw.workspaceId === 'string' && isWorkspaceId(raw.workspaceId) ? raw.workspaceId : '';
  const workspaceTitle = typeof raw.workspaceTitle === 'string'
    ? raw.workspaceTitle.slice(0, MAX_TITLE_LENGTH)
    : '';
  return {
    version: TRASH_META_VERSION,
    trashId: raw.trashId,
    id: raw.id,
    deletedAt: Math.trunc(raw.deletedAt),
    title,
    header,
    originalDir: raw.originalDir,
    sizeBytes,
    workspaceId,
    workspaceTitle
  };
}

// ---------------------------------------------------------------------------
// 排序
// ---------------------------------------------------------------------------

function timeOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** 会话按创建时间倒序；时间相同按 id 稳定排序。 */
function sortSessionsNewestFirst(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort((left, right) => {
    const delta = timeOf(right && right.createdAt) - timeOf(left && left.createdAt);
    if (delta !== 0) return delta;
    return String(left && left.id).localeCompare(String(right && right.id));
  });
}

/** 回收站按删除时间倒序。 */
function sortTrashNewestFirst(entries) {
  return (Array.isArray(entries) ? entries.slice() : []).sort((left, right) => {
    return (right && right.deletedAt ? right.deletedAt : 0) - (left && left.deletedAt ? left.deletedAt : 0);
  });
}

module.exports = {
  SESSION_ID_RE,
  WORKSPACE_ID_RE,
  TRASH_ID_RE,
  TRASH_META_VERSION,
  MAX_TITLE_LENGTH,
  isSessionId,
  isWorkspaceId,
  isTrashId,
  isContainedPath,
  encodeSegment,
  projectKeyOf,
  sessionDirOf,
  titleTextOf,
  normalizeTrashMeta,
  sortSessionsNewestFirst,
  sortTrashNewestFirst
};
