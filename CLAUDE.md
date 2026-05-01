# OCT-Agent 项目规则

## 🛡️ 最高优先级：5 层测试金字塔（MANDATORY）

**源**：主仓 `Awareness/CLAUDE.md` §最高优先级 + `AGENTS.md` 同款段。本仓库继承全局门禁，OCT-Agent 桌面端的代码也必须遵守。

**OCT-Agent 落地要求**：
- **L1 · Contract Guards**：`packages/desktop/src/` 里的 `fetch(...)` 调用，必须指向主仓 `backend/awareness/api/routes/` 已存在的端点或 local daemon 已有的路由；新端点前先问"后端有吗？"。
- **L2 · Integration**：Vitest + `@testing-library/react` 组合——允许 mock 进程外部（backend HTTP、electron IPC 边界），禁止 mock 同文件内的 hook 和 util。
- **L3 · Failure-Mode / Chaos**：每个外部调用（cloud backend HTTP / local daemon / file system / electron ipc）必须有 happy / 5xx / timeout 三组。工具：`packages/desktop/src/test/` 加 `*-chaos.test.tsx`。
- **L4 · User Journey E2E（零 mock）**：用 Playwright 或 `electron` test 起真 app + 真 daemon，断言用户可见文字/图标/toast。不得用 `page.route` / 组件级 mock。位置：`packages/desktop/test/e2e/user-journeys/`（待建）。
- **L5 · Mutation**：季度 Stryker 跑 `packages/desktop/src/pages/Memory.tsx` + `src/components/memory/*`。

**Definition of Done（PR 合并）**：
1. [ ] 新按钮 / 菜单 → 手动验证过点击链路
2. [ ] 新 fetch → 目标端点在 main 仓已有
3. [ ] 新 externals → 有 happy + 5xx + timeout 测试
4. [ ] `npm test` 绿
5. [ ] `npm run package:mac` 能 build 出 dmg（ship 前必验）
6. [ ] CHANGELOG 写"用户看到什么变化"
7. [ ] 本地启 app 亲手走过 happy path

**详细版本**：`../CLAUDE.md` §最高优先级。冲突以主仓为准。

---

## 📦 npm 包发布规则（`@awareness-sdk/claw` CLI 安装器）

OCT-Agent 目前向 npm 发布一个包：`@awareness-sdk/claw`（源码在 `packages/cli/`），用作 `npx @awareness-sdk/claw` 一键安装器。发布必须遵守以下规则：

1. **强制走官方 registry**：本机 npm 默认 registry 可能被改成 `https://registry.npmmirror.com`（镜像不接受 publish，报 `ENEEDAUTH need auth`）。**每次 publish 必须显式带** `--registry=https://registry.npmjs.org/`，不要依赖默认 registry。完整命令：
   ```bash
   cd packages/cli && npm publish --access public \
     --registry=https://registry.npmjs.org/ \
     --//registry.npmjs.org/:_authToken=<NPM_TOKEN>
   ```
2. **必须加 `--access public`**：`@awareness-sdk` 是 scoped 包，npm 默认把 scoped 包当 private 包，没有 `--access public` 会报 402 Payment Required。
3. **Token 在主仓 `Awareness/CLAUDE.md` 的 "SDK 发布凭证" 里**，不要在代码里 hardcode，也不要提交到 git。
4. **首次发布前必须有 README.md**：npm 包列表页会显示 README，没有 README 会让包看起来不专业。`packages/cli/README.md` 是最小必需内容，发布前确认它存在且覆盖 Quick Start + Requirements + License。
5. **`package.json` 必须有 `files` 白名单**：只发 `bin/` 和 `src/`，避免把 `node_modules/`、`test/`、`.DS_Store` 等打进 tarball。当前 `files: ["bin/", "src/"]` 是正确的，改动时必须同步维护。
6. **版本号必须和 CHANGELOG 对齐**：每次 bump `packages/cli/package.json` 的 `version` 必须同步更新 `packages/cli/CHANGELOG.md`（没有则新建）。
7. **发布后必须验证**：`npm view @awareness-sdk/claw version` 应返回新版本号；`npx @awareness-sdk/claw@latest --help` 应能正常拉取并打印帮助（验证 bin 入口和 files 白名单正确）。
8. **禁止用 `npm publish --tag latest` 发测试版**：测试版用 `--tag next` 或 `--tag beta`，避免 `npx @awareness-sdk/claw` 意外拉到未验证版本。

**Claw CLI ↔ Desktop 版本关系**：CLI `@awareness-sdk/claw` 和 Desktop `AwarenessClaw.dmg` 是**两套独立发布渠道**，版本号互不绑定。CLI 面向命令行用户，走 `npx`；Desktop 面向 GUI 用户，走 dmg/exe 下载 + 后端 `latest-version` 端点。两边都要维护 CHANGELOG，都要在主仓 `docs/prd/deployment-log.md` 留痕。

## 🚀 发布流程（bump 版本 → 打包 → 推送升级提示）

OCT-Agent 目前走**手动下载升级**模式（没接 electron-updater），升级提示由后端 `/api/v1/app/latest-version` 下发，桌面客户端轮询后显示 `UpdateBanner` 并通过 `shell.openExternal` 打开 `downloadUrl`。**每次发布新版本必须按以下顺序执行，缺一不可**：

1. **bump `packages/desktop/package.json` 的 `version`**（semver，客户端用 `app.getVersion()` 与后端下发版本比较）。
2. **更新 `packages/desktop/CHANGELOG.md`**（若无则创建）：`## [x.y.z] - YYYY-MM-DD` + Added/Changed/Fixed，作为后端 `AWARENESSCLAW_RELEASE_NOTES` 的内容来源。
3. **打签名 + 公证 DMG**：
   ```bash
   cd packages/desktop
   PYTHON_PATH=/usr/bin/python3 \
     CSC_IDENTITY_AUTO_DISCOVERY=true \
     CSC_NAME="Beijing VGO Co;Ltd (5XNDF727Y6)" \
     APPLE_KEYCHAIN_PROFILE="AwarenessClawNotary" \
     npm run package:mac
   ```
   详见本文件下方"📦 macOS DMG 打包规则（签名 + 公证全流程）"章节。产物：`release/AwarenessClaw-<version>-arm64.dmg`。**未签名或未公证的 DMG 禁止分发**。
4. **上传 DMG 到 GitHub Release**（这是分发源头，官网 `https://awareness.market/` 下载按钮最终跳到这里）：
   ```bash
   cp release/AwarenessClaw-<version>-arm64.dmg /tmp/AwarenessClaw.dmg
   gh release upload v0.3.0 /tmp/AwarenessClaw.dmg \
     --repo edwin-hao-ai/OCT-Agent --clobber
   rm /tmp/AwarenessClaw.dmg
   # 验证
   curl -sIL https://github.com/edwin-hao-ai/OCT-Agent/releases/download/v0.3.0/AwarenessClaw.dmg \
     | grep -iE 'content-length|last-modified'
   ```
   **关键约束**：
   - Release tag 永远是 `v0.3.0`（不随版本号变化），asset 文件名永远是 `AwarenessClaw.dmg`（固定）。只替换里面的 asset，**绝不换 tag**。
   - `edwin-hao-ai/OCT-Agent` 是**只读分发仓库**，不放源码、不记录 release body changelog。用户看到的 "What's New" 由后端 `/api/v1/app/latest-version` 接口从服务器 `/opt/awareness/data/app-versions.json` 下发。
   - `gh release upload --clobber` 需要 PAT 对该仓库有 **release write 权限**（fine-grained PAT 需在 https://github.com/settings/personal-access-tokens 勾选 `edwin-hao-ai/OCT-Agent` + `Contents: Read and write`）。
   - Windows `.exe` 和 Linux `.AppImage` 未来也走同一个 release + 同样 `--clobber` 覆盖。
5. **后端推送新版本号（热更新，无需重启容器）**：SSH 到服务器编辑 `/opt/awareness/data/app-versions.json`：
   ```bash
   ssh server 'cat > /opt/awareness/data/app-versions.json << '\''EOF'\''
   {
     "awarenessclaw": {
       "latestVersion": "x.y.z",
       "downloadUrl": "https://awareness.market/",
       "releaseNotes": "<changelog 摘要>",
       "mandatory": false
     }
   }
   EOF'
   ```
   后端 `app_version.py` 每次请求读文件，改完立即生效。**不要再用 `.env.prod` + 重启容器的旧方式**。`mandatory` 只有破坏性 breaking change 才设 `true`。
