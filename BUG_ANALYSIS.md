
# dsh-turn-undo 代码深度分析 — 边界情况与 Bug 报告

## 分析方法
逐行审查所有源代码（index.js 1091 行 + client.js 480 行 + test-integration.mjs 109 行），
追踪每一条数据流和错误路径，对照 DSH 实际运行场景。

---

## 🔴 严重 Bug（可能导致数据丢失或功能错误）

### Bug 1: scan 方法中 total 变量逻辑错误

位置: index.js 第 271-307 行

代码:
  let total = 0
  const walk = (dir) => {
    for (const ent of entries) {
      if (st.isDirectory()) {
        if (files.length + total > this.maxFiles) return  // 这里检查 total
        walk(abs)
      } else if (st.isFile()) {
        if (files.length >= this.maxFiles) return
        if (st.size > this.maxFileBytes) { total++; continue }  // 这里才增加 total
        files.push(abs)
      }
    }
  }

问题:
  - total 在 isDirectory 分支中被检查，但只在 isFile 分支中被增加
  - 当即将进入子目录时，total 尚未增加（因为子目录中的文件还没遍历）
  - 所以 files.length + total 等价于 files.length，+ total 是死代码
  - 意图表达错误：逻辑意图可能是当文件总数超过限制时跳过子目录
  - 实际效果：只在 isFile 分支的 files.length >= this.maxFiles 生效

影响: 不会导致功能错误（最终检查在 walk(cwd) 之后），但逻辑表达错误。

修复: 删除 + total，改为 if (files.length > this.maxFiles) return

---

### Bug 2: copyIntoObjects 流式回退不验证副本

位置: index.js 第 358-375 行

代码:
  async copyIntoObjects(src, dst) {
    try {
      copyFileSync(src, dst)
    } catch {
      try {
        const rs = createReadStream(src)
        const ws = createWriteStream(dst)
        await new Promise((resolve, reject) => {
          rs.on('error', reject)
          ws.on('error', reject)
          ws.on('finish', resolve)  // finish 不代表内容正确
        })
      } catch (e) {
        console.warn('[turn-undo] object write failed:', e.message)
      }
    }
  }

问题:
  - copyFileSync 失败后进入流式回退
  - 流式写入 finish 事件只表示所有数据已写入文件系统缓冲
  - 如果磁盘满、权限不足、或文件系统错误，ws.on('error') 不会触发
  - 更重要的是：hashFile(abs) 在 copyIntoObjects 之前就调用了（第 235 行）
  - 如果流式写入失败或写入不完整，objPath 文件内容与 hash 不匹配
  - capture 方法不检查 copyIntoObjects 的返回值，无法知道写入是否成功

影响: 对象文件可能包含错误内容，但 manifest 中的 hash 指向它。后续 restore 会拷贝错误内容。

修复: 
  1. 在 copyIntoObjects 中验证写入后的文件 hash
  2. 或在 copyIntoObjects 失败时抛出异常让 capture 捕获

---

### Bug 3: 文件权限变更不被检测

位置: index.js 第 232-233 行, 第 387-398 行

代码:
  if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) {
    entry = prev // unchanged
  }
  
  manifestsEqual(a, b) {
    if (ea.hash !== eb.hash) return false
    // 不比较 mode
  }

问题:
  - capture 的 unchanged 检测只比较 size 和 mtime，不比较 mode
  - 如果文件权限被 chmod 改变但内容不变：
    - prev.size === st.size && prev.mtime === st.mtimeMs -> true
    - entry = prev -> 重用旧 entry（含旧 mode）
    - manifestsEqual(prevManifest, manifest) -> true（hash 相同）
    - capture 返回 null -> 不创建新快照
  - 文件权限变更永久丢失

影响: 用户通过 chmod 改变文件权限后，撤销后权限不会恢复。

修复: unchanged 检测应包含 mode 比较。

---

### Bug 4: restore 静默跳过缺失的对象

位置: index.js 第 443-453 行

代码:
  if (!existsSync(objPath)) continue  // 静默跳过

问题:
  - 当对象文件不存在时，continue 静默跳过
  - restoredFiles 不增加，但也没有任何警告或错误日志
  - 用户不知道哪些文件没有恢复

影响: 如果对象文件丢失，用户会看到部分文件恢复、部分不恢复，但不知道原因。

