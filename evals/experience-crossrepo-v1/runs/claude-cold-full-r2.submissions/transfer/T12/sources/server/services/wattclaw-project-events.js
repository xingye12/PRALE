import { existsSync, watch } from 'fs'
import { readFile } from 'fs/promises'
import { basename, join } from 'path'

const PROJECT_CONFIG_FILE = 'config.json'
const PROJECT_TASKS_FILE = 'task-list.json'
const WATCHED_FILES = new Set([PROJECT_CONFIG_FILE, PROJECT_TASKS_FILE])

function validPathSegment(value) {
  return typeof value === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
}

function projectDirectory(root, tenantId, projectId) {
  if (!root) return null
  return tenantId
    ? join(root, tenantId, '.wattclaw-team', 'projects', projectId)
    : join(root, '.wattclaw-team', 'projects', projectId)
}

export function resolveWattClawProjectDirectory({ envConfig, tenantId, projectId }) {
  if (!validPathSegment(projectId)) return null
  if (tenantId && !validPathSegment(tenantId)) return null

  const candidates = [
    projectDirectory(envConfig.OPENCLAW_CONTAINER_DATA_DIR, tenantId, projectId),
    projectDirectory(envConfig.OPENCLAW_HOST_DATA_DIR, tenantId, projectId),
    projectDirectory(process.env.GATEWAY_CONFIG_DIR, null, projectId),
    projectDirectory('/home/wattman/.openclaw', null, projectId),
    projectDirectory(process.env.HOME ? join(process.env.HOME, '.openclaw') : '', null, projectId),
  ].filter(Boolean)

  return candidates.find(candidate => existsSync(candidate)) || null
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readJsonFile(filePath) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const raw = await readFile(filePath, 'utf-8')
      return { raw, value: JSON.parse(raw), missing: false }
    } catch (error) {
      if (error?.code === 'ENOENT') return { raw: null, value: null, missing: true }
      lastError = error
      await delay(40 * (attempt + 1))
    }
  }
  throw lastError
}

export function createWattClawProjectEventService({ publish, logger = console, debounceMs = 80 }) {
  const watchedProjects = new Map()
  const clientProjects = new Map()

  function closeProjectWatcher(key) {
    const entry = watchedProjects.get(key)
    if (!entry) return
    entry.watcher.close()
    for (const timer of entry.timers.values()) clearTimeout(timer)
    watchedProjects.delete(key)
  }

  async function publishFile(entry, fileName, targetClientIds = null, force = false) {
    const clientIds = targetClientIds || [...entry.clients]
    if (clientIds.length === 0) return
    const filePath = join(entry.projectDir, fileName)

    try {
      const result = await readJsonFile(filePath)
      if (!force && result.raw === entry.lastContents.get(fileName)) return
      entry.lastContents.set(fileName, result.raw)
      entry.revision += 1

      if (fileName === PROJECT_CONFIG_FILE) {
        const event = result.missing
          ? 'wattclaw.team.project.deleted'
          : 'wattclaw.team.project.updated'
        publish({
          clientIds,
          event,
          payload: {
            projectId: entry.projectId,
            tenantId: entry.tenantId,
            revision: entry.revision,
            project: result.value,
          },
        })
        return
      }

      if (!result.missing && !Array.isArray(result.value)) {
        throw new Error(`${PROJECT_TASKS_FILE} must contain an array`)
      }
      publish({
        clientIds,
        event: 'wattclaw.team.tasks.updated',
        payload: {
          projectId: entry.projectId,
          tenantId: entry.tenantId,
          revision: entry.revision,
          tasks: result.missing ? [] : result.value,
        },
      })
    } catch (error) {
      logger.error('[WattClawProjectEvents] Failed to publish project file change:', {
        projectId: entry.projectId,
        fileName,
        error: error?.message || String(error),
      })
    }
  }

  function scheduleFile(entry, fileName) {
    const current = entry.timers.get(fileName)
    if (current) clearTimeout(current)
    entry.timers.set(fileName, setTimeout(() => {
      entry.timers.delete(fileName)
      void publishFile(entry, fileName)
    }, debounceMs))
  }

  function createProjectWatcher({ key, projectId, tenantId, projectDir }) {
    const entry = {
      key,
      projectId,
      tenantId,
      projectDir,
      clients: new Set(),
      lastContents: new Map(),
      timers: new Map(),
      revision: 0,
      watcher: null,
    }
    entry.watcher = watch(projectDir, { persistent: false }, (_eventType, filename) => {
      if (!filename) {
        for (const fileName of WATCHED_FILES) scheduleFile(entry, fileName)
        return
      }
      const fileName = basename(filename.toString())
      if (WATCHED_FILES.has(fileName)) scheduleFile(entry, fileName)
    })
    entry.watcher.on('error', (error) => {
      logger.error('[WattClawProjectEvents] Project watcher failed:', {
        projectId,
        error: error?.message || String(error),
      })
    })
    watchedProjects.set(key, entry)
    return entry
  }

  function unsubscribe(clientId) {
    const key = clientProjects.get(clientId)
    if (!key) return
    clientProjects.delete(clientId)
    const entry = watchedProjects.get(key)
    if (!entry) return
    entry.clients.delete(clientId)
    if (entry.clients.size === 0) closeProjectWatcher(key)
  }

  function subscribe({ clientId, projectId, tenantId, projectDir }) {
    unsubscribe(clientId)
    const key = `${tenantId || 'single'}:${projectId}`
    const entry = watchedProjects.get(key)
      || createProjectWatcher({ key, projectId, tenantId, projectDir })
    entry.clients.add(clientId)
    clientProjects.set(clientId, key)
    void publishFile(entry, PROJECT_CONFIG_FILE, [clientId], true)
    void publishFile(entry, PROJECT_TASKS_FILE, [clientId], true)
  }

  function stop() {
    for (const key of watchedProjects.keys()) closeProjectWatcher(key)
    clientProjects.clear()
  }

  function getActiveProjectCount() {
    return watchedProjects.size
  }

  return {
    subscribe,
    unsubscribe,
    stop,
    getActiveProjectCount,
  }
}
