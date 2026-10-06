// File management routes (local filesystem)
import { authMiddleware } from '../core/auth.js'
import { getAllDigitalEmployees, getDigitalEmployees, getAgentWorkspaceForUser } from '../user-manager.js'
import { expandHomePath, safePath } from '../utils/index.js'
import { resolveGeneratedFileCandidatePath } from '../utils/generated-file-path.js'
import {
  generatedFileMimeType,
  isGeneratedFilePathAllowed,
  normalizeGeneratedFileRequestPath,
} from '../utils/generated-file-metadata.js'
import { gatewayExec } from '../core/system.js'
import multer from 'multer'
import { dirname, basename, extname, posix } from 'path'
import { existsSync, mkdirSync, unlinkSync, statSync, promises as fsPromises, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function resolveWorkspacePath(relPath, workspaceParam) {
  return relPath.startsWith('/') ? relPath : `${workspaceParam.replace(/\/+$/, '')}/${String(relPath).replace(/^\/+/, '')}`
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
})

const GENERATED_FILE_MAX_BYTES = 100 * 1024 * 1024
// The user-controlled generated-file path/attachment metadata rules live in the
// dependency-free ../utils/generated-file-metadata.js so they can be unit tested.

export function createFileRoutes(app) {
  app.get('/api/chat/generated-file', authMiddleware, async (req, res) => {
    const sessionKey = typeof req.query.sessionKey === 'string' ? req.query.sessionKey.trim() : ''
    const requestedPath = normalizeGeneratedFileRequestPath(req.query.path)
    const agentId = sessionKey.match(/^agent:([^:]+):/)?.[1] || ''
    const requestTraceId = typeof req.query.traceId === 'string' ? req.query.traceId.trim().slice(0, 100) : ''
    const traceId = requestTraceId || `generated-file-${randomUUID().slice(0, 8)}`

    console.info('[GeneratedFile] request', {
      traceId,
      userId: req.currentUser?.id,
      role: req.currentUser?.role,
      agentId,
      sessionKey,
      requestedPath,
    })

    if (!sessionKey || !agentId || !requestedPath || requestedPath.includes('\0')) {
      console.warn('[GeneratedFile] invalid request', { traceId, sessionKey, agentId, requestedPath })
      return res.status(400).json({ ok: false, error: { message: 'Invalid generated file request' } })
    }

    const workspaceInfo = getAgentWorkspaceForUser(
      req.currentUser.id,
      req.currentUser.role,
      agentId,
      traceId,
    )
    if (!workspaceInfo) {
      console.warn('[GeneratedFile] workspace lookup missed', { traceId, agentId })
      return res.status(404).json({ ok: false, error: { message: 'Workspace not found' } })
    }

    try {
      const workspacePath = expandHomePath(workspaceInfo.workspace)
      const workspaceReal = (await gatewayExec(`realpath -e -- ${shellQuote(workspacePath)}`)).trim().replace(/\\/g, '/')
      if (!workspaceReal) {
        console.warn('[GeneratedFile] workspace realpath empty', { traceId, workspacePath })
        return res.status(404).json({ ok: false, error: { message: 'Workspace not found' } })
      }
      const { candidatePath, pathMode } = resolveGeneratedFileCandidatePath(workspaceReal, requestedPath)

      console.info('[GeneratedFile] path resolved', {
        traceId,
        workspaceReal,
        requestedPath,
        candidatePath,
        pathMode,
      })

      let targetReal
      try {
        targetReal = (await gatewayExec(`realpath -e -- ${shellQuote(candidatePath)}`)).trim().replace(/\\/g, '/')
      } catch (error) {
        console.warn('[GeneratedFile] target not found', {
          traceId,
          candidatePath,
          error: error instanceof Error ? error.message : String(error),
        })
        return res.status(404).json({ ok: false, error: { message: 'File not found' } })
      }

      const relativePath = posix.relative(workspaceReal, targetReal)
      const escapedWorkspace = !relativePath || relativePath === '..' || relativePath.startsWith('../') || posix.isAbsolute(relativePath)
      if (escapedWorkspace || !isGeneratedFilePathAllowed(relativePath)) {
        console.warn('[GeneratedFile] access denied', { traceId, workspaceReal, targetReal, relativePath })
        return res.status(403).json({ ok: false, error: { message: 'File access denied' } })
      }

      const kind = (await gatewayExec(`if [ -f ${shellQuote(targetReal)} ]; then echo FILE; else echo OTHER; fi`)).trim()
      if (kind !== 'FILE') {
        console.warn('[GeneratedFile] target is not a regular file', { traceId, targetReal, kind })
        return res.status(400).json({ ok: false, error: { message: 'Only regular files can be downloaded' } })
      }

      const size = Number((await gatewayExec(`stat -c %s -- ${shellQuote(targetReal)}`)).trim())
      if (!Number.isFinite(size) || size < 0) {
        return res.status(500).json({ ok: false, error: { message: 'Could not determine file size' } })
      }
      if (size > GENERATED_FILE_MAX_BYTES) {
        console.warn('[GeneratedFile] target exceeds size limit', { traceId, targetReal, size })
        return res.status(413).json({ ok: false, error: { message: 'File is too large to download' } })
      }

      const content = (await gatewayExec(`base64 ${shellQuote(targetReal)} | tr -d '\n'`, 120000)).trim()
      console.info('[GeneratedFile] download ready', { traceId, targetReal, relativePath, size })
      res.json({
        ok: true,
        content,
        isBase64: true,
        file: {
          name: basename(targetReal),
          path: relativePath,
          size,
          mimeType: generatedFileMimeType(targetReal),
        },
      })
    } catch (err) {
      console.error('[GeneratedFile] unexpected error', { traceId, error: err })
      res.status(500).json({ ok: false, error: { message: err.message } })
    }
  })

  app.get('/api/files/batch-list', authMiddleware, async (req, res) => {
    try {
      const isAdmin = req.currentUser?.role === 'admin'
      const userId = req.currentUser?.id

      const userAgentRows = isAdmin
        ? getAllDigitalEmployees()
        : getDigitalEmployees(userId)

      if (userAgentRows.length === 0) {
        return res.json({ ok: true, agents: {} })
      }

      const agentWorkspaces = []
      for (const row of userAgentRows) {
        const workspace = typeof row.workspace === 'string' ? row.workspace.trim() : ''
        if (!workspace) continue
        agentWorkspaces.push({
          agentId: row.gateway_agent_id,
          workspace: expandHomePath(workspace),
          name: row.name || row.gateway_agent_id
        })
      }

      if (agentWorkspaces.length === 0) {
        return res.json({ ok: true, agents: {} })
      }

      const uniqueDirs = [...new Set(agentWorkspaces.map(a => a.workspace))]
      const findResults = {}
      await Promise.all(uniqueDirs.map(async (dir) => {
        try {
          const cmd = `find "${dir}" -not -path '*/.git/*' -not -path '*/.git' -not -path '*/node_modules/*' -not -path '*/node_modules' -printf '%y|%P|%s|%T@\\n' 2>/dev/null | sort`
          const output = await gatewayExec(cmd)
          const allFiles = output.trim().split('\n').filter(Boolean).map(line => {
            const [type, relPath, size, ts] = line.split('|')
            const name = relPath.includes('/') ? relPath.slice(relPath.lastIndexOf('/') + 1) : relPath
            return {
              name,
              path: relPath,
              type: type === 'd' ? 'directory' : 'file',
              isDirectory: type === 'd',
              size: parseInt(size) || 0,
              updatedAtMs: ts ? Math.round(parseFloat(ts) * 1000) : undefined,
            }
          }).filter(f => f.name && f.name !== '.' && f.name !== '..')

          const tree = []
          const dirMap = new Map()
          for (const file of allFiles) {
            const parentPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
            const parent = parentPath ? dirMap.get(parentPath) : null
            const node = { ...file, children: file.isDirectory ? [] : undefined }
            if (file.isDirectory) {
              dirMap.set(file.path, node)
            }
            if (parent) {
              parent.children.push(node)
            } else {
              tree.push(node)
            }
          }
          findResults[dir] = tree
        } catch {
          findResults[dir] = []
        }
      }))

      const result = {}
      for (const { agentId, workspace, name } of agentWorkspaces) {
        result[agentId] = { workspace, name, files: findResults[workspace] || [] }
      }
      res.json({ ok: true, agents: result })
    } catch (err) {
      console.error('[Files] batch-list error:', err)
      res.status(500).json({ ok: false, error: { message: err.message } })
    }
  })

  app.get('/api/files/list', authMiddleware, async (req, res) => {
    try {
      const relPath = req.query.path || ''
      const workspaceParam = req.query.workspace || '/home/wattman'
      const traceId = typeof req.query.traceId === 'string' ? req.query.traceId : ''
      const dirPath = relPath ? `${workspaceParam.replace(/\/+$/, '')}/${String(relPath).replace(/^\/+/, '')}` : workspaceParam
      const cmd = `find "${dirPath}" -mindepth 1 -maxdepth 1 -printf '%y|%f|%s|%T@\\n' 2>/dev/null | sort`
      console.info('[ChatFileIndex] list request', { traceId, workspaceParam, relPath, dirPath })
      const output = await gatewayExec(cmd)
      const lines = output.trim().split('\n').filter(Boolean)
      const files = lines.map(line => {
        const [type, name, size, ts] = line.split('|')
        return {
          name,
          path: relPath ? `${relPath}/${name}` : name,
          type: type === 'd' ? 'directory' : 'file',
          isDirectory: type === 'd',
          size: parseInt(size) || 0,
          updatedAtMs: ts ? Math.round(parseFloat(ts) * 1000) : undefined,
        }
      }).filter(f => f.name && f.name !== '.' && f.name !== '..')
      console.info('[ChatFileIndex] list response', { traceId, dirPath, count: files.length, sample: files.slice(0, 5) })
      res.json({ ok: true, files, path: relPath, workspaceRoot: workspaceParam })
    } catch (err) {
      console.error('[Files] List error:', err)
      res.status(500).json({ ok: false, error: { message: err.message } })
    }
  })

  app.get('/api/files/get', authMiddleware, async (req, res) => {
    try {
      let relPath = req.query.path || req.query.name || ''
      const workspaceParam = req.query.workspace || '/home/wattman'
      const binary = req.query.binary === 'true'

      if (!relPath && !binary) {
        return res.status(400).json({ ok: false, error: { message: 'Path is required' } })
      }

      try {
        let decoded = decodeURIComponent(relPath)
        if (decoded.includes('%')) decoded = decodeURIComponent(decoded)
        relPath = decoded
      } catch {}

      const filePath = relPath ? (relPath.startsWith('/') ? relPath : `${workspaceParam.replace(/\/+$/, '')}/${String(relPath).replace(/^\/+/, '')}`) : workspaceParam.replace(/\/+$/, '')
      console.log('[Files] Get request:', { workspaceParam, relPath, filePath, binary })

      const ext = extname(filePath).slice(1).toLowerCase()
      const binaryExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'mkv', 'avi']
      const lsCmd = `bash -lc 'if [ -d "${filePath}" ]; then echo DIR; else echo FILE; fi'`
      const kind = (await gatewayExec(lsCmd)).trim()

      if (kind === 'DIR') {
        if (binary) {
          const parentDir = dirname(filePath)
          const baseName = basename(filePath)
          const escapedParentDir = parentDir.replace(/'/g, `'\\''`)
          const escapedBaseName = baseName.replace(/'/g, `'\\''`)
          const cmd = `bash -lc 'set -o pipefail; cd '\''${escapedParentDir}'\'' && if [ -d '\''${escapedBaseName}'\'' ]; then tar -czf - '\''${escapedBaseName}'\'' | base64 | tr -d "\\n"; else exit 2; fi'`
          let content
          try {
            content = (await gatewayExec(cmd, 120000)).trim()
          } catch (err) {
            throw new Error(`Failed to generate directory archive: ${err.message}`)
          }
          if (!content) {
            throw new Error('Failed to generate directory archive: empty base64 output')
          }
          const tarBuffer = Buffer.from(content, 'base64')
          if (tarBuffer.length < 4 || tarBuffer[0] !== 0x1F || tarBuffer[1] !== 0x8B) {
            throw new Error('Failed to generate directory archive: invalid tar.gz signature')
          }
          console.log('[Files] Get directory archive response:', { filePath, contentLength: content.length, tarSize: tarBuffer.length })
          return res.json({ ok: true, content, isBase64: true, file: { name: `${baseName}.tar.gz`, path: relPath, type: 'directory', isDirectory: true, extension: 'tar.gz', mimeType: 'application/gzip' } })
        }
        return res.status(400).json({ ok: false, error: { message: 'Cannot read directory as text' } })
      }

      if (binary || binaryExts.includes(ext)) {
        const content = await gatewayExec(`base64 "${filePath}" | tr -d '\n'`)
        console.log('[Files] Get binary response:', { filePath, contentLength: content.length, ext })
        return res.json({ ok: true, content, isBase64: true, file: { name: basename(filePath), path: relPath, type: 'file', isDirectory: false, extension: ext, mimeType: 'application/octet-stream' } })
      }

      const content = await gatewayExec(`cat "${filePath}"`)
      console.log('[Files] Get text response:', { filePath, contentLength: content.length })
      res.json({ ok: true, content, file: { name: basename(filePath), path: relPath, type: 'file', isDirectory: false } })
    } catch (err) {
      console.error('[Files] Get error:', err)
      res.status(500).json({ ok: false, error: { message: err.message } })
    }
  })

  app.post('/api/files/set', authMiddleware, async (req, res) => {
    try {
      const { path: relPath, name, content, workspace: workspaceParam } = req.body
      const filePath = relPath || name

      if (!filePath) {
        return res.status(400).json({ ok: false, error: { message: 'Path is required' } })
      }

      if (!workspaceParam) {
        return res.status(400).json({ ok: false, error: { message: 'Workspace parameter is required' } })
      }

      const workspaceBase = expandHomePath(workspaceParam)
      const absPath = safePath(filePath, workspaceBase)

      console.log('[Files] Set:', { filePath, workspaceParam, absPath })

      if (!absPath) {
        return res.status(400).json({ ok: false, error: { message: 'Invalid path' } })
      }

      const parentDir = dirname(absPath)
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true })
      }

      if (content === null || content === undefined) {
        if (existsSync(absPath)) {
          unlinkSync(absPath)
        }
        res.json({ ok: true, deleted: true })
      } else {
        writeFileSync(absPath, content, 'utf-8')
        const stats = statSync(absPath)
        res.json({
          ok: true,
          file: {
            name: basename(absPath),
            path: filePath,
            size: stats.size,
            updatedAtMs: stats.mtimeMs,
          }
        })
      }
    } catch (err) {
      console.error('[Files] Set error:', err)
      res.status(500).json({ ok: false, error: { message: err.message } })
    }
  })

  app.post('/api/files/mkdir', authMiddleware, async (req, res) => {
    try {
      const { path: relPath, name, workspace: workspaceParam } = req.body
      const dirPath = relPath || name

      if (!dirPath) {
        return res.status(400).json({ ok: false, error: { message: 'Path is required' } })
      }

      if (!workspaceParam) {
        return res.status(400).json({ ok: false, error: { message: 'Workspace parameter is required' } })
      }

      const workspaceBase = expandHomePath(workspaceParam)
      const absPath = safePath(dirPath, workspaceBase)

      console.log('[Files] Mkdir:', { dirPath, workspaceParam, absPath })

      if (!absPath) {
        return res.status(400).json({ ok: false, error: { message: 'Invalid path' } })
      }

      if (existsSync(absPath)) {
        return res.status(400).json({ ok: false, error: { message: 'Already exists' } })
      }

      mkdirSync(absPath, { recursive: true })

      res.json({
        ok: true,
        directory: {
          name: basename(absPath),
          path: dirPath,
        }
      })
    } catch (err) {
      console.error('[Files] Mkdir error:', err)
      res.status(500).json({ ok: false, error: { message: err.message } })
    }
  })

  app.post('/api/files/delete', authMiddleware, async (req, res) => {
    try {
      const { path: relPath, name, workspace: workspaceParam } = req.body
      const filePath = relPath || name

      if (!filePath) {
        return res.status(400).json({ ok: false, error: { message: 'Path is required' } })
      }

      if (!workspaceParam) {
        return res.status(400).json({ ok: false, error: { message: 'Workspace parameter is required' } })
      }

      const targetPath = filePath.startsWith('/') ? filePath : `${workspaceParam.replace(/\/+$/, '')}/${String(filePath).replace(/^\/+/, '')}`

      console.log('[Files] Delete:', { filePath, workspaceParam, targetPath })

      const bashPath = targetPath.replace(/'/g, `'\\''`)
      const cmd = `bash -lc 'if [ -e '\''${bashPath}'\'' ]; then rm -rf '\''${bashPath}'\''; echo OK; else echo NOT_FOUND; exit 2; fi'`
      const output = await gatewayExec(cmd)
      if (String(output).includes('NOT_FOUND')) {
        return res.status(404).json({ ok: false, error: { message: 'Not found' } })
      }

      res.json({ ok: true, deleted: true })
    } catch (err) {
      console.error('[Files] Delete error:', err)
      res.status(500).json({ ok: false, error: { message: err.message } })
    }
  })

  app.post('/api/files/rename', authMiddleware, async (req, res) => {
    try {
      const { oldPath, newPath, workspace: workspaceParam } = req.body

      if (!oldPath || !newPath) {
        return res.status(400).json({ ok: false, error: { message: 'Old path and new path are required' } })
      }

      if (!workspaceParam) {
        return res.status(400).json({ ok: false, error: { message: 'Workspace parameter is required' } })
      }

      const targetOld = oldPath.startsWith('/') ? oldPath : `${workspaceParam.replace(/\/+$/, '')}/${String(oldPath).replace(/^\/+/, '')}`
      const targetNew = newPath.startsWith('/') ? newPath : `${workspaceParam.replace(/\/+$/, '')}/${String(newPath).replace(/^\/+/, '')}`

      console.log('[Files] Rename:', { oldPath, newPath, targetOld, targetNew })

      const bashOld = targetOld.replace(/'/g, `'\\''`)
      const bashNew = targetNew.replace(/'/g, `'\\''`)

      const cmd = `bash -lc 'if [ ! -e '\''${bashOld}'\'' ]; then echo NOT_FOUND; exit 2; fi; if [ -e '\''${bashNew}'\'' ]; then echo TARGET_EXISTS; exit 2; fi; mv '\''${bashOld}'\'' '\''${bashNew}'\''; echo OK'`
      const output = await gatewayExec(cmd)

      if (String(output).includes('NOT_FOUND')) {
        return res.status(404).json({ ok: false, error: { message: 'Source not found' } })
      }
      if (String(output).includes('TARGET_EXISTS')) {
        return res.status(400).json({ ok: false, error: { message: 'Target already exists' } })
      }

      res.json({
        ok: true,
        renamed: true,
        oldPath,
        newPath
      })
    } catch (err) {
      console.error('[Files] Rename error:', err)
      res.status(500).json({ ok: false, error: { message: err.message } })
    }
  })

  app.post('/api/files/batch-delete', authMiddleware, async (req, res) => {
    try {
      const { items } = req.body
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ ok: false, error: { message: 'items array is required' } })
      }

      const results = []
      for (const item of items) {
        const relPath = item.path
        const workspaceParam = item.workspace
        if (!relPath || !workspaceParam) {
          results.push({ path: relPath, ok: false, error: 'Missing path or workspace' })
          continue
        }
        try {
          const targetPath = relPath.startsWith('/') ? relPath : `${workspaceParam.replace(/\/+$/, '')}/${String(relPath).replace(/^\/+/, '')}`
          const bashPath = targetPath.replace(/'/g, `'\\''`)
          const cmd = `bash -lc 'if [ -e '\''${bashPath}'\'' ]; then rm -rf '\''${bashPath}'\''; echo OK; else echo NOT_FOUND; fi'`
          const output = await gatewayExec(cmd)
          const trimmed = (output || '').trim()
          if (trimmed === 'OK' || trimmed === 'NOT_FOUND') {
            results.push({ path: relPath, ok: true })
          } else {
            results.push({ path: relPath, ok: false, error: trimmed })
          }
        } catch (err) {
          results.push({ path: relPath, ok: false, error: err.message })
        }
      }
      const allOk = results.every(r => r.ok)
      res.json({ ok: allOk, results })
    } catch (err) {
      console.error('[Files] batch-delete error:', err)
      res.status(500).json({ ok: false, error: { message: err.message } })
    }
  })

  app.post('/api/files/batch-download', authMiddleware, async (req, res) => {
    try {
      const { items } = req.body
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ ok: false, error: { message: 'items array is required' } })
      }

      const grouped = new Map()
      for (const item of items) {
        const relPath = String(item?.path || '').replace(/^\/+/, '')
        const workspaceParam = String(item?.workspace || '').replace(/\/+$/, '')
        if (!relPath || !workspaceParam) continue
        if (!grouped.has(workspaceParam)) grouped.set(workspaceParam, [])
        grouped.get(workspaceParam).push(relPath)
      }

      if (grouped.size === 0) {
        return res.status(400).json({ ok: false, error: { message: 'No valid files selected' } })
      }

      const tempName = `wattclaw-batch-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const tempRoot = `/tmp/${tempName}`
      const quotedTempRoot = shellQuote(tempRoot)
      const commands = [`rm -rf ${quotedTempRoot}`, `mkdir -p ${quotedTempRoot}`]

      let groupIndex = 0
      for (const [workspaceParam, paths] of grouped.entries()) {
        const groupDir = grouped.size === 1 ? tempRoot : `${tempRoot}/workspace-${groupIndex + 1}`
        commands.push(`mkdir -p ${shellQuote(groupDir)}`)
        for (const relPath of paths) {
          const sourcePath = resolveWorkspacePath(relPath, workspaceParam)
          const targetPath = `${groupDir}/${relPath}`
          commands.push(`if [ -e ${shellQuote(sourcePath)} ]; then mkdir -p ${shellQuote(dirname(targetPath))} && cp -a ${shellQuote(sourcePath)} ${shellQuote(targetPath)}; fi`)
        }
        groupIndex += 1
      }

      commands.push(`tar -czf - -C ${quotedTempRoot} . | base64 | tr -d '\\n'`)
      commands.push(`rm -rf ${quotedTempRoot}`)

      const content = (await gatewayExec(`bash -lc ${shellQuote(commands.join('; '))}`, 120000)).trim()
      if (!content) {
        return res.status(404).json({ ok: false, error: { message: 'No selected files found' } })
      }

      const archiveBuffer = Buffer.from(content, 'base64')
      if (archiveBuffer.length < 4 || archiveBuffer[0] !== 0x1F || archiveBuffer[1] !== 0x8B) {
        return res.status(500).json({ ok: false, error: { message: 'Invalid archive generated' } })
      }

      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Disposition', 'attachment; filename="files.tar.gz"')
      res.send(archiveBuffer)
    } catch (err) {
      console.error('[Files] batch-download error:', err)
      res.status(500).json({ ok: false, error: { message: err.message } })
    }
  })

  app.post('/api/files/upload', authMiddleware, upload.single('file'), async (req, res) => {
    try {
      const file = req.file
      const relPath = req.body.path
      const workspaceParam = req.body.workspace

      if (!file) {
        return res.status(400).json({ ok: false, error: { message: 'No file uploaded' } })
      }

      if (!relPath) {
        return res.status(400).json({ ok: false, error: { message: 'Path is required' } })
      }

      if (!workspaceParam) {
        return res.status(400).json({ ok: false, error: { message: 'Workspace parameter is required' } })
      }

      const workspaceBase = expandHomePath(workspaceParam)
      const absPath = safePath(relPath, workspaceBase)

      console.log('[Files] Upload:', { relPath, workspaceParam, absPath, size: file.size })

      if (!absPath) {
        return res.status(400).json({ ok: false, error: { message: 'Invalid path' } })
      }

      const parentDir = dirname(absPath)
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true })
      }

      await fsPromises.writeFile(absPath, file.buffer)

      const stats = statSync(absPath)
      res.json({
        ok: true,
        file: {
          name: basename(absPath),
          path: relPath,
          size: stats.size,
          updatedAtMs: stats.mtimeMs,
        }
      })
    } catch (err) {
      console.error('[Files] Upload error:', err)
      res.status(500).json({ ok: false, error: { message: err.message } })
    }
  })
}