6. **验证**：`curl https://awareness.market/api/v1/app/latest-version?app=awarenessclaw` 确认 JSON 中 `latestVersion` 是新版本；在旧版客户端启动，确认 `UpdateBanner` 弹出，点击 "Upgrade Now" 打开官网。
7. **提交代码**：commit message 必须包含版本号、改动摘要、DMG 路径。同时更新 `Awareness/docs/prd/deployment-log.md`。
8. **三端发布**：macOS DMG 完成后必须评估 Windows exe 和 Linux AppImage/deb 是否同步；未发布的平台在 CHANGELOG 中显式标注 "macOS only"。
9. **绝不直接改后端硬编码默认值**：`backend/awareness/api/routes/app_version.py` 里的 `0.1.0` 只是保底，真实版本通过 `/opt/awareness/data/app-versions.json` 文件管理（优先级：文件 > 环境变量 > 默认值）。

**强制规则**：每次 bump desktop `version` 必须同步至少以下三个动作——打包 DMG、编辑服务器上的 `app-versions.json`、本地启动一次验证升级提示——三者都完成才算发布成功。缺任何一步都视为未发布，禁止合并到 main。

**跨平台兼容**：客户端 `app-update-check.ts` 是纯 JS，不依赖 macOS/Linux/Windows 专有 API。后端端点对 `app` query 参数做 fallback（未知 app 返回 `awarenessclaw` 默认值），保证旧客户端不会因后端扩展而崩。

**防回归**：`src/test/app-update-check.test.ts`（vitest）覆盖 semver 比较、`shouldShowDesktopUpdate`、`fetchLatestDesktopVersion` mock 路径；后端 `backend/tests/test_app_version_endpoint.py`（pytest）覆盖环境变量 override、mandatory 布尔解析、未知 app fallback。修改发布/升级相关代码前后必须跑这两个测试。

## 📦 macOS DMG 打包规则（签名 + 公证全流程）

**目标**：产出用户双击即开、零警告的 DMG。**非签名的 DMG 不得分发**，签名但未公证的 DMG 只能作为内部测试版。

### 前置条件（一次性设置）

**1. Keychain 里的签名证书**（Beijing VGO Co;Ltd，Team `5XNDF727Y6`，已配置）：
```bash
security find-identity -v -p codesigning
# 应该看到：
#   "Developer ID Application: Beijing VGO Co;Ltd (5XNDF727Y6)"
#   "Developer ID Installer: Beijing VGO Co;Ltd (5XNDF727Y6)"
```
若丢失，从 Xcode → Settings → Accounts 重新下载，或从 Apple Developer Portal 重新签发。

**2. Notarization 凭证（存 keychain，用 profile name `AwarenessClawNotary`）**：
```bash
# 先去 appleid.apple.com → App-Specific Passwords 生成一个（格式 xxxx-xxxx-xxxx-xxxx）
xcrun notarytool store-credentials "AwarenessClawNotary" \
  --apple-id "120298858@qq.com" \
  --team-id "5XNDF727Y6" \
  --password "<app-specific-password>"
```
**绝不**把 app-specific password 写进代码、commit、.env、文档。只存 keychain。

若第一次 `store-credentials` 返回 `HTTP 403: A required agreement is missing`，说明团队的 Apple Developer Program License Agreement 过期了：
- 登录 https://developer.apple.com/account
- **Agreements, Tax, and Banking** → 签字续签
- 等 5-10 分钟传播后重试 `store-credentials`

**3. Entitlements 文件** `packages/desktop/build/entitlements.mac.plist`（已在 repo，不得删）：
hardened runtime + JIT + network client/server + user-selected file r/w。没有它签名会失败或 app 跑不起来。

### 打 DMG 的标准命令（签名 + 公证一次到位）

在 `packages/desktop/` 目录下：

```bash
PYTHON_PATH=/usr/bin/python3 \
CSC_IDENTITY_AUTO_DISCOVERY=true \
CSC_NAME="Beijing VGO Co;Ltd (5XNDF727Y6)" \
APPLE_KEYCHAIN_PROFILE="AwarenessClawNotary" \
npm run package:mac
```

**电脑没有 Notary profile 时**（例如同事第一次打包，或协议过期还没续签），**改用临时命令跑签名但不公证**：
```bash
PYTHON_PATH=/usr/bin/python3 \
CSC_IDENTITY_AUTO_DISCOVERY=true \
CSC_NAME="Beijing VGO Co;Ltd (5XNDF727Y6)" \
npx electron-builder --mac
```
产物只能内部测试，不得上传分发位置。

### 关键参数说明

- `PYTHON_PATH=/usr/bin/python3` — **必须**用系统自带 Python，不要让 `dmg-builder` 走 Homebrew Python 3.13（`biplist`/`pyobjc` 在 Brew 3.13 下导入失败，`spawn` 抛 `ENOENT` 误导错误）。
- `CSC_IDENTITY_AUTO_DISCOVERY=true` — 让 electron-builder 从 keychain 选证书。
- `CSC_NAME="Beijing VGO Co;Ltd (5XNDF727Y6)"` — **只能是 "团队名 (TeamID)" 格式**，**不要**加 `"Developer ID Application: "` 前缀，否则 electron-builder 报错 `Please remove prefix "Developer ID Application:"`。
- `APPLE_KEYCHAIN_PROFILE="AwarenessClawNotary"` — 触发自动公证，走 `xcrun notarytool`。
- 仅打 DMG 可用 `npx electron-builder --mac dmg`（跳过 zip 步骤，更快，但发布版建议保留 zip 用作 auto-updater）。
- `hardenedRuntime: true` + `entitlementsInherit` 在 `package.json` 的 `build.mac` 里，改 `package.json` 时不得删。

### 输出 & 验证

**产物**：`packages/desktop/release/AwarenessClaw-<version>-arm64.dmg`（约 100 MB）+ `.zip`。

**签名验证**（必跑）：
```bash
codesign -dv --verbose=2 release/mac-arm64/AwarenessClaw.app
# 期望看到：
#   Authority=Developer ID Application: Beijing VGO Co;Ltd (5XNDF727Y6)
#   Authority=Developer ID Certification Authority
#   Authority=Apple Root CA
#   Runtime Version=14.0.0
#   flags=0x10000(runtime)   ← hardened runtime 启用
#   TeamIdentifier=5XNDF727Y6
```

**公证验证**（有 notary profile 时）：
```bash
spctl -a -vvv -t install release/mac-arm64/AwarenessClaw.app
# 期望：accepted, source=Notarized Developer ID
# 若出现 rejected + "Unnotarized Developer ID" → 公证没做，不能分发
```

**Staple ticket**（确认公证结果嵌入本地 app/DMG，离线也能验证）：
```bash
xcrun stapler validate release/AwarenessClaw-<version>-arm64.dmg
# 期望：The validate action worked!
```
如果 electron-builder 公证成功但 DMG 上没 staple，手动补：
```bash
xcrun stapler staple release/AwarenessClaw-<version>-arm64.dmg
```

### 签名 / 公证 / 裸奔三档用户体验对比

| 状态 | 双击 DMG 后用户看到 | 允许分发？ |
|---|---|---|
| 完全未签名 | 红色"文件已损坏，应移到废纸篓"。只能靠 `⚠️ 首次打开必读 .command` 里的 `xattr -rd com.apple.quarantine` 绕过 | ❌ 禁止 |
| **签名但未公证**（0.3.6 状态） | 弹"macOS 无法验证 *OCT-Agent* 不含恶意软件"，按钮"移至废纸篓/取消"，需去"系统设置→隐私与安全性"点"仍要打开" | ⚠️ 仅限内部测试 |
| 签名 + 公证 | 双击即开，零警告 | ✅ 可发布 |

### 踩坑记录

- `ENOENT. spawn /opt/homebrew/Cellar/python@3.13/.../python3` — 真正原因是 Brew Python 3.13 下 `biplist`/`pyobjc` 加载失败。`/usr/bin/python3` 自带 pyobjc，用它就对了。
- 不要试图在 Brew Python 3.13 里 `pip install biplist pyobjc` — `biplist` 已弃用，PEP 668 会拦截。
- `CSC_NAME` 不能带 `"Developer ID Application: "` 前缀，electron-builder 会抛 `Please remove prefix "Developer ID Application:"`。只保留 `"团队名 (TeamID)"`。
- `xcrun notarytool store-credentials` 返回 `HTTP 403 A required agreement is missing` — 团队 Developer Program License Agreement 过期。**只能账户持有人本人**登录 developer.apple.com → Agreements 续签，没法代办。
- 公证失败时 electron-builder 会打印 `skipped macOS notarization  reason=...`，**不会**让打包失败。必须用 `spctl` / `xcrun stapler validate` 兜底检查，不然会不知不觉发出一个未公证版本。
- 公证请求要几分钟到十几分钟，Apple 网络慢时更久。打包命令会阻塞等，不要 Ctrl+C。
- App-specific password 一旦泄漏立即在 appleid.apple.com 撤销。每台开发机都要独立 `store-credentials`，不共享明文密码。

