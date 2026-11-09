# dsh-message-actions 自测清单与发布流程

适用版本：**0.2.8**（设置页「消息操作」标签底部显示的版本号应与 `package.json` 一致）
目标宿主：DeepSeek Harness 桌面版，profile `desktop`

> 本文描述验收与发布步骤；已执行的发布事实记录在「I. 发布记录」，流程细节见「G」。
> 自动化基线：`node test/check.mjs` 与 `node test/e2e-sessions.mjs` 全部通过；具体项数以脚本实际输出为准。
> 手工验收前请先完成「A. 构建与环境」，并在宿主重启后加载插件。

---

## A. 构建与环境

### A1 本地构建

- [ ] 工作树干净：`git status --short` 无输出。
- [ ] `npm run build` 成功，`lib/` 下 7 个宿主/客户端产物与 `locale/zh.json`、`locale/en.json` 均更新。
- [ ] `node test/check.mjs` 输出 `ALL CHECKS PASSED`。
- [ ] `node test/e2e-sessions.mjs` 输出 `86 项真实文件系统端到端检查全部通过`（以脚本实际输出为准），其中含伪造 Host、跨站 Origin、路径穿越、批量上限、请求体上限与响应头的安全断言。
- [ ] 构建产物中的版本号等于 `package.json` 的 `version`，且没有 `__DMA_VERSION__` / `__DMA_SHARED__` / `__DMA_I18N__` 占位符。

### A2 安装副本

- [ ] 把 `lib/`、`locale/`、`cordis.patch.yml`、`icon.svg`、`package.json` 同步到 profile 的 `node_modules/dsh-message-actions`。
- [ ] 逐文件比对 SHA256，15 个文件全部一致。
- [ ] 完全退出并重启 DSH；宿主侧改动（`session-manager.mjs` / `sessions.cjs` / `index.mjs`）必须重启才生效。

### A3 配置一致性

- [ ] `package.json`、`market/index.json`、`src/i18n.cjs` 的中英文描述一致。
- [ ] 市场索引的作者、仓库地址与 `package.json` 一致。
- [ ] 市场索引的 `versions` 只包含确实已发布到 npm 的版本（发布前不要提前写入）。
- [ ] 图标在浅色 / 深色设置页均清晰可辨。

---

## B. 消息操作（问行 / 工具行）

### B1 入口与开关

- [ ] 悬停问行依次出现：撤回、分享、导出、删除、删至末尾。
- [ ] 悬停工具调用行出现「删除该工具行」；答行没有独立删除入口。
- [ ] 各开关关闭后对应按钮消失，重新开启后恢复；「删除」同时控制问行与工具行入口。
- [ ] 生成回复期间所有按钮置灰，强行触发提示「正在生成回复，请稍后再试」。

### B2 撤回 / 删除 / 删至末尾

- [ ] 撤回确认后整轮消失，原文回填输入框并聚焦。
- [ ] 删除确认后整轮消失；删至末尾从该条截断到会话末尾。
- [ ] 工具行删除只遮蔽该 `(turn, step)`，同一步其它工具结果一并删除，其它步骤保留。
- [ ] 四步不复活：① 刷新页面 ② 切换会话再切回 ③ 重启 DSH ④ 再刷新。
- [ ] 重复删除同一目标提示「目标消息不存在或已被删除」，不写第二块墓碑。
- [ ] 快速双击确认按钮只发一次请求（写锁生效）。

### B3 分享 / 导出

- [ ] 分享 / 导出打开选择面板，默认选中触发轮；支持单选、多选、全选。
- [ ] 分享生成 PNG；内容过高提示「内容过多，无法生成图片」。
- [ ] 导出文件名形如 `dsh-{sessionId}-{YYYYMMDD-HHmm}.md`，只含问 / 答正文。
- [ ] 浮层 `Enter` = 主操作、`Esc` = 关闭；生成中重复按 `Enter` 不重复提交。
- [ ] 关闭浮层后再按 `Enter` 不触发插件动作。

---

## C. 会话管理

### C1 列表与回收站

