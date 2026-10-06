---
type: entity
title: Redis 主从
description: Redis 主从复制与故障转移。
sources:
  - raw/notes/redis.md
tags:
  - redis
---
# Redis 主从

Redis 主从复制：一个 master、多个 replica。

## 主从复制

全量 + 增量（repl backlog）同步。

## 主从复制

同文件重复标题：第二次出现必须拿到确定性的 `-2` 后缀 anchor。

## 故障转移

Sentinel 选主流程。
