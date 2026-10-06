---
type:
tags: [soil, recycling]
---

# Compost

This block is fenced and parses cleanly, but `type:` is blank and there is
no `title` at all — two metadata defects the contract must surface.

## Notes

A blank `type` must fall back to `type:"other"`, and the missing title must
be derived from the first heading rather than from the file name.