- [ ] 会话管理页可看到全部工作区分组；运行中、当前打开、已归档、子会话有对应徽标。
- [ ] 搜索标题 / 模型 / 路径 / 工作区有效；无匹配时显示「没有匹配的会话」。
- [ ] 单条删除到回收站 → 侧边栏该行消失；回收站可恢复，恢复后回到原工作区。
- [ ] 批量删除到回收站不要求输入 `OK`，直接执行；删除后列表不出现「未分组」条目。
- [ ] 彻底删除、批量彻底清理与清空回收站需输入 `OK`（大小写不敏感）；口令错误时不执行。
- [ ] 回收站内缺失文件的条目显示「文件缺失」，不阻塞其它操作。

### C2 删除开关与确认策略

- [ ] 设置 → 消息管家 → 会话管理顶部有「删除会话」开关，默认开启。
- [ ] 关闭开关后：会话页「⋯」菜单消失、批量删除按钮消失、回收站「彻底删除 / 批量彻底清理 / 清空回收站」入口消失。
- [ ] 关闭开关后：侧边栏会话菜单不再出现「删除会话」，DOM 兜底菜单同样不追加。
- [ ] 关闭开关后通过非 UI 路径请求 `delete` / `purge`，宿主返回 `SESSIONS_DELETE_DISABLED`（403）且日志未动；恢复、归档与列表读取仍可用。
- [ ] 重新开启后删除入口立即恢复，删除到回收站可直接执行。
- [ ] 文案统一为「删除到回收站」，不再出现「移动到回收站 / 移动会话」。

### C3 归档

- [ ] 批量归档后会话标记 `archived=true`，日志不移动。
- [ ] 取消归档后 `archived=false`，工作区索引同步移除。

---

## D. 费用与统计

### D1 侧边栏费用卡片

- [ ] 余额、日用、单次显示正确；单行 / 多行样式切换即时生效并持久保存。
- [ ] 余额点击可强制刷新；未登录显示「未登录」，仅配置 API key 显示「API key」，服务不可用显示「不可用」。
- [ ] 沿用旧值时显示「沿用中」，悬停显示最近更新时间。
- [ ] 本地模型显示「本地模型 · 无需计费」；第三方未配置价格显示「未配置」且不计入成本。
- [ ] 极小金额显示 `<¥0.01`，无科学计数法。
- [ ] 峰谷时段与价格正确：工作日 09:00–12:00、14:00–18:00 高峰，其余谷价，谷价为高峰 0.5 倍，周末按谷价。
- [ ] 关闭「费用统计」后卡片消失、停止轮询；重新开启后从当前余额继续。

### D2 统计表

- [ ] 统计表显示总 Token、会话数、估算成本、预算使用、缓存命中、运行中。
- [ ] 近 24 小时 / 近 30 天时间线切换正确。
- [ ] 会话超过 100 个时只显示用量前 100 并提示。
- [ ] 预算保存成功 / 非法金额提示 / 保存失败提示三条路径均验证。
- [ ] 第三方价格表与覆盖清单保存后历史重算；JSON 非法时提示且不落盘。
- [ ] 保存预算、保存计费配置时快速双击只提交一次。

---

## E. 设置、主题与声音

- [ ] 设置页只有一个导航项，内含「消息操作」「费用统计」「会话管理」标签；切换标签不丢状态。
- [ ] 消息操作项顺序与 `Config` 一致：撤回、分享、导出、删除、删至末尾、操作确认、回答统计、提示音音色、音量。
- [ ] 提示音：选中即试听；选「关闭」后完成时不再发声；音量 0% 静音、50% 标准、100% 两倍。
- [ ] 中文 / 英文切换后所有按钮、确认框、浮层、设置项、费用卡片文案随之切换，无未翻译键名。
- [ ] **浅色主题**：浮层、会话菜单、统计表、设置页边框与阴影正常，文字对比度足够。
- [ ] **深色主题**：宿主手动切深色后，计费标签、统计徽标、告警徽标、选中行、会话菜单与对话框均保持可读；不出现过暗文字或消失的边框。
- [ ] 系统深浅色切换与宿主手动切换两种路径都验证一遍。

---

