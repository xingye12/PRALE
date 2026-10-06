---
type: concept
title: 手工锁定页
locked: true
description: 被用户手工锁定的页面，ingest 必须跳过
---

# 手工锁定页

本页 frontmatter 带 `locked: true`。isLocked 返回 true，ingest 合并/重写阶段必须跳过此页。
buildPage 永不写出 locked 字段——它只由 page/write 注入。