## ⚠️ Web Search 验证规则（必须遵守）

在做技术决策、调试问题、实现功能前，**尽可能多用 Web Search 获取最新信息**。特别是：
- **OpenClaw API/CLI/Gateway 行为**：OpenClaw 迭代快，CLI 参数、Gateway 协议、插件行为随版本变化，必须 Web Search 验证当前版本的真实行为
- **已知 bug 和 workaround**：搜索 GitHub Issues 确认问题是上游 bug 还是我们的实现问题
- **第三方库 API**：Electron、npm、clawhub 等的 API 和行为，不要凭记忆假设
- **每一步都可以搜**：不要只在开始搜一次，过程中遇到不确定的点都应该搜索验证

## ⚠️ 变更报告规则（必须遵守）

每次完成代码修改后，必须向用户报告以下信息：

1. **改了什么文件**：列出所有新增/修改/删除的文件路径
2. **改了什么内容**：每个文件的关键变更摘要（不要贴完整 diff，用人话说）
3. **影响面分析**：这个文件被哪些其他文件 import/依赖？改动可能影响哪些功能？
4. **测试情况**：是否对修改做了测试？测试了什么场景？测试结论是什么？如果没测试，说明原因
5. **格式示例**：
```
### 变更报告
| 文件 | 变更 | 影响面 |
|------|------|--------|
| `src/pages/Dashboard.tsx` | 新增 Agent 选择器下拉 | 聊天页面、chat:send IPC |
| `electron/main.ts` | chat:send 支持 agentId 参数 | 所有聊天功能 |

**测试**：✅ 手动测试创建 agent → 切换 → 发送消息，回复正确路由到选中 agent
```
6. **GitHub 提交说明要求**：每次提交（commit）到 GitHub 时，必须详细说明本次更新了什么，至少包含修改点、影响范围和验证情况；禁止使用 `update`、`fix`、`misc` 这类模糊描述作为完整提交说明。

## ⚠️ 高风险操作审批规则（必须遵守）

1. **卸载/删除属于高风险操作，必须手动二次确认**：即便用户在对话中表达“可以删除”或“可以卸载”，在执行任何卸载软件、删除本机文件/目录、清理用户数据前，必须先让用户再次手动确认。确认信息至少包含：目标对象（软件或文件）、绝对路径（或软件名称）、影响范围、是否可恢复。未完成二次确认前，禁止执行相关命令。
2. **大范围改动先出完整计划，待批准后执行**：涉及多目录、多模块、批量重命名/删除、批量迁移或可能影响核心流程的改动，必须先给出完整计划（变更清单、影响面、回滚思路），并在用户明确批准后再执行。
3. **命令不清晰时，严格禁止清空数据**：当用户命令、路径或目标范围存在歧义时，严禁执行任何清空、覆盖、格式化、递归删除等不可逆操作（例如 `rm -rf`、`del /s /q`、`Remove-Item -Recurse -Force`）。必须先澄清，再执行。

## 项目概述
OCT-Agent = OpenClaw（开源 AI Agent 框架）+ Awareness Memory（跨会话记忆），一键安装，超级傻瓜化。

## 核心原则

### 1. 套壳不复刻
- **绝不复刻 OpenClaw**：安装真正的 OpenClaw，不 fork、不重写
- OpenClaw 升级 = 用户升级，我们只维护安装器壳和记忆插件
- 利用 OpenClaw 已有的一切能力（Gateway、多通道、ClawHub、Web UI 等）

### 2. 复用优先，不重复造轮子
- Awareness 主仓库（`../`）中已有大量可复用代码，**必须优先复用**：
  - `../sdks/openclaw/` — OpenClaw 插件实现（tools、hooks、client、sync、auth）
  - `../sdks/local/` — 本地守护进程（daemon、MCP server、indexer）
  - `../sdks/setup-cli/` — IDE 安装逻辑（环境检测、配置写入、守护进程启动）
  - `../sdks/awareness-memory/` — ClawHub 技能脚本（recall、capture、search）
- **复用方式**：npm 依赖（`@awareness-sdk/openclaw-memory`、`@awareness-sdk/local`、`@awareness-sdk/setup`），不要复制代码
- 只有安装器壳、Electron 壳、桌面端 UI 是新写的代码
- 如果发现自己在写的功能在主仓库 SDK 中已经存在，**停下来，改为引用而不是重写**

### 3. 超级傻瓜化（10 岁小孩可用）
- **零命令行**：用户全程不需要打开终端/命令行
- **零技术知识**：不假设用户知道什么是 Node.js、npm、API Key、JSON
- **一键安装优先**：安装流程面向不写代码的商业用户设计，默认一路"下一步"即可完成，不要求用户做环境匹配、参数选择或依赖排查
- **所有配置全 UI 化**：模型选择、通道连接、记忆体管理全部图形化
- **用人话说话**：错误提示不要技术术语，用"网络连接有问题，请检查 Wi-Fi"而非"ECONNREFUSED 127.0.0.1:37800"
- **安全默认值**：所有配置都有合理的默认值，用户可以一路"下一步"完成安装

### 4. 跨平台是硬要求
- **产品必须兼容 Windows、Linux、macOS**：功能设计、安装流程、升级流程、路径处理、权限处理都要覆盖三端，不能只在单一平台可用
- 任何新增功能上线前，都要先检查三端是否存在命令、路径、权限、打包或 UI 行为差异

### 5. 记忆是差异化
- 安装器是入场券，记忆体是护城河
- UI 和功能优先投入在记忆相关特性（知识卡、感知信号、决策时间线）
- 竞品（ClawX、Butlerclaw 等）不提供跨会话记忆

## 技术栈
- **CLI 包**（Phase 0）：Node.js，零依赖（仅内置模块），ESM
- **桌面端**（Phase 1）：Electron + React + Tailwind + shadcn/ui
- **打包**：electron-builder（exe/dmg/deb/rpm/AppImage）
- **自动更新**：electron-updater

## 项目结构
```
OCT-Agent/
├── packages/cli/          # @awareness-sdk/claw — npx 安装器
├── packages/desktop/      # Electron 桌面端
├── docs/                  # 项目文档
└── CLAUDE.md              # 本文件
```

## 主进程结构文档（必须遵守）
- 修改 `packages/desktop/electron/main.ts` 或其拆分文件前，必须先阅读 `docs/structures.md`
- `docs/structures.md` 是 Electron 主进程拆分的唯一施工规则，优先级高于临时想法
- 对 `main.ts` 的重构必须遵守“先 copy/paste 提取、后整理”的原则，不允许借重构顺手改行为
- `chat`、`channel`、`app lifecycle` 属于高风险区，没有明确验证时不要先动
- 新增主进程文件时，优先按 `docs/structures.md` 约定的目录和分层方式放置

## 与主仓库的关系
- 本项目位于 `Awareness/OCT-Agent/`，使用独立 Git 仓库管理
- 主仓库 `.gitignore` 已排除本目录
- 通过 npm 依赖引用主仓库 SDK，不通过文件路径引用

## 任务管理
- **所有待做事项记录在 `TASKS.md`**，完成一项打 ✅ + 日期
- 开始新功能前先看 TASKS.md，避免遗漏和重复
- 每次重大改动后更新 TASKS.md 状态
- PRD 详细设计在 `Awareness/ops-docs/AWARENESS_AGENT_DESKTOP_PRD.md`

## 开发规则
- 中文推理和回复，英文写代码（与主仓库一致）
- 代码注释用英文
- 任何安装、升级、启动相关改动都必须同时验证 Windows、Linux、macOS 三端兼容性，不允许默认只按当前开发机平台处理
- UI 文案支持多语言（默认英文 + 中文），不要 hardcode 语言
- 所有用户可见的错误信息必须友好、非技术性、可操作
- 安装向导必须优先减少用户决策和手工操作；能自动检测的不要让用户选，能自动修复的不要让用户自己查文档
- **聊天 UI 不嵌入 OpenClaw 原生界面**——用我们自己的 Web UI，后端走 CLI 或 WebSocket 获取数据
- **模型选择器显示激活状态**：已配置 API Key 的显示 ✅，未配置的显示 🔑 提示
- **升级提醒分两级**：强提醒（弹窗，可选下次/永不）+ 弱提醒（顶部 tooltip 条）
- **streaming 必须支持**：用户发送消息后，AI 回复逐字显示，不能等完整回复才渲染

## 架构决策（已实施）

### OpenClaw verbose 输出解析
- OpenClaw CLI verbose 输出格式（来自 `acp-cli` 模块）：
  - `[tool] <title> (<status>)` — 工具调用开始
  - `[tool update] <toolCallId>: <status>` — 工具状态更新
  - `[permission auto-approved] <tool> (<kind>)` — 权限自动批准
  - `agent_message_chunk` 直接 `process.stdout.write(text)` — 流式文本（无前缀）