## F. 异常、安全与清理

### F1 异常兜底

- [ ] 断开宿主 / 重启宿主过程中点击任意写按钮：提示「无法连接宿主服务，请稍后重试」，不出现未捕获异常。
- [ ] 请求超过 15 秒：提示失败，按钮恢复可点，不永久挂起。
- [ ] 会话已关闭时执行删除 / 撤回：提示「会话不可用」。
- [ ] 宿主未提供附件 / 会话查询服务时：对应功能降级提示，不影响其它功能。
- [ ] 余额取数失败：卡片显示「不可用」或「沿用中」，不显示默认余额。
- [ ] 宿主路由发生未预期异常：客户端收到 500，宿主界面不弹自身错误日志；宿主日志只有一条 warn。

### F2 安全围栏

- [ ] 跨站 / 非回环 Host / `Sec-Fetch-Site: cross-site` 请求返回 403。
- [ ] JSON 响应头含 `no-store`、`nosniff`、`no-referrer`、`same-origin`、CSP `default-src 'none'`。
- [ ] 写请求只接受 `application/json`；超过 1MB 返回 413 并排空；方法不符返回 405。
- [ ] `/messages` 摘要不含 system / developer / 工具结果正文。
- [ ] 插件不向 localStorage、sessionStorage、cookie、IndexedDB 写任何数据。
- [ ] 费用状态文件只含预算、价格表、消费记录，不含任何密钥 / Token / 凭据。

### F3 卸载与清理

- [ ] 禁用插件后：工具行按钮、统计浮层、会话对话框、注入样式均被移除。
- [ ] 重启宿主后插件不再加载，不残留请求轮询。
- [ ] 用户费用状态文件保留（属于用户设置，不含敏感信息）。

---

## G. 从构建到发布的步骤与依赖顺序

> 以下为完整流程说明。0.2.8 已按此流程执行，实际结果见「I. 发布记录」。

### G1 顺序总览

```text
改代码 → 构建 → 测试 → 提交 → 打 tag → 推送 tag
                                   ↓
                               npm publish
                                   ↓
                     读取 npm 发布时间 → 更新 market/index.json → 提交推送
                                   ↓
                        GitHub Release（基于同一 tag 写说明）
```

依赖关系：

1. **构建必须先于测试与提交**：`lib/` 与 `locale/` 不入库，但发布包由 `prepack` 再次构建；提交前先本地构建可提前暴露错误。
2. **tag 必须指向已通过测试的提交**：tag 一旦推送就代表该版本，不再移动。
3. **npm publish 依赖 tag 对应的源码版本**：`package.json` 的 `version` 必须与 tag 去掉前缀后的版本一致。
4. **市场索引依赖 npm 实际发布时间**：`publishTimestamp` 必须取 npm registry 的真实时间，不能在发布前预填；`versions` 按新→旧排列。
5. **GitHub Release 依赖 tag 存在**：说明文件先本地写好，再用 `scripts/release-notes.mjs` 写入；可早于或晚于 npm，但建议在 npm 成功后执行，便于附上安装方式。
6. **市场条目最后更新**：只有 npm 上确实可安装时才把该版本写进市场索引，避免用户装到 404。
7. **网络路径**：本机直连 GitHub 443 可能超时。可先用一次性 `-c` 参数借道本机代理，不要修改全局 git 配置：
   ```powershell
   git -c http.proxy=http://127.0.0.1:10809 -c https.proxy=http://127.0.0.1:10809 push origin main
   ```
   npm 侧同理，只用 `--proxy/--https-proxy` 单次参数。
8. **编码**：Release 正文一律以 UTF-8 字节提交；PowerShell 5.1 直接传字符串会把中文变成 `?`，因此优先使用 `scripts/release-notes.mjs`（内置 UTF-8 发送与回读校验）。

### G2 具体步骤

