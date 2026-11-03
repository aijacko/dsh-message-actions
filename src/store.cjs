// dsh-message-actions — 费用统计状态文件（宿主侧）。
//
// 只被宿主 index.mjs 引用，不进入客户端产物。
// 官方 @deepseek-ai/dsh-home-paths 与 @deepseek-ai/dsh-atomic-write 属内部包，
// 第三方插件不保证可解析，因此这里自带等价实现：
//   - $DSH_HOME || ~/.dsh
//   - 临时文件写入（mode 0600）→ rename 原子替换（Windows 重试）
//
// 恢复策略：
//   - 文件超过 4MB：记录一次可诊断 warn，直接以默认状态原子重建并恢复可写；
//   - 未超限但 JSON 解析失败：把原文件改名为 cost-state.bad-<时间戳>.json 保留现场；
//   - 版本高于当前版本：按只读快照处理，不回写。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_VERSION = 1;
const FILE_NAME = "cost-state.json";
const DIR_NAME = "dsh-message-actions";
/** 状态文件读取上限：正常只有几 KB，超限视为异常文件，不再解析。 */
const MAX_STATE_BYTES = 4 * 1024 * 1024;

/** 展开 `~` / `~/` 前缀（不处理 Windows 的 %VAR%）。 */
function expandHome(value) {
  const raw = String(value == null ? "" : value);
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

/** DSH home：`$DSH_HOME` 优先，其次 `~/.dsh`。 */
function resolveDshHome(env) {
  const source = env || process.env || {};
  const override = typeof source.DSH_HOME === "string" ? source.DSH_HOME.trim() : "";
  if (override) return path.resolve(expandHome(override));
  return path.join(os.homedir(), ".dsh");
}

/** 状态文件绝对路径。 */
function resolveStatePath(env) {
  return path.join(resolveDshHome(env), "plugins", DIR_NAME, FILE_NAME);
}

/** 空状态（§4.2 字段全集）。 */
function defaultState() {
  return {
    version: STATE_VERSION,
    baselineBalanceCents: null,
    lastBalanceCents: null,
    lastBalanceAt: 0,
    lastAttemptAt: 0,
    lastRouting: null,
    observedSpendTotalCents: 0,
    dailySpendCents: {},
    pendingAdjustmentCents: 0,
    pendingAdjustmentAt: 0,
    correctionCreditCents: 0,
    correctionDebitCents: 0,
    updatedAt: 0
  };
}

function centsOrNull(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function intOr(value, fallback) {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

/**
 * 只认已知字段并补默认值；丢弃未知字段，避免旧版本读写污染。
 * `version` 高于当前版本时置 readOnly（调用方据此跳过写盘）。
 */
function normalizeCostState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { state: base, readOnly: false };
  }
  const version = intOr(raw.version, STATE_VERSION);
  const readOnly = version > STATE_VERSION;
  const daily = {};
  if (raw.dailySpendCents && typeof raw.dailySpendCents === "object") {
    for (const [key, value] of Object.entries(raw.dailySpendCents)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      if (!Number.isFinite(value)) continue;
      daily[key] = Math.round(value);
    }
  }
  const state = {
    version: Math.min(version, STATE_VERSION),
    baselineBalanceCents: centsOrNull(raw.baselineBalanceCents),
    lastBalanceCents: centsOrNull(raw.lastBalanceCents),
    lastBalanceAt: intOr(raw.lastBalanceAt, 0),
    lastAttemptAt: intOr(raw.lastAttemptAt, 0),
    lastRouting: typeof raw.lastRouting === "string" ? raw.lastRouting : null,
    observedSpendTotalCents: intOr(raw.observedSpendTotalCents, 0),
    dailySpendCents: daily,
    pendingAdjustmentCents: intOr(raw.pendingAdjustmentCents, 0),
    pendingAdjustmentAt: intOr(raw.pendingAdjustmentAt, 0),
    correctionCreditCents: intOr(raw.correctionCreditCents, 0),
    correctionDebitCents: intOr(raw.correctionDebitCents, 0),
    updatedAt: intOr(raw.updatedAt, 0)
  };
  return { state, readOnly };
}

function badName(filePath) {
  return filePath.replace(/\.json$/i, "") + ".bad-" + Date.now() + ".json";
}

/**
 * 读取状态文件。读失败 / 损坏 → 改名保留现场并返回空状态。
 * 超过 maxBytes（默认 4MB）的文件直接忽略，避免异常大文件解析阻塞宿主启动。
 * @returns {{ state, readOnly, recovered: boolean }}
 */
function loadCostState(filePath, logger, maxBytes) {
  const warn = (msg) => {
    if (logger && typeof logger.warn === "function") logger.warn(`[dsh-message-actions] ${msg}`);
  };
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_STATE_BYTES;
  let text;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > limit) {
      // 超限文件不解析，直接以默认状态重建；不生成 .bad 副本，也不进入只读。
      // 警告保留体积与阈值，便于用户日后排查（不弹用户可见错误框）。
      warn(`cost state too large (${stat.size} bytes, limit ${limit}), rebuilt with defaults`);
      const state = defaultState();
      try {
        saveCostState(filePath, state);
      } catch (err) {
        // 重建写盘失败不阻塞启动：内存状态仍可正常记账，下次 persist 会重试。
        warn(`rebuilt cost state write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { state, readOnly: false, recovered: true };
    }
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { state: defaultState(), readOnly: false, recovered: false };
    warn(`read cost state failed: ${err instanceof Error ? err.message : String(err)}`);
    return { state: defaultState(), readOnly: false, recovered: false };
  }
  try {
    const parsed = JSON.parse(text);
    const { state, readOnly } = normalizeCostState(parsed);
    return { state, readOnly, recovered: false };
  } catch (err) {
    try {
      fs.renameSync(filePath, badName(filePath));
      warn(`cost state corrupted, moved aside: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      /* 改名失败也不阻塞启动 */
    }
    return { state: defaultState(), readOnly: false, recovered: true };
  }
}

/**
 * 同步退避等待：优先 Atomics.wait（不占 CPU），不可用时才短暂自旋。
 * 仅在 rename 因文件占用短暂失败时使用，单次 ≤ 100ms。
 */
function waitBriefly(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return;
  } catch {
    /* 环境不支持 Atomics.wait，退回自旋 */
  }
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* busy wait（兜底，总时长 ≤ 100ms） */
  }
}