- 噪音行前缀：`[plugins]`、`[tools]`、`[agent/`、`[diagnostic]`、`[context-diag]`、`[info]`、`[warn]`、`[error]`、`[acp-client]`、`[commands]`、`[reload]`、`Registered plugin`
- `main.ts` 用 line buffer 机制处理 stdout，分离噪音行和实际内容

### 双层记忆架构（Awareness + OpenClaw Native）
- **Awareness Memory**：长期、云端/本地守护进程、跨项目/跨设备、结构化知识卡
- **OpenClaw Native Memory**：短期、本地 sqlite + markdown 快照、工作区级
- 两套系统零冲突，分别使用不同的 hook 时机和存储后端
- `tools.alsoAllow` 白名单已包含 `awareness_recall/lookup/record`，与 OpenClaw 原生 `memory_search/memory_get` 共存

### Token 优化
- `thinkingLevel` 配置项通过 `--thinking <level>` 传递给 OpenClaw CLI
- `recallLimit` 控制 auto-recall 注入的记忆数量
- Settings 页面显示 token 估算值（recall tokens + thinking tokens + base overhead）

### 流式输出实现
- `main.ts` 通过 `chat:stream` IPC 事件实时发送非噪音文本行到前端
- 前端在 `agentStatus !== 'idle'` 时直接渲染 streamingContent（ReactMarkdown），替代等待全文后的打字机效果
- 打字机效果保留作为 fallback（非流式场景或历史消息首次渲染）

### macOS 系统托盘
- `main.ts` 创建 Tray（18x18 template image），右键菜单：Show/New Chat/Dashboard/Quit
- macOS 下关窗口只 `hide()`，不退出应用；点击托盘图标恢复窗口
- `tray:new-chat` IPC 事件通知前端创建新会话

### 配置导入/导出
- `config:export` — 读 `~/.openclaw/openclaw.json`，包装为 `{ _exportVersion, openclawConfig }` 后通过原生 SaveDialog 写出
- `config:import` — 通过原生 OpenDialog 读入，深度合并 providers 字段后写回
- Settings 页底部 Export/Import 按钮

### 动态模型列表
- `models:read-providers` IPC 读 openclaw.json 的 `models.providers` 全量数据
- `useDynamicProviders()` hook 合并硬编码 MODEL_PROVIDERS + 动态 providers
- 已知 provider 保留 hardcoded emoji/tag/desc 等 UI 元素，动态模型列表覆盖 hardcoded
- CLI 自定义 provider 自动显示为 🔌 Custom
- Dashboard/Settings 全部使用 `allProviders` 替代 `MODEL_PROVIDERS`

### 安全审计
- `security:check` IPC — Unix 检查 openclaw.json 文件权限（非 600 警告）、alsoAllow 过多警告、第三方 extensions 检测
- Settings 页 Security Audit section — amber 背景警告 + fix 命令

### 费用统计
- `src/lib/usage.ts` — 纯前端 localStorage 跟踪，无 IPC
- 每次 chatSend 成功后 `trackUsage(provider, model, inputText, outputText)`
- Token 估算：CJK ~1.5 chars/token, English ~4 chars/token, 混合取平均
- 30 天滚动窗口，最多 5000 条，Settings 页展示 + 按模型分组
- `getUsageStats()` 返回 today + total + byModel 三层汇总

### 每日记忆摘要
- `memory:get-daily-summary` IPC — 组合 knowledge(limit=10) + tasks(limit=5, status=open)
- Memory 页顶部 Daily Summary panel — 仅在 daemon 连接且有数据时显示
- 知识卡片前 5 条 + 待办任务计数

### npm 升级安全网
- 升级前记录 `preSemver`，升级后验证 `openclaw --version` 响应
- npm prefix 不可写时自动 fallback `npx openclaw@latest`
- 自动检测 pnpm/yarn，`setup:install-openclaw` 和 `app:upgrade-component` 统一使用

### 图片理解
- 拖拽图片自动识别（.png/.jpg/.jpeg/.gif/.webp/.bmp/.svg）
- 图片以 `[Images to analyze: /path/to/img] (use exec tool to read or describe these image files)` 格式传给 agent
- OpenClaw agent 不支持 `--files` flag，图片信息通过消息文本传递

### 复用组件
- `PasswordInput.tsx` — 密码输入框 + 眼睛图标切换显隐，全局 4 处使用（Dashboard/Settings/Channels/Setup）

### 升级流程
- `app:check-updates` — 检测 openclaw + plugin 版本差异
- `app:upgrade-component` — 执行 `npm install -g xxx@latest`
- 检测到更新时自动弹出模态框（强提醒），显示版本对比 + 一键升级按钮
- 升级进度实时反馈（spinner / success / error）

### 测试
- 测试框架：vitest + @testing-library/react
- Mock Electron API 在 `src/test/setup.ts`，所有 IPC 方法都有 mock
- 当前 96 个测试（20 个文件），覆盖 Dashboard、Memory、Settings、Store、Channels、Automation、Skills、i18n、Chat Model/Files、Connection、Permissions、Workspace、UpdateBanner、FilePreview、Skills E2E、Automation Cron

## 踩坑记录（必读）

### IPC handler 必须用 async shell exec（严重踩坑，反复出现）
- **问题**：`main.ts` 中所有 IPC handler 最初用 `execSync` / `run()`（同步），导致每次调 `openclaw status`、`npm view`、`npm install -g` 等命令时阻塞 Electron 主线程数秒到数分钟，UI 完全冻结（切换页面、点按钮无响应、升级按钮卡死）
- **根因**：Electron 主线程同时负责 IPC 和渲染调度，`execSync` 阻塞主线程 = 阻塞一切
- **修复**：新增 `safeShellExecAsync()`（短命令）和 `runAsync()`（长命令，如 npm install），基于 `spawn` + Promise，将**所有** IPC handler 改为异步
- **规则**：**`ipcMain.handle` 中禁止使用 `execSync`、`safeShellExec`（同步版）、`run()`（同步版）**。一律用 `await safeShellExecAsync()` 或 `await runAsync()`。同步版本仅保留给 `getNodeVersion()` 等 app 启动前的一次性检测
- **已改造的 handler**：gateway:status/start/stop/restart、app:check-updates、app:upgrade-component、cron:list/add/remove、channel:test、logs:recent、app:get-dashboard-url、setup:install-nodejs、setup:install-openclaw、setup:install-plugin、setup:bootstrap

### OpenClaw 权限模型（调研结论）
- **Tools profile**：`coding`（广泛 shell + 文件读写），`tools.alsoAllow` 白名单额外工具
- **denied 命令**：`camera.snap/clip`, `screen.record`, `contacts.add`, `calendar.add`, `sms.send` 等（在 `openclaw.json → tools.denied`）
- **Gateway**：local 模式绑 loopback:18789，token 认证
- **已安装技能目录**：`~/.openclaw/workspace/skills/<slug>/`，lock 文件 `~/.openclaw/workspace/.clawhub/lock.json`
- **ClawHub REST API**：`GET /api/v1/search?q=...`、`GET /api/v1/skills`、`GET /api/v1/skills/<slug>` — 读操作不需认证
- **插件配置**：`openclaw.json → plugins.entries`（enabled/disabled）、`skills.<slug>.config`
- **工作区文件**：`~/.openclaw/workspace/` 下有 SOUL.md、USER.md、IDENTITY.md、TOOLS.md、MEMORY.md

### openclaw --version 输出含 commit hash
- `openclaw --version` 返回 `OpenClaw 2026.3.28 (f9b1079)`，不能用 `replace(/[^\d.]/g, '')` 提取版本（会把 hash 里的数字带上）
- 必须用 `match(/(\d+\.\d+\.\d+)/)` 精确提取 semver
- 踩坑：导致升级弹窗误判每次都有更新

### chatSend 必须传完整参数
- `chatSend(message, sessionId, options)` 中 options 需包含 `model`（modelId）和 `thinkingLevel`
- 当前只传了 `thinkingLevel`，模型选择器切模型不生效（永远用 openclaw.json 默认模型）
- 附件文件路径需要通过 options 或 `--files` 参数真正传给 OpenClaw agent

### 前端状态必须与 openclaw.json 同步
- Settings 里改了配置，`syncConfig()` 会写 openclaw.json — 但正在运行的 agent 不感知
- 通道连接后 `channelSave()` 写入了 openclaw.json，但前端通道列表没有重新读取状态
- 模型列表 `MODEL_PROVIDERS` 在 store.ts 硬编码了 12 个厂商，不读 openclaw.json 的实际 providers
- **规则**：写入 openclaw.json 后，必须也更新前端状态；涉及 agent 的配置改动需提示用户重启

