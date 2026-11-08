# 消息管家（dsh-message-actions）

[English](README-en.md) | **中文**

![version](https://img.shields.io/badge/version-0.2.14-blue)
![npm](https://img.shields.io/badge/npm-v0.2.4-orange)
![license](https://img.shields.io/badge/license-MIT-green)
![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-blue)
[![GitHub repository](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/aijacko/dsh-message-actions)
![awesome](https://img.shields.io/badge/awesome-DSH%20plugin-red)

> **兼容性**：已适配最新版 DSH（`0.2.2-rc.1`），desktop / web profile 均已实测。

**让 DSH 的每一轮对话都可控、可分享、可计量。** 补上宿主缺少的撤回、删除、分享、导出与费用展示，对话数据只在本机流转。

## 适配说明

- 已适配最新版 DSH `0.2.2-rc.1`，desktop / web profile 均已实测。
- 无运行时第三方依赖；不新开端口，接口只接受本机同源请求。
- 升级插件后需完全退出并重启 DSH，仅刷新页面不足以加载新的客户端代码。

## 功能一览

| 功能 | 说明 |
|---|---|
| 撤回 | 提问行一键撤回整轮问答，原文与附件回到输入框 |
| 删除 | 问行删整轮；工具行删该步，其余步骤不受影响 |
| 删至末尾 | 从该条起清空后续内容 |
| 分享长图 | 多选轮次生成长图 PNG，本地生成、不上传 |
| 导出 Markdown | 多选轮次导出带问答结构的 `.md` |
| 回答统计 | 每条回答下方显示 `tok · 字 · 金额` |
| 费用卡片 | 侧边栏展示余额 / 日用 / 单次，含峰谷提示 |
| 统计表 | Token、时间线、会话成本与预算使用，数据来自本机会话日志 |
| 会话管理 | 搜索、按工作区分组、删除到回收站、恢复与归档 |
| 回收站 | 删除到 `~/.dsh/dsh-message-actions-trash`；恢复无需重启，彻底清理需输入 `OK` |
| 可开关 | 撤回 / 分享 / 导出 / 删除 / 统计 / 费用等均可在设置中关闭 |
| 中英双语 | 跟随 DSH 语言自动切换 |

## 安装

市场：插件 → 插件市场 → 搜索 `dsh-message-actions` → 安装。

按包名：插件 → + 添加插件 → 输入 `dsh-message-actions`；源慢时选中国大陆镜像源。

npm：

```bash
npm install dsh-message-actions
```

本地构建：

```bash
node build.mjs
pnpm add "file:/path/to/dsh-message-actions"
```

- 已发布版本：`0.2.4`；当前源码版本：`0.2.14`（未发布）。
- `file:` 安装是复制语义，改代码后需卸载重装。
- 把包名加入 profile `package.json` 的 `dsh.profile.bundles`；不要在 `cordis.patch.yml` 里重复 `insert`。

## 使用要点

1. 悬停提问行：撤回 / 分享 / 导出 / 删除 / 删至末尾。
2. 悬停工具行：删除该步工具结果，同一步的答行会一并遮蔽。
3. 回答下方统计行给出 token、字数与这一条自己的估算金额。
4. 删除采用墓碑式遮蔽：不改写历史日志，刷新、切换会话、重启后都不会复活。
5. 设置 → 插件 → 消息管家：可关闭单项功能、调整确认框与提示音。
6. 设置 → 会话管理可关闭「删除会话」；关闭后界面隐藏入口，宿主也会拒绝删除与彻底清理。
7. 回收站：单条 / 批量恢复即时生效；彻底清理、清空回收站需输入 `OK`。

## 反馈

- 问题与建议：[GitHub Issues](https://github.com/aijacko/dsh-message-actions/issues)
- 许可证：[MIT](LICENSE)
