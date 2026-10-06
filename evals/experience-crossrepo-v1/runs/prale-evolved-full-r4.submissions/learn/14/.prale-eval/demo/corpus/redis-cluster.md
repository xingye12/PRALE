---
type: entity
title: Redis Cluster
description: Distributed Redis deployment mode with hash-slot sharding.
tags:
  - cache
  - distributed
sources:
  - redis-cluster.md
timestamp: 2024-01-02T00:00:00.000Z
---

# Redis Cluster

Redis Cluster shards the keyspace across 16384 hash slots and assigns each slot to a
primary node, with optional replicas for failover.

## Failover

When a primary becomes unreachable the remaining primaries vote and promote a replica.