### Heartbeat 和 Theme 是假功能
- `heartbeatEnabled` / `heartbeatInterval` 是纯 useState，未持久化也未实际启动服务
- 主题选择（Light/Dark/System）只存 localStorage，没有 `document.documentElement.classList.toggle('dark')` — UI 永远暗色
- **规则**：新增开关/配置项必须同时实现持久化 + 生效逻辑

### npm install -g 权限陷阱（跨平台）
- **macOS (Homebrew Node)**：prefix `/opt/homebrew` 或 `/usr/local`，Homebrew 管理权限，通常不需要 sudo
- **macOS (官方 pkg 安装)**：prefix `/usr/local`，npm global 需要 sudo → Electron GUI 环境无法弹 sudo 对话框
- **macOS (自定义 prefix)**：用户可能设了 `npm config set prefix ~/.npm-global`，需确保 `~/.npm-global/bin` 在 `getEnhancedPath()` 中
- **Linux (apt/dnf 安装)**：prefix `/usr`，npm global 一定需要 sudo → `runAsync` 中的 sudo 无法交互式输入密码
- **Windows**：prefix `%APPDATA%\npm`，通常不需要管理员权限，但杀毒软件可能拦截
- **规则**：安装/升级前必须 `npm config get prefix` 检查权限，EACCES 时给用户友好提示，不要静默失败

### Shell 执行必须用 --norc --noprofile（严重踩坑，反复出现）
- **问题**：`spawn(cmd, [], { shell: '/bin/bash' })` 会自动加载 `.bashrc`。如果 `.bashrc` 有 `source ~/.cargo/env` 等不存在的文件，整个命令报错——用户看到 "No such file or directory" 但以为是升级命令的问题
- **修复**：所有 `safeShellExec`、`safeShellExecAsync`、`runAsync` 改为 `spawn('/bin/bash', ['--norc', '--noprofile', '-c', cmd])`，手动 `export PATH=...` 注入增强路径
- **规则**：`main.ts` 中**禁止**用 `{ shell: '/bin/bash' }` 选项，必须显式 `--norc --noprofile`
- **跨平台**：Windows 用 `{ shell: 'cmd.exe' }` 没有此问题；Linux 同样需要 `--norc --noprofile`（用户可能有 `.bashrc` 加载 pyenv/rbenv/nvm 等）

### Embedded agent 工具调用格式与 [tool] 格式不同
- **实际格式**：`[agent/embedded] embedded run tool start: runId=... tool=exec toolCallId=call_xxx`
- **不是**：`[tool] Bash (running)` — 这个格式在 embedded agent 模式下不会出现
- `parseStatusLine` 必须同时支持两种格式（`[tool]` 前缀 + `embedded run tool start/end`）
- 工具名在 embedded 格式中是 `exec`（不是 `Bash`），前端 `getToolIcon` 需要匹配 `exec`
- `toolCallId` 格式为 `call_<hex>`，用于 start/end 配对

### 跨平台 shell 执行差异（必读）
- **macOS/Linux**：`/bin/bash --norc --noprofile -c "export PATH=...; cmd"` — 手动注入 PATH
- **Windows**：`spawn(cmd, [], { shell: 'cmd.exe' })` — cmd.exe 不加载 rc 文件，PATH 通过 env 传入即可
- **PATH 注入方式不同**：macOS/Linux 在 shell 命令中 `export PATH=...`；Windows 通过 `env: { PATH: ... }` 传入
- **路径分隔符**：macOS/Linux 用 `:`，Windows 用 `;` — 已用 `path.delimiter` 处理
- **PATH 顺序**：用户自定义路径 (`~/.npm-global/bin`) **必须排在** 系统路径 (`/usr/local/bin`) 之前，否则早期 `sudo npm install -g` 的残留版本会覆盖新版。踩坑：`/usr/local/bin/openclaw` (3.13) 优先于 `~/.npm-global/bin/openclaw` (3.28) 导致升级后版本不变
- **常见路径**（按优先级排序）：
  - macOS: `~/.npm-global/bin`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.nvm/versions/node/*/bin`
  - Linux: `/usr/local/bin`, `~/.npm-global/bin`, `~/.nvm/versions/node/*/bin`, `/snap/bin`, `~/.fnm/aliases/default/bin`
  - Windows: `%APPDATA%\npm`, `%ProgramFiles%\nodejs`

### openclaw plugins install 在 Electron 中路径丢失
- **问题**：打包后的 Electron 环境中 `openclaw plugins install` 找不到 workspace 路径，回退到根目录，导致 `mkdir '/skills'` ENOENT
- **修复**：plugin 升级优先用 `npx clawhub@latest install awareness-memory --force`（不依赖 OpenClaw workspace），fallback 到 `openclaw plugins install`
- **规则**：在 Electron 打包环境中，优先用 `clawhub` CLI 操作技能，避免依赖 OpenClaw 的 workspace 路径解析

### 升级流程修复记录（2026-03-30）
- plugin 升级：先 `rm -rf ~/.openclaw/extensions/openclaw-memory`，再 `openclaw plugins install`（避免 "already exists"），fallback `clawhub install`
- 版本提取用 `.match(/(\d+\.\d+\.\d+)/)` 而非 `.replace(/[^\d.]/g, '')`（后者会把 commit hash 数字混入）
- **plugin 版本检测优先读 `~/.openclaw/extensions/openclaw-memory/package.json`**（实际安装位置），不是 ClawHub lock.json
- `getEnhancedPath()` 中 `~/.npm-global/bin` 必须排在 `/usr/local/bin` **之前**
- 升级后必须重新 `checkUpdates` 验证版本变化

### openclaw agent 支持的参数（必须先 --help 确认）
- **支持**：`--local`、`--session-id`、`-m`、`--verbose on`、`--thinking <level>`、`--timeout`、`--agent`、`--channel`、`--deliver`
- **不支持**：`--model`（模型通过 `openclaw.json → agents.defaults.model` 配置）、`--files`（文件通过消息文本描述）
- **教训**：加了不存在的 flag（如 `--model`）会导致命令静默失败返回空 → "No response"，不会报错
- **规则**：修改 `chat:send` 命令拼接前，先运行 `openclaw agent --help` 确认参数存在

### OpenClaw 配置结构踩坑（必读）
- **`plugins.entries` 是对象不是数组**：`{ "feishu": { "enabled": true }, "openclaw-memory": { "enabled": true } }`，用 `Object.entries()` 遍历，**不能** `.map()`
- **`hooks` 是嵌套对象**：`{ "internal": { "enabled": true, "entries": { "boot-md": { "enabled": true } } } }`，不是 `Record<event, Array<cmd>>`
- **教训**：写 IPC handler 和前端代码前，必须先 `cat ~/.openclaw/openclaw.json | python3 -c "import json,sys; ..."` 看真实数据结构，不要猜

### 通道连接三大坑（严重踩坑，反复出现）

#### 1. OpenClaw 非 TTY 模式不输出（最致命）
- **问题**：`spawn` 或 `runAsync` 执行 `openclaw channels login` 时，OpenClaw 检测到 stdout 不是 TTY（终端），直接不输出 QR 码和任何交互内容。stdout/stderr 都是空的
- **根因**：OpenClaw CLI 用了类似 `ora`/`ink` 的 TTY 检测，非 TTY 模式下抑制输出
- **修复**：**必须加 `--verbose` 标志**。`openclaw channels login --channel xxx --verbose` 才会在 pipe 模式下输出完整内容（包括 QR 码和 URL）
- **规则**：所有 `openclaw channels login` 调用必须带 `--verbose`

#### 2. QR 链接被内部 URL 抢先匹配
- **问题**：stdout 中 `http://localhost:37800`（Awareness daemon URL）先于 QR 链接出现，正则 `https?://\S+` 先匹配到 localhost → `shell.openExternal` 打开了 localhost 而不是扫码页
- **修复**：URL 过滤跳过 `localhost`、`127.0.0.1`、`docs.openclaw`、`github.com`
- **规则**：URL 检测必须排除内部/文档 URL

#### 3. 通道配置成功但消息不回复（绑定缺失）
- **问题**：通道 login 成功后（`configured, enabled`），用户发消息无回复
- **根因**：Agent 的 `bindings` 为 0 — 通道没有绑定到任何 Agent，消息无法路由
- **修复**：`channel:setup` 成功后自动执行 `openclaw agents bind --agent main --bind <channel>`
- **规则**：**每个通道连接成功后必须自动绑定到 main agent**

#### 4. 微信通道 ID 是 `openclaw-weixin`（不是 `wechat`）
- **问题**：前端用 `wechat`，但 OpenClaw 的 channel ID 是 `openclaw-weixin`（插件 ID）
- 写 `channels.wechat` 到 openclaw.json 会导致 `unknown channel id: wechat` 错误，整个配置无效
- **正确**：openclaw.json 中用 `channels["openclaw-weixin"]`，CLI 用 `--channel openclaw-weixin`
- `channel:list-configured` 需要映射 `openclaw-weixin` → `wechat` 给前端

