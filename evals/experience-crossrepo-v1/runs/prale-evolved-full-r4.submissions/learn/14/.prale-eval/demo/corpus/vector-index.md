---
type: concept
title: HNSW 向量索引
description: Graph-based approximate nearest neighbour index used for memory recall.
tags: [ann, vector-search]
sources: [vector-index.md]
---

# HNSW 向量索引

HNSW builds a multi-layer proximity graph; upper layers are sparse for fast descent and
the bottom layer holds every point for recall.

## 参数

`M` controls out-degree, `efConstruction` trades build time for graph quality.
