---
type: assets
description: CodeBuddy 资产导入（缺 title，且 type 是未知值）
sources: [raw/agents/codebuddy.md, 42, null, true]
tags: [codebuddy, import]
---
# CodeBuddy 资产导入

frontmatter 合法但字段不合法：`title` 缺失、`type: assets` 未在 TYPE_DIR 中登记、
`sources` 里混入了非字符串条目。

## 前置

数据根 `$CODEBUDDY_HOME`。

## 扫什么

| 类型 | 路径 |
|---|---|
| Skill | `$HOME/.agents/skills/*/SKILL.md` |