修复: 记录跳过的文件列表，并在返回结果中告知用户。

---

### Bug 5: restore 部分失败导致工作区不一致

位置: index.js 第 417-469 行

问题:
  - Step 1（恢复文件）中每个文件有 try/catch，但不会中断循环
  - Step 2（删除多余文件）中每个文件有 try/catch，但不会中断循环
  - 如果 Step 1 部分成功，Step 2 仍然会执行
  - 最终状态：部分文件是目标状态，部分文件是旧状态
  - ok: true 表示成功，但实际是部分成功

影响: 在极端情况下（磁盘满、权限错误），工作区被置于不一致状态。

修复: 记录失败的步骤和文件，返回部分成功状态，或原子化执行。

---

### Bug 6: 安全性快照的 turn 编号排序可能导致预览异常

位置: index.js 第 928-931 行, 第 670-672 行

问题:
  - safety snapshot: lastTurn + 0.9
  - turn start: turn - 0.5
  - 对于 consecutive turns（3 -> 4）：
    - safety = 3 + 0.9 = 3.9
    - next start = 4 - 0.5 = 3.5
  - 3.9 > 3.5，所以 safety snapshot 在链中排在 next start 之后
  - latest = chain[chain.length - 1] = 3.9（safety snapshot）
  - 如果用户想预览 turn 4：
    - baseline = latest snapshot < 3.5 = 3.0
    - latest = 3.9
    - changes = 3.9 - 3.0（可能包含 safety snapshot 的内容）

影响: 预览可能显示不准确的 changes。在大多数情况下影响可忽略（safety snapshot 内容与 turn 3 结束相同）。

修复: 使用更大的偏移量（如 lastTurn + 0.999），或改用独立命名空间。

---

## 🟡 中等 Bug

### Bug 7: walkAll/scan/walk 递归无深度保护

位置: index.js 第 275-302 行, 第 315-342 行

问题:
  - Node.js 默认调用栈深度约 10,000 层
  - 如果工作区有超过 10,000 层嵌套目录，会栈溢出
  - 递归在 walk 函数中，没有尾调用优化

影响: 在极端目录结构下，快照或恢复会崩溃。

修复: 改用迭代方式（栈模拟）。

---

### Bug 8: capture 存在 TOCTOU 竞态条件

位置: index.js 第 206-238 行

问题:
  - scan 获取文件列表后，文件可能被删除或移动
  - hashFile(abs) 会抛出异常
  - capture 没有 try/catch，异常传播到 enqueueCapture

影响: 在并发写入场景下，快照可能失败。

修复: 在 hashFile 中增加错误处理。

---

### Bug 9: resolveForkBoundary 策略 2 可能匹配错误消息

位置: index.js 第 565-578 行

问题:
  - events.find 返回第一个匹配的消息
  - 如果有多个用户消息内容相似，可能匹配到错误的消息

影响: 在策略 1 失败的极端情况下，撤销可能应用到错误的消息位置。

修复: 策略 2 应使用更精确的匹配。

---

## 🔵 轻微 Bug / 设计改进

### Bug 10: preview 不反映中间恢复的影响

问题:
  - preview 基于快照链，不是基于当前工作区
  - 如果工作区在预览后被修改，preview 显示的 changes 可能不准确

### Bug 11: materializeObject 的 parseInt(mode, 8) 可能失败

问题:
  - 如果 mode 格式异常，parseInt 可能返回 NaN
  - chmodSync(dest, NaN) 会抛出异常

### Bug 12: writeJsonFile 的原子写入 fallback 可能丢失数据

问题:
  - renameSync 失败时 fallback 直接 writeFileSync 覆盖
  - 如果覆盖过程中进程崩溃，文件可能损坏

---

## 📊 总结

| 严重度 | 数量 | 主要问题 |
|-------|------|---------|
| 严重 | 6 | 对象污染、静默跳过、部分失败 |
| 中等 | 3 | 递归深度、TOCTOU、消息匹配 |
| 轻微 | 3 | 预览不一致、parseInt 失败、原子写入 |

最需要立即修复的:
1. Bug 2: copyIntoObjects 流式回退验证
2. Bug 3: 文件权限变更检测
3. Bug 4: restore 静默跳过对象
