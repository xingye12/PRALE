Loose notes without YAML frontmatter.

The ingest reader must tolerate this: `parseFrontmatter` degrades to `{ type: "other" }`
and keeps the whole file as the body.

## Follow up

Assign a slug from the file name fallback instead of the (missing) title.
