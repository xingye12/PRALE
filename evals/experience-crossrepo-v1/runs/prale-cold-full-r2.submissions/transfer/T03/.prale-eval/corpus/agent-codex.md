---
type: source
title: Codex 资产导入
description: 把本机 Codex 的 skill / session 导入 Memory Hub。
sources:
  - raw/agents/codex/asset-import.md
tags:
  - codex
  - import
timestamp: 2026-08-22
locked: false
---
# Codex 资产导入

把本机 Codex 的 **skill / session** 导入 Memory Hub。这一份手册即可完成。

## 扫什么

| 类型 | 路径 |
|---|---|
| Skill | `$HOME/.agents/skills/*/SKILL.md` |
| Session | `$CODEX_HOME/sessions/**/*.jsonl` |

## 用法

```bash
memoryhub import --agent codex --sessions ~/.codex/sessions
```

## 1. 客户端接入配置

在 `~/.codex/config.toml` 中登记 Memory Hub：

```toml
# 注意：这行注释以 # 开头，位于围栏代码块内，不应被当作标题
[memory]
base_url = "http://127.0.0.1:8096"
```

## 扫什么

第二次出现的小节标题，用于验证同页重复标题的确定性去重。
