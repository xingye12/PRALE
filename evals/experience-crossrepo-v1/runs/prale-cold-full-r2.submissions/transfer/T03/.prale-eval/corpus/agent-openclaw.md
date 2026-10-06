---
type: source
title: OpenClaw 资产导入
tags: [openclaw, session
---
# OpenClaw 资产导入

frontmatter 是闭合的，但 YAML 本身非法（流式序列未闭合的 `[`），必须显式回退。

## 扫什么

| 类型 | 路径 |
|---|---|
| Skill | `$HOME/.agents/skills/*/SKILL.md` |

## 用法

```bash
memoryhub import --agent openclaw
```