1. **确认版本**
   - 修改 `package.json.version`（修复类 +1 patch，功能类 +1 minor）。
   - 同步更新 `src/i18n.cjs` 与 `market/index.json` 的描述（如功能有变）。
   - 确认 `package.json` 顶层声明宿主范围：`"engines": { "dsh": "^0.2.1-rc.1 || ^0.2.2-rc.1" }`。宿主安装校验只认顶层 `engines.dsh`；`dsh.engines.dsh` 仅影响市场徽章展示。缺这段时市场卡片显示「未声明宿主要求」。
   - `npm run build`，确认设置页版本号与新版本一致。

2. **验证**
   - `node test/check.mjs` → `ALL CHECKS PASSED`。
   - `node test/e2e-sessions.mjs` → `86 项真实文件系统端到端检查全部通过`。
   - 按本文 A–F 做真机抽测（至少覆盖删除到回收站、恢复、删除开关、异常兜底、深浅色、防重复提交）。

3. **提交**
   - 提交信息示例：`chore(release): 0.2.8`。
   - 确认工作树干净后再打 tag。

4. **打 tag 并推送**
   - `git tag v0.2.8`
   - `git push origin main`（直连超时时加一次性 `-c http.proxy=... -c https.proxy=...`）
   - `git push origin v0.2.8`
   - 推送后确认远端：`git ls-remote --tags origin "refs/tags/v0.2.8*"` 应同时返回 tag 对象与 `^{}` 指向的提交。
   - tag 一旦推送不再移动；发布后才补的元数据提交（市场索引、徽章）留在 `main` 上，不追打 tag。

5. **发布 npm**
   - `npm publish`（`publishConfig.registry` 指向 `https://registry.npmjs.org`，`access: public`）。
   - 账号未在本机登录 npmjs 时先确认：`npm whoami --registry=https://registry.npmjs.org`；默认 registry 是 npmmirror，直接 `npm whoami` 会返回 `ENEEDAUTH`，属正常现象。
   - 若需要 OTP 而失败，保留完整报错并停止，不要反复重试。
   - 成功时 PUT 返回 `202 Accepted`，registry 提示 “being processed”；此时包可能暂不可见，属正常传播延迟。
   - 校验：`npm view dsh-message-actions versions dist-tags --json --registry=https://registry.npmjs.org` 应包含新版本且 `latest` 指向它。

6. **更新市场索引**
   - 取真实发布时间：直接读 registry 文档的 `time` 字段，例如
     ```powershell
     Invoke-RestMethod -UseBasicParsing -Proxy http://127.0.0.1:10809 -Uri https://registry.npmjs.org/dsh-message-actions
     ```
     `npm view dsh-message-actions time --json` 在刚发布时可能尚未包含新版本，不要用旧结果或估算值。
   - 把 ISO 时间换算为 epoch 秒（PowerShell：`[long]([datetimeoffset]"2026-11-08T16:00:07Z").ToUnixTimeSeconds()`）。
   - 在 `market/index.json` 的 `versions` 数组**头部**插入：
     ```json
     {
       "version": "0.2.8",
       "publishTimestamp": <epoch 秒>,
       "source": { "type": "npm" }
     }
     ```
   - 同步更新顶层描述（如有变化）、README 的 npm 徽章与“已发布版本”一行，提交并推送。
   - 校验：市场里的 `version` 与 npm 最新版本一致，`publishTimestamp` 与 npm 时间一致；`versions` 只保留已真实发布的版本。

