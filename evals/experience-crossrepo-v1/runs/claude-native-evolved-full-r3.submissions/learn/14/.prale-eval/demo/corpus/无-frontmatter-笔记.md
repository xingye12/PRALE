Mixed CJK note without YAML frontmatter.

This file exists to exercise two behaviors:
1. parseFrontmatter must tolerate a missing frontmatter block and fall back to type "other".
2. slugify must keep CJK characters verbatim while lowercasing latin runs.
