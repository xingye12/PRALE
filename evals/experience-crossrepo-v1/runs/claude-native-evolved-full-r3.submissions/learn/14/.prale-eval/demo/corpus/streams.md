---
type: concept
title: Redis Streams
sources:
  - seeds/streams.md
description: 追加型日志数据结构，支持消费者组
---

# Redis Streams

Redis Streams 是追加型（append-only）日志结构，为消息队列场景提供持久化与消费者组语义。

## 消费者组

`XGROUP` 建立消费者组，`XREADGROUP` 携带组名与消费者名读取；同组内每条消息只投递给一个消费者。
`XACK` 确认处理完成，`XPENDING` 查看未确认条目，配合 `XAUTOCLAIM` 可处理消费者宕机后的滞留消息。
