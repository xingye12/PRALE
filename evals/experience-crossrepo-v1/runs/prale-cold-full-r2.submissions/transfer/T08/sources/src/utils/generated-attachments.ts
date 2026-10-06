export interface GeneratedAttachment {
  name: string
  path: string
  media?: boolean
}

export interface GeneratedAttachmentParseResult {
  attachments: GeneratedAttachment[]
  content: string
}

const FILE_NAME_HEADERS = ['文件名', '文件名称', 'filename', 'file name', 'name']
const FILE_PATH_HEADERS = ['路径', '文件路径', '保存路径', '输出路径', 'filepath', 'file path', 'path']
const FILE_DELIVERY_CUE = /(?:文件.*(?:已生成|已保存|保存在|保存至)|(?:已生成|已保存).*(?:文件|保存在)|(?:文件路径|保存路径|输出路径))\s*[：:]\s*$/i

function cleanMarkdownText(value: string): string {
  return value
    .trim()
    .replace(/^\*+|\*+$/g, '')
    .trim()
    .replace(/^`+|`+$/g, '')
    .trim()
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(cleanMarkdownText)
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')))
}

function findHeaderIndex(headers: string[], candidates: string[]): number {
  return headers.findIndex((header) => {
    const normalized = header.trim().toLowerCase()
    return candidates.some((candidate) => normalized === candidate || normalized.includes(candidate))
  })
}

function matchesTableLabel(value: string, candidates: string[]): boolean {
  const normalized = cleanMarkdownText(value).toLowerCase()
  return candidates.some((candidate) => normalized === candidate)
}

function markdownLinkTarget(value: string): { label: string; target: string } | null {
  const match = value.trim().match(/^\[([^\]]+)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)$/)
  if (!match) return null
  return {
    label: cleanMarkdownText(match[1] || ''),
    target: cleanMarkdownText(match[2] || match[3] || ''),
  }
}

function normalizeAttachmentPath(value: string): string | null {
  const link = markdownLinkTarget(value)
  const path = cleanMarkdownText(link?.target || value)
    .replace(/^<|>$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()

  if (!path || path.endsWith('/') || path.includes('\0')) return null
  if (/^(?:https?|data|mailto|javascript):/i.test(path)) return null
  if (path.split('/').includes('..')) return null

  const name = path.split('/').filter(Boolean).pop() || ''
  if (!name || !name.includes('.')) return null
  return path
}

function attachmentName(nameCell: string, path: string): string {
  const link = markdownLinkTarget(nameCell)
  const name = cleanMarkdownText(link?.label || nameCell)
  return name || path.split('/').filter(Boolean).pop() || path
}

function dedupeAttachments(attachments: GeneratedAttachment[]): GeneratedAttachment[] {
  const seen = new Set<string>()
  return attachments.filter((attachment) => {
    const normalizedPath = attachment.path.replace(/\\/g, '/').toLowerCase()
    const workspaceDirectoryMatch = normalizedPath.match(/(?:^|\/)(downloads|outputs|artifacts|uploads)\/(.+)$/)
    const key = workspaceDirectoryMatch
      ? `${workspaceDirectoryMatch[1]}/${workspaceDirectoryMatch[2]}`
      : normalizedPath.replace(/^\/+/, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function extractGeneratedAttachments(content: string): GeneratedAttachmentParseResult {
  if (!content.trim()) return { attachments: [], content }

  const lines = content.split('\n')
  const attachments: GeneratedAttachment[] = []
  const removedLines = new Set<number>()

  for (let index = 0; index < lines.length; index += 1) {
    const mediaMatch = (lines[index] || '').match(/^\s*MEDIA:\s*(.+?)\s*$/i)
    if (!mediaMatch) continue

    const path = normalizeAttachmentPath(mediaMatch[1] || '')
    if (!path) continue

    attachments.push({
      name: attachmentName('', path),
      path,
      media: true,
    })
    removedLines.add(index)
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!FILE_DELIVERY_CUE.test(lines[index] || '')) continue

    let pathIndex = index + 1
    while (pathIndex < lines.length && !(lines[pathIndex] || '').trim()) {
      pathIndex += 1
    }

    const path = normalizeAttachmentPath(lines[pathIndex] || '')
    if (!path) continue

    attachments.push({
      name: attachmentName('', path),
      path,
    })
    removedLines.add(pathIndex)
  }

  for (let index = 0; index < lines.length - 2; index += 1) {
    const headerLine = lines[index] || ''
    const separatorLine = lines[index + 1] || ''
    if (!headerLine.includes('|') || !isTableSeparator(separatorLine)) continue

    const headers = splitTableRow(headerLine)
    const pathIndex = findHeaderIndex(headers, FILE_PATH_HEADERS)
    if (pathIndex < 0) continue
    const nameIndex = findHeaderIndex(headers, FILE_NAME_HEADERS)

    const tableAttachments: GeneratedAttachment[] = []
    let endIndex = index + 2
    for (; endIndex < lines.length; endIndex += 1) {
      const rowLine = lines[endIndex] || ''
      if (!rowLine.includes('|') || !rowLine.trim()) break
      const cells = splitTableRow(rowLine)
      const path = normalizeAttachmentPath(cells[pathIndex] || '')
      if (!path) continue
      tableAttachments.push({
        name: attachmentName(nameIndex >= 0 ? (cells[nameIndex] || '') : '', path),
        path,
      })
    }

    if (tableAttachments.length === 0) continue
    attachments.push(...tableAttachments)
    for (let lineIndex = index; lineIndex < endIndex; lineIndex += 1) {
      removedLines.add(lineIndex)
    }
    index = endIndex - 1
  }

  for (let index = 0; index < lines.length - 2; index += 1) {
    const headerLine = lines[index] || ''
    const separatorLine = lines[index + 1] || ''
    if (!headerLine.includes('|') || !isTableSeparator(separatorLine)) continue

    const rows: string[][] = []
    let endIndex = index + 2
    for (; endIndex < lines.length; endIndex += 1) {
      const rowLine = lines[endIndex] || ''
      if (!rowLine.includes('|') || !rowLine.trim()) break
      const cells = splitTableRow(rowLine)
      if (cells.length >= 2) rows.push(cells)
    }

    const nameRow = rows.find((cells) => matchesTableLabel(cells[0] || '', ['文件', ...FILE_NAME_HEADERS]))
    const pathRow = rows.find((cells) => matchesTableLabel(cells[0] || '', FILE_PATH_HEADERS))
    const path = normalizeAttachmentPath(pathRow?.[1] || '')
    if (!path) continue

    attachments.push({
      name: attachmentName(nameRow?.[1] || '', path),
      path,
    })
    index = endIndex - 1
  }

  const markdownLinkPattern = /\[([^\]]+)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g
  for (const match of content.matchAll(markdownLinkPattern)) {
    const path = normalizeAttachmentPath(match[2] || match[3] || '')
    if (!path) continue
    attachments.push({
      name: attachmentName(match[1] || '', path),
      path,
    })
  }

  const cleanedLines = lines.filter((_, index) => !removedLines.has(index))
  const cleanedContent = cleanedLines
    .join('\n')
    .replace(markdownLinkPattern, (full, label, angleTarget, plainTarget) => {
      return normalizeAttachmentPath(angleTarget || plainTarget || '') ? cleanMarkdownText(label || '') : full
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    attachments: dedupeAttachments(attachments),
    content: cleanedContent,
  }
}
