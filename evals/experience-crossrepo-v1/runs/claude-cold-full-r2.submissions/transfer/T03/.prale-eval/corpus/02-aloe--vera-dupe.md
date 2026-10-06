---
type: entity
title: aloe  vera!
sources: 03-succulents.md
---

The frontmatter above is well-fenced but semantically invalid: `sources` is a
scalar string where the contract requires a list of source names.

# Overview

Same entity, spelled differently: "aloe  vera!" must normalize to the same
slug as "Aloe Vera" so the second ingest merges instead of creating a
second page.

## Notes

Spelling variants and punctuation are not new entities.
