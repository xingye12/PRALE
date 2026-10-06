/**
 * File transfer module for WattClaw — local filesystem mode only.
 * All file operations are performed directly on the mounted filesystem.
 */

import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { extname } from 'path'

/**
 * Sanitize a filename: remove unsafe chars, keep Chinese/letters/numbers/
 * dots/hyphens/underscores, collapse consecutive underscores, trim to 60 chars.
 * Matches Gateway's sanitizeFilename logic.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  const trimmed = name.trim()
  if (!trimmed) return ''
  return trimmed
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60)
}

/**
 * Build the remote file name in Gateway's naming convention:
 *   {sanitized-name}---{uuid}.{ext}
 *
 * @param {string} originalName
 * @returns {{ fileName: string, baseName: string, ext: string }}
 */
export function buildRemoteFileName(originalName) {
  const ext = extname(originalName).toLowerCase() // includes leading dot, e.g. ".pdf"
  const nameWithoutExt = originalName.slice(0, originalName.length - ext.length)
  const sanitized = sanitizeFilename(nameWithoutExt) || 'file'
  const uuid = randomUUID().replace(/-/g, '').slice(0, 8)
  const fileName = `${sanitized}---${uuid}${ext}`
  return { fileName, baseName: sanitized, ext }
}

/**
 * Upload a file buffer to the media directory.
 *
 * @param {Buffer} buffer - File content
 * @param {string} fileName - Original file name
 * @param {object} envConfig - Environment config
 * @param {string} [targetDir] - Override target directory
 * @returns {Promise<{ path: string, fileName: string, originalName: string, size: number }>}
 */
export async function uploadToGateway(buffer, fileName, envConfig, targetDir) {
  const configDir = process.env.GATEWAY_CONFIG_DIR || envConfig.GATEWAY_CONFIG_DIR || '/home/wattman/.openclaw'
  const { GATEWAY_MEDIA_DIR = `${configDir}/media/inbound` } = envConfig
  const uploadDir = targetDir || GATEWAY_MEDIA_DIR
  const { fileName: remoteFileName } = buildRemoteFileName(fileName)
  const remotePath = `${uploadDir}/${remoteFileName}`
  await fs.mkdir(uploadDir, { recursive: true })
  await fs.writeFile(remotePath, buffer)
  return { path: remotePath, fileName: remoteFileName, originalName: fileName, size: buffer.length }
}

/**
 * Delete a file.
 *
 * @param {string} remotePath - Absolute path of the file to delete
 * @returns {Promise<boolean>} true if deleted or didn't exist
 */
export async function deleteRemoteFile(remotePath) {
  try {
    await fs.unlink(remotePath)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return true
    return false
  }
}

/**
 * Write content to a file.
 *
 * @param {string} remotePath - Absolute path of the file to write
 * @param {string} content - File content (utf8)
 * @returns {Promise<boolean>} true if written
 */
export async function writeRemoteFile(remotePath, content) {
  try {
    const dir = path.dirname(remotePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(remotePath, content, 'utf-8')
    return true
  } catch {
    return false
  }
}