7. **GitHub Release**
   - 准备 `release-notes/v0.2.8.md`（UTF-8、无 BOM），正文首行用发布文案，随后附安装方式。
   - 运行 `node scripts/release-notes.mjs v0.2.8 release-notes/v0.2.8.md`。
   - 脚本会回读校验正文；确认中文没有变成 `?`。
   - 认证顺序：`GH_TOKEN` / `GITHUB_TOKEN` 环境变量 → `git credential fill`（Git Credential Manager）。本机通常走 GCM，可先验证：
     ```powershell
     ("protocol=https`nhost=github.com`n`n" | git credential fill)
     ```
   - 本机没有 `gh` CLI，直接用 REST API 时注意：`make_latest` 传布尔值会被拒（`422 For 'properties/make_latest', true is not a string`），省略该字段即可。
   - Release 的 tag 必须与 npm 版本一致。

8. **发布后回归与安装同步**
   - 实际加载目录为 `D:\DATA\AppData_Backup\.dsh\profiles\desktop\node_modules\dsh-message-actions`（不是 `C:\Users\...\.dsh`）。
   - 同步前把旧版整体备份到 `D:\DATA\AppData_Backup\.dsh\plugins\.backup\dsh-message-actions-<时间戳>`。
   - 复制 `lib/`、`locale/`、`package.json`、`cordis.patch.yml`、`icon.svg`、`LICENSE`、`README.md`、`README-en.md`；旧命名 `README.cn.md` 需删除，避免残留旧文案。
   - 逐文件 SHA256 比对，应为 15 个文件全部一致、无多余文件；同时确认安装副本 `package.json` 的 `version` 等于新版本。
   - 完全退出并重启 DSH（含托盘 / 后台进程）后再验收；仅刷新页面不会加载新的客户端代码。
   - 在一个干净 profile 中从市场安装，确认版本、图标、描述与 Release 一致；重启后按 C1/C2 做一次删除到回收站与恢复。

### G3 开发与正式配置边界

- 开发直接改 `src/`，用 `npm run build` 生成 `lib/`；`lib/` 已被 `.gitignore` 排除，不手工编辑。
- 发布包只包含 `package.json.files` 白名单（`lib/` 各产物、`locale/*.json`、`cordis.patch.yml`、`icon.svg`），外加 npm 自动附带的 `package.json`、`README.md`、`LICENSE`；0.2.8 共 14 个文件。
- `prepack` 与 `build` 使用同一脚本，避免“本地能跑、发布包缺文件”。
- 市场索引属于仓库文件，不是 npm 包内容；发布后必须单独提交。

### G4 市场展示

- **兼容性徽章**：市场读 `package.json` 的 `engines.dsh`（顶层优先，其次 `dsh.engines.dsh`）；都没有时卡片显示「未声明宿主要求」。徽章数据来自远端 manifest（npm latest 或 GitHub HEAD），改本地安装副本无效。
- **缓存**：manifest 缓存 TTL 24 小时，改完不会立即刷新。
- **截图**：本市场版本的卡片没有缩略图位，README 中的图片只在详情弹窗里作为截图条展示，抓取源是 `raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md`。
- **图片地址**：README 用绝对 `raw.githubusercontent.com` 地址，GitHub、npm 页面与市场都能显示；相对路径在 npm 页面会失效。
- 卡片那行简短简介来自 awesome-dsh-plugin.com 目录字段，不由仓库决定；要改需在目录侧更新。

---

## H. 验收记录表

| 日期 | 插件版本 | 宿主 / profile | 执行人 | A 构建 | B 消息 | C 会话 | D 费用 | E 主题 | F 异常 / 安全 | 结论 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|---|
|  | 0.2.8 | DSH / desktop |  |  |  |  |  |  |  |  |  |

---

## I. 0.2.8 发布记录

> 本节记录**已执行**的事实，用于回溯与下次发布对照；未填写的项目表示尚未完成人工验收。

### I0 相对 0.2.4 的主要变化

- **会话管理**：会话列表支持多选，批量删除到回收站 / 批量归档并汇总结果；删除与恢复只迁移会话目录，日志内容不变、墓碑仍生效；侧边栏与「⋯」菜单补充图标。
- **文案**：统一使用「会话管理」，状态筛选「已归档」可用且计数与总数一致。
- **消息操作**：撤回、删除、删至末尾、多选分享与导出保持原有行为；提示音与音量不变。
- **安全**：e2e 扩展到 86 项，新增伪造 Host、跨站 Origin、路径穿越、批量上限 51、重复 id、非 JSON、2MB 请求体、PUT 405、未知 action、错误不泄露路径、彻底清理不可恢复等围栏断言。
- **文档**：README 中英文重写，补充用法、计费规则、数据与权限、常见问题与徽章；发布描述按统一文案对齐到 `src/i18n.cjs`、`package.json`、`market/index.json` 与 README 开头。

### I1 提交与 tag

| 项目 | 值 |
|---|---|
| 发布提交 | `988b30d` `docs(i18n): 统一插件描述为 0.2.8 发布文案` |
| 元数据提交 | `8bb3685` `chore(release): 0.2.8 市场索引与 README 徽章同步` |
| tag | `v0.2.8`（annotated，tag 对象 `cb90e69`，指向提交 `988b30d`） |
| 远端 tag | `refs/tags/v0.2.8` 与 `refs/tags/v0.2.8^{}` 均存在 |

- tag 未移动；`8bb3685` 属于发布后补记，不追打 tag。
- push 通过一次性代理参数完成，未改动全局 git 配置。

### I2 npm

| 项目 | 值 |
|---|---|
| 版本 | `0.2.8` |
| registry | `https://registry.npmjs.org`（public） |
| 发布时间 | `2026-11-08T16:00:07.313Z`（epoch `1794153607`） |
| 首次响应 | `202 Accepted`，约 1 分钟后 registry 可见 |
| tarball | 14 个文件，183.9 kB，shasum `35658a5ec45089aaf45378b9db78a091293d58a6` |

### I3 市场索引写入

`market/index.json` 的 `versions` 头部新增（其余 0.2.4 / 0.2.3 / 0.2.2 / 0.2.1 保持原样）：

```json
{
  "version": "0.2.8",
  "publishTimestamp": 1794153607,
  "source": { "type": "npm" }
}
```

- 插件描述 zh 为发布文案原文，en 为对应译文；README 中英文的 npm 徽章与“已发布版本”均已同步为 0.2.8。
- `test/check.mjs` 的旧断言“当前版本必须高于市场列表最新”已改为“列表按时间倒序且最新版本等于当前版本”。

### I4 GitHub Release

- 地址：https://github.com/aijacko/dsh-message-actions/releases/tag/v0.2.8
- 标题：`dsh-message-actions 0.2.8：消息操作、会话管理、用量计费与完成提示音`
- 正文：首行为发布文案原文，后附插件市场 / npm / 本地安装三种方式与重启提示；已回读确认与原文一致、无乱码。
- 本次通过 REST API 创建（本机无 `gh` CLI）；首次因 `make_latest: true` 被拒（422），省略该字段后成功。

### I5 自动化与安装校验

| 项目 | 结果 |
|---|---|
| `node test/check.mjs` | 3057 项通过，0 失败 |
| `node test/e2e-sessions.mjs` | 86 项全部通过 |
| 安装目录 | `D:\DATA\AppData_Backup\.dsh\profiles\desktop\node_modules\dsh-message-actions` |
| 旧版备份 | `D:\DATA\AppData_Backup\.dsh\plugins\.backup\dsh-message-actions-20261109-000415` |
| 文件校验 | 15/15 SHA256 一致，无多余文件；安装副本 `package.json` 版本为 `0.2.8` |
| 文档清理 | 旧 `README.cn.md` 已删除，改为 `README.md`（中文）+ `README-en.md`（英文） |

发布完成后仍需**完全退出并重启 DSH**（含托盘 / 后台进程）才会加载新客户端代码。

### I6 0.2.8 之后的未发布改动

> 这些改动已进工作树，尚未发版；下次发布时并入版本说明。

| 项目 | 内容 |
|---|---|
| 宿主范围 | `package.json` 新增顶层 `engines.dsh: "^0.2.1-rc.1 \|\| ^0.2.2-rc.1"`，消除市场卡片的「未声明宿主要求」；已用市场同款 `satisfiesRange` 验证匹配 0.2.1 / 0.2.2 两代宿主，`0.1.7-alpha.1` 与 `0.3.0` 不匹配 |
| README 截图 | 中英文各补「界面预览 / Screenshots」四图（消息操作与费用卡片、设置·消息操作、设置·会话管理、设置·费用统计），地址为 `raw.githubusercontent.com/.../main/pic/*.png` |
| 旧截图 | `pic/` 已换成 0.2.8 实拍：中文 `1–4.png`、英文 `1en–4en.png`；0.2.1 时代的设置页旧图已不再引用 |
| 验证 | `node build.mjs` 正常；`check.mjs` 3057 通过；`e2e-sessions.mjs` 86 通过 |
