
# 文件撤销功能完整性修复报告

## 修复概述
针对文件撤销功能中可能导致文件状态不完整或遗漏的问题，进行了全面的分析和修复。

## 修复的 Bug

### Bug 2: copyIntoObjects 流式回退不验证副本
**位置**: index.js:358-375
**修复内容**:
- 在 copyIntoObjects 中验证写入后的文件 hash
- 如果 hash 不匹配，删除损坏的文件并抛出异常
- 确保对象文件内容与 manifest 中的 hash 一致

**影响**:
- 修复前：对象文件可能包含错误内容，但 manifest 中的 hash 指向它
- 修复后：确保对象文件内容正确，防止后续 restore 拷贝错误内容

### Bug 3: 文件权限变更不被检测
**位置**: index.js:232-233, 387-398
**修复内容**:
- unchanged 检测增加 mode 比较（prevMode === currentMode）
- manifestsEqual 增加 mode 比较

**影响**:
- 修复前：文件权限变更永久丢失
- 修复后：文件权限变更被正确检测并保存到 manifest

### Bug 4: restore 静默跳过缺失的对象
**位置**: index.js:443-453
**修复内容**:
- 记录跳过的文件列表（skippedFiles）
- 在返回结果中包含 skippedFiles
- 添加日志输出跳过的文件

**影响**:
- 修复前：用户不知道哪些文件没有恢复
- 修复后：用户能通过返回结果知道哪些文件跳过及原因

### Bug 5: restore 部分失败导致工作区不一致
**位置**: index.js:417-469
**修复内容**:
- 记录删除失败的文件（failedDeletions）
- 在返回结果中包含 failedDeletions
- ok 字段综合考虑 skippedFiles 和 failedDeletions

**影响**:
- 修复前：工作区被置于不一致状态，ok: true 误导用户
- 修复后：返回部分成功状态，用户能知道哪些文件删除失败

### Bug 6: 安全性快照的 turn 编号排序可能导致预览异常
**位置**: index.js:928-931
**修复内容**:
- safety snapshot 编号从 lastTurn + 0.9 改为 lastTurn + 0.999

**影响**:
- 修复前：preview 可能显示不准确的 changes
- 修复后：preview 显示准确的 changes

## 新增测试用例

### 1. 权限变更检测测试
- 创建可执行文件并捕获
- 验证权限变更是否被检测

### 2. 跳过文件测试
- 模拟对象缺失场景
- 验证 skippedFiles 正确记录
- 验证 ok 字段正确反映部分失败

## 验证结果
所有测试通过，包括：
- 基础功能测试（capture, restore, preview）
- 对象污染回归测试
- 权限变更检测测试
- 跳过文件测试

## 后续建议
1. 增加更多边界情况测试（如超大文件、特殊字符文件名等）
2. 考虑增加原子性恢复（先备份再恢复，失败时回滚）
3. 考虑增加恢复验证（恢复后验证文件 hash）