#### 7. WhatsApp QR 是 ASCII 块字符图形，不是 URL（最新发现）
- **问题**：`openclaw channels login --channel whatsapp --verbose` 调用 `createWaSocket(true, verbose)` → `qrcode-terminal` 输出 `▄▀█` 块字符 QR 到 stdout，**不是** HTTPS URL
- **Signal 类似**：Signal 输出的是 `sgnl://linkdevice?...` 深链接，不是 `https://`
- **WeChat**：插件输出 HTTPS URL → 我们的 URL 检测可以工作 ✅
- **修复**：
  - 按行解析 stdout，检测块字符行（`▄▀█` 占 60%+）构成 QR 块（≥5 行）
  - 将 ASCII QR 通过 IPC `channel:qr-art` 事件发送到前端，在白色背景 `<pre>` 中显示
  - 同时检测 `sgnl://` 深链接并 `shell.openExternal()` 唤起 Signal app
- **前端**：wizard 的 testing 步骤当检测到 `asciiQR` 时切换显示 QR 图形 + 等待扫码提示

#### 5. `runAsync` 超时错误字符串不匹配
- `runAsync` 抛 `"Command timed out"`，但检查用 `msg.includes('timeout')` — `"timed out"` 不包含连续的 `"timeout"`
- **必须**同时检查 `msg.includes('timed out')`

#### 6. `openclaw channels add --channel` 枚举
- 真实支持：`telegram|whatsapp|discord|irc|googlechat|slack|signal|imessage|line`
- **Matrix 不在枚举中**，需要直接写 openclaw.json
- **WeChat 是插件通道**，不在 `channels add` 枚举中

### Local Daemon 启动失败踩坑
- **npx 缓存损坏**（ENOTEMPTY）：`~/.npm/_npx/` 下的缓存目录损坏，`npx @awareness-sdk/local start` 报 `ENOTEMPTY: directory not empty, rename`
- **修复**：删除包含 `@awareness-sdk` 的 npx 缓存目录：`rm -rf ~/.npm/_npx/*/node_modules/@awareness-sdk/..` 对应的父目录
- **Doctor 已集成**：`fixDaemonStart` 自动清理坏缓存再启动
- **better-sqlite3 编译**：daemon 首次启动需要编译 C++ 原生模块，可能耗时 30s+，失败时 daemon 直接 crash 无错误信息

### electron-builder 用独立 tsconfig
- `npm run build:package` 先跑 `tsc -p tsconfig.electron.json`，这和前端的 `npx tsc --noEmit`（用默认 tsconfig.json）是**两个不同的编译**
- 前端 `npx tsc --noEmit` 通过不代表 Electron 端也通过！打包前必须确认 `npm run build` 也能通过
- 踩坑：编辑 `main.ts` 时多了一个 `});` 闭合括号，前端编译没报错但 electron 编译失败

### OpenClaw CLI 超时规则（必读，反复踩坑）
- **问题**：OpenClaw 每次 CLI 命令（`agents add`、`agents delete`、`agents bind` 等）都重新加载所有已安装插件（feishu、awareness-memory、device-pair 等），耗时 **15-30 秒**（低配机器或插件多的环境可能更长）
- **活动超时机制（idle timeout）**：`runAsync` 和 `runAsyncWithProgress` 已改为活动超时 — 每次 stdout/stderr 有输出就重置计时器。只有连续 N 秒无任何输出才判定超时。这样即使 OpenClaw 加载 50 个插件花 2 分钟，只要还在输出 `[plugins] Registered xxx` 就不会超时
- **超时参数的含义**：`runAsync(cmd, 30000)` = 30 秒内无任何输出才超时（不是总耗时 30 秒）
- **推荐超时值**：`agents:add` = 45s idle，`agents:delete/set-identity/bind/unbind` = 30s idle，`agents:list` = 15s idle（只读操作较快）
- **前端必须有状态提示**：长时间操作必须向用户实时显示当前步骤（"正在加载插件..."、"正在创建工作区..."），不能只显示一个 spinner 什么也不说
- **友好的超时错误提示**：如果超时了，不要显示原始的 "Command timed out"，而是告诉用户"OpenClaw 正在加载插件，请重试"

### Gateway 命令踩坑
- **正确命令**：`openclaw gateway start/stop/status/restart`
- **错误命令**：`openclaw up`（不存在）、`openclaw status`（加载全部插件 = 15s+，5s 超时必失败）
- `openclaw gateway status` 比 `openclaw status` 快得多（跳过完整插件加载）
- Gateway 操作超时至少 15s（插件多的环境加载慢）
- `openclaw gateway start` 如果已在运行会报错，需要检查 status 判断"already running"

### 聊天 No response 防回归规则（2026-04-03）
- **问题背景**：Gateway 暂时不可用（如 pairing required）时会走 CLI fallback；如果 fallback prompt 被运行时元数据包裹后触发空回复，前端会落成 "No response"
- **产品规则 1（成功率优先）**：任何涉及 `chat:send`、Gateway preflight、CLI fallback 的改动，必须证明失败场景下不降低用户成功率
- **产品规则 2（禁止直接空回复）**：CLI 退出码为 0 但首轮文本为空时，必须至少执行一次自动补救（例如 raw user message retry）；补救后仍空才允许展示 "No response"
- **产品规则 3（高风险文件必测）**：修改 `electron/ipc/register-chat-handlers.ts`、`electron/main.ts`、`electron/gateway-ws.ts` 时，必须运行聊天链路回归测试（至少覆盖 Gateway 正常、Gateway 不可用 fallback、fallback 空回复补救）
- **产品规则 4（Windows 必测）**：在 Windows 上必须验证 `spawn(..., { shell: 'cmd.exe' })` 的 stdout/stderr 混合输出场景，确保不会出现“进程成功但前端空回复”
- **产品规则 5（诊断可观测）**：出现空回复时必须输出结构化诊断字段（timeout/final/delta/retry），便于快速归因到 Gateway、CLI 或解析逻辑
- **产品规则 6（提交说明）**：触及聊天链路的提交必须在说明中写清“影响哪条链路、失败时用户看到什么、如何避免 No response 回归”

### ASCII QR 码检测三大坑（WhatsApp/Signal，已修复）
- **坑 1: QR 只发前 5 行**：`isQrLine()` 检测到 5 行时立即发送 `channel:qr-art`，但完整 QR 有 30 行 → 前端只显示一条矮长条。**修复**：用 300ms debounce timer，等所有 QR 行到齐后一次性发送
- **坑 2: QR 永远不发送（原始 bug）**：原代码只在 `else` 分支（收到非 QR 行时）发送 QR 块，但 WhatsApp 输出完 QR 后进程挂起等待扫码，不再有新行 → `else` 永远不触发。**修复**：在 QR 行分支内用 setTimeout 延时发送
- **坑 3: ANSI 转义码干扰检测**：OpenClaw 输出可能含 ANSI 颜色码（`\x1b[...m`），会膨胀字符计数，降低块字符占比到阈值以下。**修复**：`isQrLine()` 先 `stripAnsi()` 再计算比例，阈值从 0.6 降到 0.55
- **坑 4: Config warnings 框的空行误判**：`│                    │` 这样的 box-drawing 空行被误判为 QR（空格占比高），但只有 1 行不会触发发送（≥5 行阈值保护）
- **规则**：QR 相关的 IPC 必须用 `webContents.send`（单向推送），不能放在 `ipcMain.handle` 的返回值里（因为 QR 在 await 中途产生）

### 通道插件未预装导致交互式提示挂起（重要）
- **问题**：对未安装插件的通道执行 `openclaw channels login`，OpenClaw 弹出 `@clack/prompts` 交互式 select（"Install plugin? npm/local/skip"），在非 TTY 的 `spawn` 环境下无法响应，直接挂起到超时
- **影响通道**：所有非预装通道（首次使用的 Telegram/Discord/Slack/Signal/LINE 等）
- **不影响**：WhatsApp（已配置）、WeChat（代码中预装 `@tencent-weixin/openclaw-weixin`）、iMessage（无需插件）
- **修复**：在 `channels login` 前先 `openclaw channels add --channel <id>`（非交互式），确保通道配置存在；如需插件安装，用 `openclaw plugins install @openclaw/<channel>` 代替交互式提示
- **注意**：Telegram/Discord/Slack 实际走 token 流程不走 QR，它们不在 `ONE_CLICK_CHANNELS` 中，但如果用户手动尝试 login 仍会卡住

