// 发布 Release 说明（只写入正文，不改 tag / 不发 npm / 不动市场索引）。
//
// 用途：修复并预防 Windows 下 PowerShell 5.1 以 ASCII 发送请求体导致中文变成「?」。
// 本脚本始终用 UTF-8 字节发送 JSON，写入后再回读校验，发现替换字符会报错退出。
//
// 用法：
//   node scripts/release-notes.mjs v0.2.5 release-notes/v0.2.5.md
//
// 说明文件必须是 UTF-8（无 BOM）。Release 已存在则更新正文，不存在则创建。
// 认证顺序：GH_TOKEN / GITHUB_TOKEN 环境变量 → git credential（Git Credential Manager）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const REPO = "aijacko/dsh-message-actions";

function credentialToken() {
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = process.env[key];
    if (value) return value;
  }
  const r = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8"
  });
  const map = {};
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
  }
  if (!map.password) throw new Error("找不到 GitHub 凭据：请设置 GH_TOKEN 或先登录 GCM");
  return map.password;
}

/** 统一以 UTF-8 字节发送，避免调用方（PowerShell）按本地代码页转码。 */
async function api(path, init, token) {
  const res = await fetch("https://api.github.com" + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "User-Agent": "dsh-release-notes",
      "Content-Type": "application/json; charset=utf-8",
      ...(init && init.headers)
    }
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留原始文本用于报错 */
  }
  return { status: res.status, json, text };
}

async function main() {
  const [tag, notesPath] = process.argv.slice(2);
  if (!tag || !notesPath) {
    console.error("用法: node scripts/release-notes.mjs <tag> <notes.md>");
    process.exit(2);
  }
  if (!fs.existsSync(notesPath)) {
    console.error("说明文件不存在: " + notesPath);
    process.exit(2);
  }

  // 读入后按 UTF-8 解码；带 BOM 时去掉，避免正文首字符异常。
  const body = fs.readFileSync(notesPath, "utf8").replace(/^\uFEFF/, "");
  if (/\uFFFD/.test(body)) {
    console.error("说明文件不是有效 UTF-8，请另存为 UTF-8 后再发布");
    process.exit(2);
  }

  const token = credentialToken();
  const payload = Buffer.from(JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false }), "utf8");

  const current = await api("/repos/" + REPO + "/releases/tags/" + encodeURIComponent(tag), { method: "GET" }, token);
  let status;
  if (current.status === 200) {
    status = await api("/repos/" + REPO + "/releases/" + current.json.id, {
      method: "PATCH",
      body: Buffer.from(JSON.stringify({ body }), "utf8")
    }, token);
  } else if (current.status === 404) {
    status = await api("/repos/" + REPO + "/releases", { method: "POST", body: payload }, token);
  } else {
    throw new Error("查询 Release 失败: HTTP " + current.status + " " + current.text.slice(0, 200));
  }
  if (status.status !== 200 && status.status !== 201) {
    throw new Error("写入 Release 失败: HTTP " + status.status + " " + status.text.slice(0, 300));
  }

  const verify = await api("/repos/" + REPO + "/releases/tags/" + encodeURIComponent(tag), { method: "GET" }, token);
  const stored = String((verify.json && verify.json.body) || "");
  if (stored !== body) {
    throw new Error("回读校验失败：正文与本地文件不一致");
  }
  if (/\?{2,}/.test(stored)) {
    throw new Error("回读发现连续问号，正文仍疑似乱码");
  }
  console.log("release notes ok: " + tag + " (" + stored.length + " chars)");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
