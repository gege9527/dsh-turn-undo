# dsh-turn-undo

> DSH 插件：在任意用户消息处点击“撤销”，让对话恢复到发送这条消息之前的状态——回滚 AI 造成的文件变更，并 fork 出新会话继续编辑。

## 功能

- ✅ 每条用户消息的操作栏注入一个“撤销”按钮（↺）。
- ✅ 弹窗显示本轮会恢复/删除/修改的文件，并给出警告。
- ✅ 确认后：
  - 恢复工作区文件到**发送该消息之前**的快照状态。
  - 通过 DSH 原生的 `sessionController.fork` 从该消息之前 fork 出新会话。
  - 旧会话保留，标题前方自动加上 `（已撤销）`。
  - 新会话输入框自动填入被撤销的这条用户消息，方便你修改后重发。
- ✅ 不依赖 git，适用于任何目录。
- ✅ 快照去重（sha256 内容寻址），未变化文件零成本存储。
- ✅ 自动清理：TTL + 每会话数量上限。

## 安装

```sh
dsh plugin --profile <name> add dsh-turn-undo
```

## 使用

1. 在对话中，每条用户消息的操作栏会出现撤销按钮。
2. 点击按钮，弹窗列出本轮影响的文件。
3. 点击“确认恢复并继续”：
   - 文件恢复。
   - 旧会话被标记为 `（已撤销）`。
   - 新会话打开，输入框里已有原消息内容。
4. 在新会话里修改问题后重新发送即可。

## 架构

### 服务端（`index.js`）

- **快照触发**：监听 `session/event` 全局事件。
  - `turn/start`：生成 `turn - 0.5` 小数快照，记录用户发消息之前的工作区状态。
  - `turn/end`：生成整数 `turn` 快照，记录 AI 完成工作后的状态。
- **存储**：
  - `$DSH_HOME/turn-undo/objects/<sha256>`（内容去重）
  - `$DSH_HOME/turn-undo/snapshots/<sessionId>/<turn>.json`（manifest：path → hash）
- **恢复**：从 `turn - 0.5` 快照回写文件，并删除快照里不存在的文件。
- **fork**：
  - 调用 DSH 官方 web 同款的 `ctx.sessionController.fork({ sessionId, atSeq })`。
  - 对“第一条用户消息”前面没有 completed turn 时，fall back 到 `ctx.sessionController.create({ cwd, agentPreset })` 创建空白会话。
  - 旧会话通过 `ctx.sessionController.rename` 加上 `（已撤销）` 前缀。
- **HTTP API**：
  - `GET /api/turn-undo?sessionId=...&messageSeq=...&promptText=...`：预览本轮影响。
  - `POST /api/turn-undo`（body `{ sessionId, messageSeq, promptText }`）：执行恢复 + fork。

### 客户端（`client.js`）

- `MutationObserver` 自动检测新增的用户消息。
- 在用户消息的 IconActions 区域通过 portal 注入撤销按钮。
- 弹窗组件：`RestoreButton` + `RestoreModal`。
- 恢复完成后先打开新会话，再轮询设置输入框草稿（`conversation.input.shell(...).setDraft(...)`）。

## 配置

在 `cordis.patch.yml` 中配置：

```yaml
- insert:
    - id: turn-undo
      name: dsh-turn-undo
      config:
        snapshotTtlDays: 7              # 快照保留天数
        maxSnapshotsPerSession: 50      # 每会话最多保留快照数
        maxFileBytes: 10485760          # 单个文件超过 10MB 不纳入快照
        maxFilesPerSnapshot: 10000      # 单次快照最多文件数
        maxSnapshotBytes: 524288000     # 单次快照总大小上限 500MB
        snapshotDelayMs: 250            # turn/end 后等待落盘的延迟
        excludes:                       # 覆盖默认忽略目录/文件
          - node_modules/
          - .git/
          - dist/
```

默认 excludes 还会过滤：`.venv/`、`venv/`、`__pycache__/`、`target/`、`build/`、`.next/`、`.turbo/`、`.gradle/`、`.idea/`、`.vscode/`、`coverage/`、`.DS_Store`、`*.log`。注意：这些只是扫描时的过滤，restore 的删除阶段也遵循同样规则。

## 开发

运行集成测试：

```sh
node test-integration.mjs
```

语法检查：

```sh
node -e "import('./index.js')"
node -c client.js
```

在 DSH 里热加载/测试：

```sh
cd /Users/lyu/Documents/Source/deepseek-harness
pnpm dsh web
```

> 客户端（`client.js`）修改后，若 `pnpm run dev:web` 没在开，需要重新构建客户端 bundle 并刷新页面。

## 已知限制

- 只能恢复 AI 通过 DSH 工具产生的文件变更；无法捕获：
  - 用户通过 VS Code 等外部编辑器直接修改的文件。
  - 用户在终端里直接执行的 shell 命令。
  - MCP 工具中不经过 DSH 工具管线的操作。
- 撤销依赖本插件在运行期间生成的快照；对安装插件之前的旧会话无效。
- 第一条用户消息的撤销会创建空白新会话（因为没有 completed turn 可 fork）。
- 超过容量上限的单次快照会被跳过，并打印警告。

## 许可

MIT