### 内置通道插件未预编译到 dist（严重踩坑）
- **问题**：`openclaw` npm 包的 `dist/telegram/`（以及 whatsapp/discord/signal/slack/irc/googlechat）目录为空或只有 stub 文件（如 `audit.js`、`token.js`），缺少主入口 `index.js`
- **根因**：`BUNDLED_PLUGIN_METADATA` 中声明了 `dirName: "telegram"` 等，但 `resolveBundledPluginGeneratedPath()` 检测到 `index.js` 不存在时静默跳过，不报错
- **结果**：`channels add --channel telegram --token xxx` 能写入 config，但 Gateway 永远不加载该通道——`channels list` 为空，`agents bind --bind telegram` 报 "Unknown channel"
- **正确安装方式**：`openclaw plugins install @openclaw/<channel>`（如 `@openclaw/telegram`），OpenClaw 会从 bundled extensions 目录安装完整插件到 `~/.openclaw/extensions/telegram/`
- **安装后必须**：`openclaw gateway restart` + `openclaw agents bind --agent main --bind <channel>`
- **桌面端规则**：`channel:setup` IPC 必须在写入 config 前先执行 `plugins install @openclaw/<channel>`，否则通道永远不会被加载

### OpenClaw 每次 CLI 命令都重新加载所有插件（性能坑）
- **问题**：`openclaw channels login` 启动时加载 10+ 个插件（feishu_doc/chat/wiki/drive/bitable、device-pair、phone-control、talk-voice、awareness-memory 等），耗时 15-20 秒，用户看到长时间 spinner
- **无法跳过**：OpenClaw CLI 没有 `--no-plugins`/`--skip-plugins` 选项
- **缓解**：在 `channelLoginWithQR` 的 `processLine` 中检测 `[plugins] Registered` 等日志行，通过 `channel:status` IPC 实时推送加载进度到前端，让用户知道在做什么
- **未来优化**：OpenClaw Gateway 的 WebSocket API 理论上支持 `channels.login`（Gateway 已加载好所有插件），可以避免重复加载。但目前桌面端未实现 Gateway WS 客户端

### Windows Gateway 计划任务缺失（严重踩坑，影响普通用户）
- **现象**：前端只看到 `Gateway failed to start. Please check Settings → Gateway and try again.`，容易误以为是模型 API Key 或 Qwen 配置问题
- **真实含义**：这通常不是模型层问题，而是 OpenClaw Gateway 的 Windows Scheduled Task 没装好或没有权限创建
- `openclaw gateway status` 若显示 `Service: Scheduled Task (missing)`，说明本地服务根本不存在，`openclaw gateway start` 一定失败
- `openclaw gateway install` 若报 `schtasks create failed` / `Access is denied` / `拒绝访问`，说明需要管理员权限创建本地服务
- **产品规则**：桌面端检测到 Gateway 缺失时，必须先自动执行 `openclaw gateway install` 再 `openclaw gateway start`，不能直接报泛化错误
- **降级规则**：如果 Windows 拒绝创建计划任务，桌面端必须 fallback 到 `openclaw gateway run --force` 的当前用户会话模式，保证用户先能聊天，再提示后续可选的管理员修复
- **用户文案规则**：提示里必须明确“这是本地服务安装权限问题，不是 Qwen/OpenAI API Key 配置问题”
![alt text](<截屏2026-04-01 09.13.13.png>)

### 统一通道注册表架构（2026-04-01 实施）

**核心设计**：只有 `wechat` + `local` 是内置通道，其余全部从 OpenClaw 动态发现。

**数据源**：
- `<openclaw>/dist/channel-catalog.json` — 10 个通道的 label/blurb/npmSpec
- `<openclaw>/dist/cli-startup-metadata.json` — 22 个通道 ID 列表
- `openclaw channels add --help` — 动态解析 `--channel` 枚举（决定 CLI vs json-direct）

**KNOWN_OVERRIDES（增强层，不是 hardcode）**：
- 提供品牌色、多字段表单、one-click 流程等 UX 增强
- 新通道自动显示（首字母图标 + 通用 token 表单），无需代码改动
- OpenClaw 更新后新增通道 → 重启 app 自动出现

**CLI vs json-direct 规则**：
- `openclaw channels add --channel` 枚举中的通道（telegram/whatsapp/discord/irc/googlechat/slack/signal/imessage/line）→ 走 `channels add` CLI
- 不在枚举中的通道（msteams/nostr/tlon/mattermost 等）→ 直接写 `openclaw.json channels[id] = { ...config, enabled: true }`
- 通过运行时解析 `--help` 输出动态判断，不 hardcode

**通道配置 schema 来源**：
- OpenClaw 的 `openclaw.plugin.json` 中 `configSchema` 大多为空 `{}`
- 真实 schema 在运行时 Zod 定义中（如 `MSTeamsConfigSchema` 包含 `appId`, `appPassword`, `tenantId`）
- 无法在不执行 JS 的情况下读取 → 多字段通道仍需在 `KNOWN_OVERRIDES` 中维护配置表单
- 通用 token 通道（大多数）自动用默认 `--token` 表单

**文件结构**：
- `electron/channel-registry.ts` — 核心注册表（Electron 主进程用）
- `src/lib/channel-registry.ts` — re-export 给前端 React 组件用
- `src/components/ChannelIcon.tsx` — 12 个品牌 SVG + 动态首字母 fallback
- `src/pages/Channels.tsx` — `DynamicConfigForm` 组件从注册表 configFields 渲染表单

### 升级流程超时与进度反馈（深度踩坑）
- **问题**：升级流程（OpenClaw + Plugin + Daemon）最长可达 10+ 分钟（npm install 依赖 300s 超时 + 多层降级），前端只有一个 spinner，用户完全不知道进度
- **npm install 是黑盒**：npm 在非 TTY（spawn pipe）模式下不输出进度条，stdout 在命令完成后才一次性返回。`--loglevel verbose` 输出太嘈杂且不同 npm 版本格式不一，不推荐
- **超时 = 浪费已完成工作**：如果 npm install 在第 301 秒超时，前面已安装的 80% 依赖全部浪费（因为升级开始时 `rmSync` 了旧目录）
- **解决方案**：
  1. `runAsyncWithProgress(cmd, timeout, onLine)` — 带逐行 stdout/stderr 回调的 spawn 变体，不改动 `runAsync` 本身
  2. `sendUpgradeProgress()` — 主进程通过 `BrowserWindow.webContents.send('app:upgrade-progress')` 实时推送阶段信息到渲染进程
  3. `BrowserWindow.setProgressBar()` — 任务栏/Dock 进度条（>1 = 不确定，0-1 = 确定，-1 = 清除）
  4. 200ms 节流 — 防止 npm 输出行刷爆渲染进程
- **规则**：
  - 长时间命令（>30s）必须使用 `runAsyncWithProgress` 并推送阶段进度，不能让用户看着空白 spinner
  - IPC 进度推送用 `webContents.send`（单向推送），不能放在 `ipcMain.handle` 返回值里
  - 确定进度（如 daemon 健康检查 i/12）传 `progressFraction: 0-1`，不确定进度不传该字段
  - 复用已有模式：`skill:install-progress`（register-skill-handlers.ts）和 `app:startup-status`

### OpenClaw 技能依赖安装三大坑（严重踩坑，已修复）

#### 1. `openclaw skills info --json` 丢弃 install spec 关键字段
- **问题**：SKILL.md frontmatter 中定义了 `formula`（brew 包名）、`module`（go 模块路径）、`package`（node/uv 包名），但 `openclaw skills info --json` 的 `install` 数组只返回 `id/kind/label/bins`，丢弃了所有包名相关字段
- **后果**：`buildInstallCommands` 用 `bins[0]` 当包名 → `brew install op`（应该是 `brew install 1password-cli`）、`brew install grizzly`（安装了 Grafana 的工具而非 Bear Notes CLI）
- **修复**：`skill:local-info` IPC 在获取 CLI 输出后，通过 `filePath` 字段直接读取 SKILL.md，解析 YAML frontmatter 恢复完整 install spec 再 merge 回 CLI 输出
- **SKILL.md 格式注意**：`metadata` 字段用 JSON-in-YAML 格式（花括号），且有 trailing commas（JSON5 风格），解析时需 `.replace(/,(\s*[}\]])/g, '$1')` 先清理

#### 2. OpenClaw 支持 5 种 install kind（必须全部覆盖）
- **brew**: `spec.formula` → `brew install <formula>`（如 `brew install 1password-cli`、`brew install antoniorodr/memo/memo`）
- **go**: `spec.module` → `go install <module>`（如 `go install github.com/tylerwince/grizzly/cmd/grizzly@latest`）
- **node**: `spec.package` → `npm install -g <package>`（用户可配 pnpm/yarn/bun）
- **uv**: `spec.package` → `uv tool install <package>`
- **download**: `spec.url` → 下载+解压（我们暂未支持）
- **`ALLOWED_INSTALL_BINARIES`** 必须包含 `go` 和 `uv`，否则这两种 kind 的命令会被安全检查拦截