/**
 * 原子写：同目录临时文件（0600）→ rename 覆盖。
 * 失败时删除临时文件并把异常抛给调用方（调用方只记 warn，保留内存状态）。
 */
function saveCostState(filePath, state) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, "." + path.basename(filePath) + "." + process.pid + "." + Date.now() + ".tmp");
  const body = JSON.stringify(state, null, 2) + "\n";
  let handle;
  try {
    handle = fs.openSync(tmp, "wx", 0o600);
    fs.writeSync(handle, body, null, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
  } catch (err) {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      if (i === 4) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw err;
      }
      // Windows 上目标文件被占用时 rename 会短暂失败，退避重试。
      // 优先 Atomics.wait（宿主为 Node 主进程，可阻塞但不占 CPU）；不可用时才短暂自旋。
      waitBriefly(20 + i * 20);
    }
  }
}

/** 90 天日累计裁剪（就地替换 state.dailySpendCents）。 */
function pruneDaily(daily, nowMs, keepDays) {
  const days = Number.isFinite(keepDays) ? keepDays : 90;
  const beijingKey = (ms) => {
    const d = new Date(ms + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  const cutoff = beijingKey((Number.isFinite(nowMs) ? nowMs : Date.now()) - days * 24 * 3600 * 1000);
  const out = {};
  for (const [key, value] of Object.entries(daily || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (key < cutoff) continue;
    if (!Number.isFinite(value)) continue;
    out[key] = Math.round(value);
  }
  return out;
}

module.exports = {
  STATE_VERSION,
  MAX_STATE_BYTES,
  expandHome,
  resolveDshHome,
  resolveStatePath,
  defaultState,
  normalizeCostState,
  loadCostState,
  saveCostState,
  pruneDaily
};