#### 3. OpenClaw CLI JSON 输出到 stderr（不是 stdout）
- **问题**：`openclaw skills info <name> --json` 的 JSON 输出在 **stderr**，不在 stdout
- **Config warnings** 也在 stderr（如 "duplicate plugin id detected"）
- **影响**：测试脚本用 `2>/dev/null` 会吃掉 JSON 输出；桌面端 `runAsync`/`readShellOutputAsync` 合并 stdout+stderr 所以不受影响
- **规则**：测试 OpenClaw CLI 输出时必须用 `2>&1` 或不重定向，不能用 `2>/dev/null`

### `openclaw channels login` 是常驻 bot worker，不是短命令（极严重踩坑，2026-04-07）
- **错误模型**：把 `openclaw channels login --channel <id>` 当成"登录完就该退出的 setup 命令"，加 mutex/kill/idle-timeout 想"清理僵尸"
- **真实情况**：这个进程**本身就是 bot worker**，登录完成后**永远不退出**。它持续运行才能维持 WeChat/WhatsApp/Signal session、接收消息、路由回调。日志里出现 `weixin monitor started` 就代表 bot 已就绪
- **child.on('exit') 永远不触发**，所以任何"等 exit 释放 mutex"的设计都会死锁
- **致命后果**：
  - 启动期 `killAllStaleChannelOps` 无差别杀 `*openclaw.mjs*channels*` → **杀掉所有正常工作的 bot worker**，所有 channel 静默掉线
  - spawn 前 fire-and-forget `killStaleChannelLogins` → race window 内**误杀刚被 register 的合法 bot**
  - mutex `await child.on('exit')` 永远不解锁 → 下一次 connect 永远等不到锁
  - "Disconnect" 按钮调 `channel:remove` → 删 config + 杀 bot → 用户重连必须重扫 QR
- **正确架构**（commit `c19d999`）：
  - **绝不杀 `channels login` worker**：`killAllStaleChannelOps` 必须 `-notlike '*channels login*'`，只杀 list/add/cron 这种短命令
  - **PID safe list**：`killStaleChannelLogins` 改成"用 `activeLogins` Map 里的 PID 做 safe list，powershell `-notcontains` 排除"，绝不杀 tracked 的 bot
  - **三态判断**：`tracked → 跳过`、`untracked orphan → kill+replace`、`no worker → spawn`。用 `getTrackedLoginPid(channelId)` + `killOrphanWorkerForChannel(channelId)` 实现
  - **登录成功用日志回调判定**：`watchOpenClawLogForQrUrl` 监听 `weixin monitor started` 触发 `onLoginSuccess`,在回调里 resolve IPC promise but **NOT kill the child**
  - **App 启动 45s 后自动重连**:`autoReconnectChannelWorkers()` 读 `openclaw.json` 找 enabled channel,三态判断决定是否 spawn(配置在但 worker 不在 → 自动重连),5s 错开避免抢资源
  - **软断开**:新增 `channel:disconnect` IPC,只 kill worker + `enabled: false` + restart gateway,**config 保留**;Reconnect 时不用重扫 QR
- **规则**:任何 spawn `openclaw channels login` 的代码 + 任何 kill openclaw 子进程的代码,**必须**先想清楚"我会不会杀到正在维持 session 的 bot worker"。设计 mutex/dedup 时,**必须**区分"短命令"和"常驻 worker",绝不能用同一套清理逻辑

### Electron dev 模式踩坑（monorepo）
- **问题**：`./node_modules/.bin/electron .` 在 monorepo 中找不到 electron 二进制（被 hoist 到根 node_modules）
- **`require('electron')` 返回字符串**：在非 Electron 进程中 `require('electron')` 返回的是 electron 可执行文件的路径字符串，不是 API 对象
- **正确方式**：在 `npm scripts` 中用 `electron .`（npm 自动加 PATH），或使用根 `node_modules/.bin/electron`
- **tsconfig.electron.json rootDir**：必须保持 `"electron"`，不能改成 `"."`（否则编译输出目录结构变化，`package.json main` 路径断裂）
- **共享文件**：需要被 Electron 和前端同时 import 的文件（如 channel-registry.ts）放在 `electron/` 目录，前端通过 `src/lib/` re-export
## 🛡️ 上线门禁方法论：5 层测试金字塔（MANDATORY）

**为什么要有**：v0.3.0 前后连续几次"测试全绿但用户打开就崩"的事故。根因：测试验证的是代码路径，不是用户路径。

本文件与 `/Users/edwinhao/Awareness/CLAUDE.md` 的方法论保持同步，OCT-Agent 桌面端（Electron + React）也必须按同一标准。

### Layer 1 · Static + Contract Guards
- **IPC 契约**：每条 `ipcRenderer.invoke(...)` 必须有后端 handler。加 `scripts/verify-ipc.mjs`（扫 `window.api.*` 调用 vs `ipcMain.handle` 注册表）
- **按钮 wire 检查**：对 React 组件，`onClick={undefined}` 或缺 handler → 编译期 TS 报错（`strict: true` + `noImplicitAny`）
- **Channel 名字单一来源**：`electron/channel-registry.ts` 必须覆盖前后端所有 channel；新增 IPC 前先在 registry 里声明，否则 TS 报错

### Layer 2 · Integration Tests
- vitest + @testing-library/react
- 每个 React hook + service 模块必须有集成测试
- **允许**：mock Electron API（electronAPI）、LLM 调用、文件系统
- **禁止**：mock 同进程的 React 组件

### Layer 3 · Failure-Mode / Chaos Tests
- 每条 `window.api.x()` 调用必须测 3 种返回：success / rejected with Error / promise hangs (timeout)
- LLM provider 故障必须测：`classifyProviderError()` 的 8 类错误每类一个测试（已有，保持扩充）
- OpenClaw CLI spawn 失败：stderr 丢失、进程僵死、ENOENT 都要有对应测试

### Layer 4 · User Journey E2E — 零 Mock（Playwright + Electron）
- 位置：`OCT-Agent/packages/desktop/test/e2e/user-journeys/`
- 工具：`@playwright/test` + Playwright Electron 模式
- **ESLint 规则**：禁止在此目录下用任何 `page.route` 或 `mockIpc`
- 每条 journey 对应一份 `docs/acceptance/<F>.md` Given/When/Then
- 典型 journey：
  - 首次打开 → 选工作区 → 启动 OpenClaw → 发一条消息
  - 连云端 → 切工作区 → Memory UI 刷新
  - 升级检测 → 点击 banner → 打开下载页
- **断言**：用户可见文字/窗口标题/IPC 事件的最终可见效果，不是内部 store state

### Layer 5 · Mutation Testing
- Stryker on `electron/memory-client.ts` + `electron/register-setup-handlers.ts` + `src/lib/provider-errors.ts`
- ≥ 80% mutation score 才能 tag release

### Definition of Done（PR 合并清单，桌面端）
1. [ ] 新 IPC handler → `channel-registry.ts` 声明 + `verify-ipc.mjs` 过
2. [ ] 新 `window.api.x()` 调用 → 有 L3 success / reject / timeout 测试
3. [ ] 新按钮/菜单项 → onClick handler 非 undefined + 有 E2E 点击
4. [ ] 新功能 → 有 `docs/acceptance/<F>.md`
5. [ ] 对应的 `test/e2e/user-journeys/<slug>.spec.mjs` 零 mock
6. [ ] `npm run ship-gate` 全绿
7. [ ] CHANGELOG 写"用户感知的变化"
8. [ ] 亲手在 DMG 打包后的 app 里走过一遍（不是 dev mode）

### DMG 发布前 Smoke Playbook（必跑）
每次 `npm run package:mac` 产出 DMG 后，执行 `bash scripts/dmg-smoke.sh`：
1. 从全新临时用户目录启动（不污染当前配置）
2. 检查主窗口标题、菜单、默认工作区
3. 启动 OpenClaw，发一条消息，断言消息回显
4. 检查升级 banner 正确显示/隐藏
5. 关窗口，重开，断言状态恢复
任一步失败 → 禁止上传分发、禁止更新 `app-versions.json`

### 禁止项
- ❌ `test/e2e/user-journeys/` 下的 `page.route` / `mockIpc`
- ❌ 只测 happy path 不测 `rejected` 分支的 IPC 调用测试
- ❌ 新 IPC handler 没进 `channel-registry.ts`
- ❌ onClick 事件 handler 是 `undefined` 或 `() => {}` 空函数
- ❌ 未在真实 DMG 里走过 happy path 就 bump 版本

> 与主仓同步：任何方法论改动**两个 CLAUDE.md 同时更新**，保持一致。
