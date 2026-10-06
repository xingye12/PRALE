import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useWebSocketStore } from '@/stores/websocket'
import { useWorkspaceStore } from '@/stores/workspace'
import { apiPath } from '@/utils/api-path'
import { extractSessionKey } from '@/utils/event-helpers'
import type {
  ChatMessage,
  WattClawMemberSession,
  WattClawProject,
  WattClawProjectMemberModel,
  WattClawProjectTask,
  Session,
  WattClawTeamCreationMode,
} from '@/api/types'

const STORAGE_KEY = 'wattclaw:wattclaw-collaboration:projectId'
const STORAGE_KEY_LIST = 'wattclaw:wattclaw-collaboration:projectIds'
const MODEL_STORAGE_KEY = 'wattclaw:wattclaw-collaboration:model'
export const DEFAULT_WATTCLAW_COLLABORATION_MODEL = 'deepseek/deepseek-v4-pro'

function initialProjectIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LIST)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter((id: unknown) => typeof id === 'string')
    }
    const legacyId = localStorage.getItem(STORAGE_KEY)
    if (legacyId) {
      const list = [legacyId]
      localStorage.setItem(STORAGE_KEY_LIST, JSON.stringify(list))
      localStorage.removeItem(STORAGE_KEY)
      return list
    }
  } catch {
    return []
  }
  return []
}

function initialProjectId(): string | null {
  const ids = initialProjectIds()
  return ids.length > 0 ? (ids[ids.length - 1] ?? null) : null
}

function initialModel(): string {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY)?.trim()
      || DEFAULT_WATTCLAW_COLLABORATION_MODEL
  } catch {
    return DEFAULT_WATTCLAW_COLLABORATION_MODEL
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return undefined
}

function asMessageCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
  }
  return undefined
}

function resolveMessageCount(row: Record<string, unknown>, session: Record<string, unknown>): number | undefined {
  const usage = asRecord(row.usage) || asRecord(session.usage) || {}
  const messageCounts = asRecord(usage.messageCounts) || asRecord(usage.message_counts) || {}
  const candidates = [
    session.messageCount,
    session.message_count,
    row.messageCount,
    row.message_count,
    messageCounts.total,
    messageCounts.count,
    usage.messageCount,
    usage.message_count,
  ]
  for (const candidate of candidates) {
    const count = asMessageCount(candidate)
    if (count !== undefined) return count
  }
  return undefined
}

export const useWattClawCollaborationStore = defineStore('wattclaw-collaboration', () => {
  const projectId = ref<string | null>(initialProjectId())
  const savedProjectIds = ref<string[]>(initialProjectIds())
  const savedProjectsMeta = shallowRef<(WattClawProject & { id: string })[]>([])
  const project = shallowRef<WattClawProject | null>(null)
  const tasks = ref<WattClawProjectTask[]>([])
  const memberSessions = ref<WattClawMemberSession[]>([])
  const selectedModel = ref(initialModel())
  const teamCreationMode = ref<WattClawTeamCreationMode>('template')
  const captureTeamTemplate = ref(true)
  const loading = ref(false)
  const restoring = ref(false)
  const runtimeReady = ref(false)
  const creating = ref(false)
  const starting = ref(false)
  const retrying = ref(false)
  const archiving = ref(false)
  const updatingMemberIds = ref<string[]>([])
  const error = ref<string | null>(null)
  const pendingMessages = ref<ChatMessage[]>([])
  let diagnosticsRequestId = 0
  let savedProjectsMetaRequestId = 0
  let diagnosticsInFlight: { targetProjectId: string; promise: Promise<void> } | null = null
  const syncedMemberModels = new Set<string>()
  const memberModelSyncs = new Map<string, Promise<void>>()
  const seenMessageActivityIds = new Set<string>()
  const archivedProjectIds = new Set<string>()

  const managerAgentId = computed(() =>
    project.value?.members.find((member) => member.isLead)?.agentId || null
  )
  const hasProject = computed(() => Boolean(projectId.value && project.value))
  const projectSessionKeys = computed<Set<string>>(() => {
    const projects = project.value
      ? [...savedProjectsMeta.value, project.value]
      : savedProjectsMeta.value
    return new Set(projects.flatMap((item) =>
      item.members.map((member) => `agent:${member.agentId}:main`)
    ))
  })

  function persistProjectIds(ids: string[]) {
    savedProjectIds.value = ids
    try {
      localStorage.setItem(STORAGE_KEY_LIST, JSON.stringify(ids))
    } catch {
      return
    }
  }

  function persistProjectId(id: string | null) {
    projectId.value = id
    try {
      if (id) {
        if (!savedProjectIds.value.includes(id)) {
          persistProjectIds([...savedProjectIds.value, id])
        }
      }
    } catch {
      return
    }
  }

  function clearProjectData() {
    diagnosticsRequestId += 1
    project.value = null
    tasks.value = []
    memberSessions.value = []
    seenMessageActivityIds.clear()
    pendingMessages.value = []
    error.value = null
    loading.value = false
    restoring.value = false
    runtimeReady.value = false
  }

  function updateSavedProjectMeta(currentProject: WattClawProject) {
    const index = savedProjectsMeta.value.findIndex((item) => item.id === currentProject.id)
    if (index < 0) {
      savedProjectsMeta.value = [...savedProjectsMeta.value, { ...currentProject, id: currentProject.id }]
      return
    }

    const next = [...savedProjectsMeta.value]
    next[index] = { ...currentProject, id: currentProject.id }
    savedProjectsMeta.value = next
  }

  function reconcileMemberSessions(members: WattClawProject['members']) {
    const current = new Map(memberSessions.value.map((session) => [session.agentId, session]))
    memberSessions.value = members.map((member) => current.get(member.agentId) || {
      agentId: member.agentId,
      sessionKey: `agent:${member.agentId}:main`,
      available: false,
      messageCount: 0,
      isStreaming: false,
    })
  }

  async function applyMemberSessionEvent(event: string, payload: unknown) {
    if (!project.value) return
    const sessionKey = extractSessionKey(payload)
    if (!sessionKey) return
    const member = project.value.members.find((item) =>
      item.agentId === sessionKey.match(/^agent:([^:]+):/)?.[1]
    )
    if (!member) return

    const normalizedEvent = event.trim().toLowerCase()
    const row = asRecord(payload) || {}
    const data = asRecord(row.data) || {}
    const session = asRecord(row.session) || {}
    const stream = typeof row.stream === 'string'
      ? row.stream.trim().toLowerCase()
      : typeof data.stream === 'string'
        ? data.stream.trim().toLowerCase()
        : ''
    const phaseValue = data.phase || data.state || data.status || row.phase || row.state || row.status
    const phase = typeof phaseValue === 'string' ? phaseValue.trim().toLowerCase() : ''
    const actionValue = row.action || row.change || row.type
    const action = typeof actionValue === 'string' ? actionValue.trim().toLowerCase() : ''
    const isRemoved = normalizedEvent === 'sessions.deleted'
      || normalizedEvent === 'session.deleted'
      || action.includes('delete')
      || action.includes('remove')
    const isFinished = normalizedEvent === 'agent.done'
      || normalizedEvent === 'chat.done'
      || normalizedEvent === 'chat.final'
      || normalizedEvent.includes('error')
      || (stream === 'lifecycle' && ['end', 'result', 'stop', 'completed', 'error', 'aborted', 'cancelled'].includes(phase))
    const isRunning = normalizedEvent === 'agent.started'
      || normalizedEvent === 'chat.delta'
      || (normalizedEvent === 'agent' && (
        (stream === 'lifecycle' && phase === 'start')
        || ['thinking', 'tool', 'item', 'command_output', 'assistant', 'compaction'].includes(stream)
      ))
    const messageCount = resolveMessageCount(row, session)
    const lastActivity = asTimestamp(
      session.lastActivity
      ?? row.lastActivity
      ?? row.timestamp
      ?? data.timestamp
    ) || new Date().toISOString()

    const index = memberSessions.value.findIndex((item) => item.agentId === member.agentId)
    const current: WattClawMemberSession = memberSessions.value[index] || {
      agentId: member.agentId,
      sessionKey,
      available: false,
      messageCount: 0,
      isStreaming: false,
    }

    const next: WattClawMemberSession = {
      ...current,
      sessionKey,
      available: !isRemoved,
      messageCount: messageCount === undefined
        ? current.messageCount
        : Math.max(current.messageCount, messageCount),
      lastActivity,
      isStreaming: isRemoved || isFinished ? false : isRunning ? true : current.isStreaming,
    }
    if (index >= 0) {
      memberSessions.value = memberSessions.value.map((item, itemIndex) =>
        itemIndex === index ? next : item
      )
    } else {
      memberSessions.value = [...memberSessions.value, next]
    }
  }

  function applyMemberMessageActivity(payload: unknown) {
    if (!project.value) return
    const row = asRecord(payload) || {}
    const sessionKey = extractSessionKey(payload)
    if (!sessionKey) return
    const agentId = sessionKey.match(/^agent:([^:]+):/)?.[1]
    const member = project.value.members.find((item) => item.agentId === agentId)
    if (!member) return

    const activityId = row.messageId ?? row.message_id ?? row.messageSeq ?? row.message_seq ?? row.seq
    if (activityId !== undefined && activityId !== null) {
      const dedupeKey = `${sessionKey}:${String(activityId)}`
      if (seenMessageActivityIds.has(dedupeKey)) return
      seenMessageActivityIds.add(dedupeKey)
      if (seenMessageActivityIds.size > 2048) {
        const oldest = seenMessageActivityIds.values().next().value
        if (typeof oldest === 'string') seenMessageActivityIds.delete(oldest)
      }
    }

    const index = memberSessions.value.findIndex((item) => item.agentId === member.agentId)
    const current: WattClawMemberSession = memberSessions.value[index] || {
      agentId: member.agentId,
      sessionKey,
      available: false,
      messageCount: 0,
      isStreaming: false,
    }
    const absoluteCount = resolveMessageCount(row, {})
    const delta = asMessageCount(row.messageDelta) ?? 1
    const next: WattClawMemberSession = {
      ...current,
      sessionKey,
      available: true,
      messageCount: absoluteCount === undefined
        ? current.messageCount + delta
        : Math.max(current.messageCount, absoluteCount),
      lastActivity: asTimestamp(row.timestamp) || new Date().toISOString(),
    }
    if (index >= 0) {
      memberSessions.value = memberSessions.value.map((item, itemIndex) =>
        itemIndex === index ? next : item
      )
    } else {
      memberSessions.value = [...memberSessions.value, next]
    }
  }

  function handleRealtimeEvent(event: string, payload: unknown) {
    const normalizedEvent = event.trim().toLowerCase()
    const row = asRecord(payload)
    const targetProjectId = typeof row?.projectId === 'string' ? row.projectId : ''

    if (normalizedEvent === 'wattclaw.team.project.updated') {
      if (!targetProjectId || targetProjectId !== projectId.value) return
      const nextProject = asRecord(row?.project)
      if (!nextProject || nextProject.id !== targetProjectId || !Array.isArray(nextProject.members)) return
      const nextStatus = String(nextProject.status || '').trim().toLowerCase()
      if (archivedProjectIds.has(targetProjectId) && nextStatus !== 'archived') return
      if (nextStatus === 'archived') archivedProjectIds.add(targetProjectId)
      const currentProject = {
        ...(project.value || {}),
        ...nextProject,
      } as WattClawProject
      project.value = currentProject
      updateSavedProjectMeta(currentProject)
      reconcileMemberSessions(currentProject.members)
      return
    }

    if (normalizedEvent === 'wattclaw.team.tasks.updated') {
      if (!targetProjectId || targetProjectId !== projectId.value || !Array.isArray(row?.tasks)) return
      tasks.value = row.tasks as WattClawProjectTask[]
      return
    }

    if (normalizedEvent === 'wattclaw.team.project.deleted') {
      if (!targetProjectId || targetProjectId !== projectId.value) return
      removeSavedProject(targetProjectId)
      const nextProjectId = projectId.value
      clearProjectData()
      if (nextProjectId) void initialize(nextProjectId)
      return
    }

    if (normalizedEvent === 'session.message.activity') {
      applyMemberMessageActivity(payload)
      return
    }

    void applyMemberSessionEvent(normalizedEvent, payload)
  }

  function projectMemberModelRef(member: WattClawProject['members'][number]): string | undefined {
    const configured = member.models?.[0]
    if (!configured) return undefined
    const source = configured.modelSource?.trim()
    const name = configured.modelName?.trim()
    if (!source || !name || source === 'custom') return ''
    return `${source}/${name}`
  }

  async function syncMemberModel(agentId: string, model: string, force = false): Promise<void> {
    model = model.trim()
    if (!agentId || !model) return
    const syncKey = `${agentId}:${model}`
    if (!force && syncedMemberModels.has(syncKey)) return
    const existing = memberModelSyncs.get(syncKey)
    if (existing) return existing

    const wsStore = useWebSocketStore()
    const request = wsStore.rpc.updateAgent({ agentId, model })
      .then(() => {
        syncedMemberModels.add(syncKey)
      })
      .catch((err) => {
        console.error('[WattClawCollaborationStore] model sync failed:', err)
      })
      .finally(() => {
        memberModelSyncs.delete(syncKey)
      })
    memberModelSyncs.set(syncKey, request)
    return request
  }

  async function syncProjectMemberModels(
    members: WattClawProject['members'],
    force = false,
  ): Promise<void> {
    await Promise.all(members.map((member) => {
      const configuredModel = projectMemberModelRef(member)
      const model = configuredModel === undefined ? selectedModel.value : configuredModel
      return syncMemberModel(member.agentId, model, force)
    }))
  }

  async function selectModel(model: string): Promise<void> {
    if (project.value && (!runtimeReady.value || restoring.value)) return
    const nextModel = model.trim() || DEFAULT_WATTCLAW_COLLABORATION_MODEL
    selectedModel.value = nextModel
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, nextModel)
    } catch {}

    const workspaceStore = useWorkspaceStore()
    workspaceStore.previewModelChange(nextModel)
    if (project.value) await syncProjectMemberModels(project.value.members, true)
  }

  function setTeamCreationMode(mode: WattClawTeamCreationMode): void {
    teamCreationMode.value = mode === 'manager' ? 'manager' : 'template'
  }

  function toggleTeamCreationMode(): void {
    setTeamCreationMode(teamCreationMode.value === 'template' ? 'manager' : 'template')
  }

  function setCaptureTeamTemplate(enabled: boolean): void {
    captureTeamTemplate.value = enabled
  }

  function toggleCaptureTeamTemplate(): void {
    setCaptureTeamTemplate(!captureTeamTemplate.value)
  }

  async function bindManagerSession(currentProject: WattClawProject, options: { fast?: boolean } = {}) {
    const manager = currentProject.members.find((member) => member.isLead)
    const managerId = manager?.agentId
    if (!manager || !managerId) throw new Error('WattClaw project manager is missing')

    const wsStore = useWebSocketStore()
    const workspaceStore = useWorkspaceStore()
    if (!options.fast) await workspaceStore.loadAgents()

    // Seed the manager into the workspace directly from project member data.
    // The project payload already resolves to the owning tenant, whereas
    // rpc.listAgents() only sees the CURRENT request tenant — so for admin
    // opening a cross-tenant project the manager would never appear there.
    if (!workspaceStore.agents.some((agent) => agent.agentId === managerId)) {
      workspaceStore.ensureGatewayAgent({ id: managerId, name: manager.name })
    }

    const sessionKey = `agent:${managerId}:main`
    if (options.fast) {
      workspaceStore.activateAgentSession(managerId, sessionKey)
      workspaceStore.previewModelChange(selectedModel.value)
      void workspaceStore.selectSession(sessionKey)
      return
    }

    // Best-effort enrichment from the gateway (identity/avatar/model). Single
    // non-blocking attempt: listAgents only sees the CURRENT request tenant, so
    // for admin cross-tenant projects it won't contain the manager — we must not
    // block on it. The seeded agent above already makes selection work.
    try {
      const gatewayAgents = await wsStore.rpc.listAgents()
      const gatewayManager = gatewayAgents.agents.find((agent) => agent.id === managerId)
      if (gatewayManager) workspaceStore.ensureGatewayAgent(gatewayManager)
    } catch {
      // ignore — enrichment only, seeded agent keeps the flow working
    }

    await workspaceStore.selectAgent(managerId)
    await workspaceStore.selectSession(sessionKey)
    workspaceStore.previewModelChange(selectedModel.value)
  }

  async function createDraft(prompt: string): Promise<WattClawProject> {
    if (project.value && projectId.value) return project.value

    creating.value = true
    error.value = null
    try {
      const wsStore = useWebSocketStore()
      const created = await wsStore.rpc.createWattClawProject({
        description: prompt.trim(),
        locale: document.documentElement.lang || navigator.language || 'zh-CN',
        teamCreationMode: teamCreationMode.value,
        captureTeamTemplate: captureTeamTemplate.value,
      })
      project.value = created
      persistProjectId(created.id)
      updateSavedProjectMeta(created)
      runtimeReady.value = true
      void syncProjectMemberModels(created.members)
      await bindManagerSession(created, { fast: true })
      void refreshDiagnostics()
      return created
    } catch (err) {
      error.value = errorMessage(err)
      throw err
    } finally {
      creating.value = false
    }
  }

  async function prepareOutgoingMessage(prompt: string, message: string): Promise<{
    message: string
    displayMessage: string
  }> {
    if (restoring.value || (project.value && !runtimeReady.value)) {
      const status = String(project.value?.status || '').trim().toLowerCase()
      if (!restoring.value && status === 'archived') {
        throw new Error('项目已归档，请先点击「恢复项目」后再与 Agent 交互')
      }
      throw new Error('协作项目正在恢复，暂时不能与 Agent 交互')
    }
    const currentProject = project.value || await createDraft(prompt)
    if (managerAgentId.value) {
      const workspaceStore = useWorkspaceStore()
      if (workspaceStore.selectedAgentId !== managerAgentId.value) {
        await bindManagerSession(currentProject, { fast: true })
      }
    }

    const draftSuggestion = asRecord(currentProject.draftSuggestion)
    const collaborationSettings = asRecord(draftSuggestion?.collaborationSettings)
    const effectiveTeamCreationMode = collaborationSettings?.teamCreationMode === 'manager'
      ? 'manager'
      : 'template'
    const shouldUseTemplate = effectiveTeamCreationMode === 'template'
    const shouldCaptureTeamTemplate = collaborationSettings?.captureTeamTemplate !== false
    const templateMatch = shouldUseTemplate ? asRecord(draftSuggestion?.templateMatch) : null
    const selectedTemplate = asRecord(templateMatch?.selectedTemplate)
    const profileMatches = Array.isArray(templateMatch?.profileMatches)
      ? templateMatch.profileMatches
      : []
    const templateContext = [
      `team_creation_mode: ${effectiveTeamCreationMode}`,
      `capture_team_template: ${shouldCaptureTeamTemplate ? 'enabled' : 'disabled'}`,
      ...(shouldUseTemplate && templateMatch
        ? [
          'The server has already matched this draft against the versioned team-template registry.',
          `template_match_decision: ${String(templateMatch?.decision || 'fresh_plan')}`,
          selectedTemplate
            ? `selected_team_template: ${JSON.stringify(selectedTemplate)}`
            : 'selected_team_template: none; plan a new team from the normalized intent.',
          profileMatches.length > 0
            ? `reusable_agent_profiles: ${JSON.stringify(profileMatches)}`
            : 'reusable_agent_profiles: none',
        ]
        : shouldUseTemplate
          ? [
            'Template reference mode is enabled, but no persisted template match is available. Plan a new team from the task.',
          ]
        : [
          'Template reference mode is disabled for this project. Plan and create the team autonomously from the task. Do not run prepare_data.py, find-skills.py, or ls/find commands to locate Skill files; expert.skills may be an empty array.',
        ]),
    ]

    const context = [
      '[WattClaw Team Collaboration Context]',
      `draft_project_id: ${currentProject.id}`,
      'Use the wattclaw-team-project-builder skill for this draft project.',
      ...templateContext,
      'After team planning is complete, finalize the project and include <team-project-start-confirm/> in the response.',
    ].join('\n')

    return {
      message: `${message.trim()}\n\n${context}`,
      displayMessage: prompt,
    }
  }

  function stageOutgoingMessage(params: {
    content: string
    files?: Array<{ name: string; size: number }>
    skills?: string[]
    knowledgeBases?: Array<{ id: string; name: string }>
  }): string {
    const id = `pending-collaboration-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    pendingMessages.value = [...pendingMessages.value, {
      id,
      role: 'user',
      content: params.content,
      timestamp: new Date().toISOString(),
      files: params.files,
      skills: params.skills,
      knowledgeBases: params.knowledgeBases,
    }]
    return id
  }

  function clearPendingMessage(id: string) {
    pendingMessages.value = pendingMessages.value.filter((message) => message.id !== id)
  }

  function mapMemberSessions(members: WattClawProject['members'], sessions: Session[]): WattClawMemberSession[] {
    const currentByAgent = new Map(memberSessions.value.map((session) => [session.agentId, session]))
    return members.map((member) => {
      const expectedSessionKey = `agent:${member.agentId}:main`
      const current = currentByAgent.get(member.agentId)
      const candidates = sessions.filter((session) =>
        session.key === expectedSessionKey || session.agentId === member.agentId
      )
      const latest = candidates.sort((left, right) =>
        Date.parse(right.lastActivity || '') - Date.parse(left.lastActivity || '')
      )[0]
      return {
        agentId: member.agentId,
        sessionKey: latest?.key || current?.sessionKey || expectedSessionKey,
        available: !!latest || current?.available || false,
        messageCount: Math.max(current?.messageCount || 0, latest?.messageCount || 0),
        lastActivity: latest?.lastActivity || current?.lastActivity,
        isStreaming: latest?.isStreaming || current?.isStreaming || false,
      }
    })
  }

  async function refreshDiagnosticsRequest(targetProjectId: string): Promise<void> {
    const requestId = ++diagnosticsRequestId
    loading.value = true
    error.value = null
    try {
      const wsStore = useWebSocketStore()
      const [projectResult, taskResult] = await Promise.allSettled([
        wsStore.rpc.getWattClawProject(targetProjectId),
        wsStore.rpc.listWattClawProjectTasks(targetProjectId),
      ])

      if (requestId !== diagnosticsRequestId || projectId.value !== targetProjectId) return

      if (projectResult.status === 'fulfilled') {
        const currentProject = projectResult.value
        if (String(currentProject.status || '').trim().toLowerCase() === 'archived') {
          archivedProjectIds.add(currentProject.id)
        }
        const normalizedProject = currentProject
        project.value = normalizedProject
        updateSavedProjectMeta(normalizedProject)
        if (requestId !== diagnosticsRequestId || projectId.value !== targetProjectId) return

        tasks.value = taskResult.status === 'fulfilled' ? taskResult.value : []
        const sessionKeys = normalizedProject.members.map((member) => `agent:${member.agentId}:main`)
        const sessionResult = await wsStore.rpc.listSessions({
          limit: 500,
          refreshUsage: true,
          sessionKeys,
        }).catch(() => null)
        if (requestId !== diagnosticsRequestId || projectId.value !== targetProjectId) return
        const sessions = sessionResult?.sessions || []
        memberSessions.value = mapMemberSessions(normalizedProject.members, sessions)
      } else {
        throw projectResult.reason
      }
    } catch (err) {
      if (requestId !== diagnosticsRequestId || projectId.value !== targetProjectId) return
      error.value = errorMessage(err)
    } finally {
      if (requestId === diagnosticsRequestId) loading.value = false
    }
  }

  async function refreshDiagnostics(targetProjectId = projectId.value): Promise<void> {
    if (!targetProjectId) return

    const active = diagnosticsInFlight
    if (active?.targetProjectId === targetProjectId) return active.promise

    const promise = refreshDiagnosticsRequest(targetProjectId)
    diagnosticsInFlight = { targetProjectId, promise }
    try {
      await promise
    } finally {
      if (diagnosticsInFlight?.promise === promise) diagnosticsInFlight = null
    }
  }

  async function initialize(id?: string | null) {
    const targetId = id || projectId.value
    if (!targetId) return

    if (projectId.value !== targetId) clearProjectData()
    persistProjectId(targetId)
    runtimeReady.value = false
    restoring.value = false
    await refreshDiagnostics(targetId)
    if (projectId.value !== targetId) return
    if (!project.value) {
      reset()
      return
    }

    const isArchived = String(project.value.status || '').trim().toLowerCase() === 'archived'
    if (isArchived) {
      // Archived projects are NOT auto-restored anymore. The user must click the
      // explicit "restore" button. We still bind the manager session read-only so
      // the original chat history loads immediately (sessions live in a shared
      // mount and remain readable even while the runtime is not restored).
      runtimeReady.value = false
      try {
        await bindManagerSession(project.value, { fast: true })
      } catch (err) {
        error.value = errorMessage(err)
      }
      return
    }

    try {
      runtimeReady.value = false
      const wsStore = useWebSocketStore()
      const activateProject = wsStore.rpc.activateWattClawProject
      const activatedProject = typeof activateProject === 'function'
        ? await activateProject.call(wsStore.rpc, project.value.id)
        : project.value
      const normalizedProject = activatedProject
      project.value = normalizedProject
      updateSavedProjectMeta(normalizedProject)
      await bindManagerSession(normalizedProject)
      runtimeReady.value = true
    } catch (err) {
      runtimeReady.value = false
      error.value = errorMessage(err)
    }
  }

  async function restoreProject(): Promise<void> {
    if (!projectId.value || !project.value) return

    const targetProjectId = projectId.value
    const wasArchived = String(project.value.status || '').trim().toLowerCase() === 'archived'
    restoring.value = true
    error.value = null
    diagnosticsRequestId += 1
    diagnosticsInFlight = null
    try {
      const wsStore = useWebSocketStore()
      const activateProject = wsStore.rpc.activateWattClawProject
      const activatedProject = typeof activateProject === 'function'
        ? await activateProject.call(wsStore.rpc, targetProjectId)
        : project.value
      if (projectId.value !== targetProjectId) return
      const restoredProject = wasArchived
        ? { ...activatedProject, status: 'restored' as const }
        : activatedProject
      archivedProjectIds.delete(restoredProject.id)
      project.value = restoredProject
      updateSavedProjectMeta(restoredProject)
      await bindManagerSession(restoredProject)
      runtimeReady.value = true
      await refreshDiagnostics()
      if (projectId.value === targetProjectId && project.value && wasArchived) {
        archivedProjectIds.delete(targetProjectId)
        project.value = { ...project.value, status: 'restored' }
        updateSavedProjectMeta(project.value)
      }
    } catch (err) {
      runtimeReady.value = false
      error.value = errorMessage(err)
      throw err
    } finally {
      restoring.value = false
    }
  }

  async function checkFeishuChannelPermission(force = false) {
    const authStore = useAuthStore()
    const response = await fetch(apiPath('/api/user/feishu-bot/check'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authStore.getToken() || ''}`,
      },
      body: JSON.stringify({ force }),
    })
    const result = await response.json()
    return {
      isFeishuChannelBound: !!result.bound,
      hasFeishuGroupCreatePermission: !!result.valid,
      feishuAuthUrl: result.permissionUrl || undefined,
      error: result.error || undefined,
    }
  }

  async function startProject(isCreateFeishuGroup = false) {
    if (!projectId.value) return

    starting.value = true
    error.value = null
    try {
      const wsStore = useWebSocketStore()
      if (project.value) await syncProjectMemberModels(project.value.members, true)
      const startedProject = await wsStore.rpc.startWattClawProject(projectId.value, isCreateFeishuGroup)
      project.value = startedProject
      await bindManagerSession(startedProject)
      runtimeReady.value = true
      await refreshDiagnostics()
      if (project.value && startedProject.feishuSync) {
        project.value = { ...project.value, feishuSync: startedProject.feishuSync }
      }
      return startedProject
    } catch (err) {
      error.value = errorMessage(err)
      throw err
    } finally {
      starting.value = false
    }
  }

  async function updateProjectMember(params: {
    agentId: string
    name: string
    role: string
    soul: string
    skills: string[]
    richSkills?: unknown[]
    models: WattClawProjectMemberModel[]
  }): Promise<WattClawProject> {
    const targetProjectId = projectId.value
    if (!targetProjectId) throw new Error('WattClaw project is missing')

    updatingMemberIds.value = [...new Set([...updatingMemberIds.value, params.agentId])]
    error.value = null
    try {
      const wsStore = useWebSocketStore()
      const updated = await wsStore.rpc.updateWattClawProjectMember({
        projectId: targetProjectId,
        ...params,
      })
      if (projectId.value === targetProjectId) {
        project.value = updated
        updateSavedProjectMeta(updated)
        reconcileMemberSessions(updated.members)
      }
      return updated
    } catch (err) {
      error.value = errorMessage(err)
      throw err
    } finally {
      updatingMemberIds.value = updatingMemberIds.value.filter((id) => id !== params.agentId)
    }
  }

  async function archiveProject(): Promise<void> {
    if (!projectId.value) return

    archiving.value = true
    error.value = null
    try {
      const wsStore = useWebSocketStore()
      const archived = await wsStore.rpc.archiveWattClawProject(projectId.value)
      archivedProjectIds.add(projectId.value)
      savedProjectsMetaRequestId += 1
      const patch = archived && archived.id ? archived : { ...(project.value || {}), status: 'archived' }
      project.value = { ...(project.value || {}), ...patch, status: 'archived' } as WattClawProject
      updateSavedProjectMeta(project.value)
      runtimeReady.value = false
      await loadSavedProjectsMeta()
    } catch (err) {
      error.value = errorMessage(err)
      throw err
    } finally {
      archiving.value = false
    }
  }

  function reset() {
    projectId.value = null
    teamCreationMode.value = 'template'
    captureTeamTemplate.value = true
    clearProjectData()
  }

  async function switchToProject(id: string) {
    if (projectId.value === id && project.value && (runtimeReady.value || restoring.value)) return
    persistProjectId(id)
    clearProjectData()
    await initialize(id)
  }

  function removeSavedProject(id: string) {
    const next = savedProjectIds.value.filter((pid) => pid !== id)
    persistProjectIds(next)
    savedProjectsMeta.value = savedProjectsMeta.value.filter((p) => p.id !== id)
    if (projectId.value === id) {
      projectId.value = next.length > 0 ? (next[next.length - 1] ?? null) : null
      if (!projectId.value) reset()
    }
  }

  async function loadSavedProjectsMeta() {
    const requestId = ++savedProjectsMetaRequestId
    const wsStore = useWebSocketStore()
    try {
      const projects = await wsStore.rpc.listWattClawProjects()
      if (requestId !== savedProjectsMetaRequestId) return
      for (const item of projects) {
        if (String(item.status || '').trim().toLowerCase() === 'archived') {
          archivedProjectIds.add(item.id)
        }
      }
      const projectsById = new Map(projects
        .filter((item) => typeof item?.id === 'string' && item.id)
        .map((item) => [item.id, item]))
      const orderedIds = [
        ...savedProjectIds.value.filter((id) => projectsById.has(id)),
        ...projects.map((item) => item.id).filter((id) => id && !savedProjectIds.value.includes(id)),
      ]
      persistProjectIds(orderedIds)
      savedProjectsMeta.value = orderedIds
        .map((id) => projectsById.get(id))
        .filter((item): item is WattClawProject => Boolean(item))
      return
    } catch {
      if (savedProjectIds.value.length === 0) {
        savedProjectsMeta.value = []
        return
      }
    }

    try {
      const results = await Promise.allSettled(
        savedProjectIds.value.map((id) => wsStore.rpc.getWattClawProject(id))
      )
      if (requestId !== savedProjectsMetaRequestId) return
      const projects = results
        .map((result, index) => {
          const id = savedProjectIds.value[index]
          if (result.status === 'fulfilled' && result.value && id) {
            return { ...result.value, id }
          }
          return null
        })
        .filter((p): p is WattClawProject & { id: string } => p !== null)
      persistProjectIds(projects.map((item) => item.id))
      savedProjectsMeta.value = projects
    } catch {
      savedProjectsMeta.value = []
    }
  }

  async function retryProject() {
    if (!projectId.value) return

    retrying.value = true
    error.value = null
    try {
      const wsStore = useWebSocketStore()
      if (project.value) await syncProjectMemberModels(project.value.members, true)
      project.value = await wsStore.rpc.retryWattClawProject(projectId.value)
      runtimeReady.value = true
      await refreshDiagnostics()
    } catch (err) {
      error.value = errorMessage(err)
      throw err
    } finally {
      retrying.value = false
    }
  }

  function applyProjectMetaPatch(id: string, patch: Partial<WattClawProject>) {
    savedProjectsMeta.value = savedProjectsMeta.value.map((item) =>
      item.id === id ? { ...item, ...patch } : item
    )
    if (project.value?.id === id) {
      project.value = { ...project.value, ...patch }
    }
  }

  async function renameProject(id: string, name: string): Promise<void> {
    const nextName = name.trim()
    if (!id || !nextName) return
    const wsStore = useWebSocketStore()
    const updated = await wsStore.rpc.updateWattClawProject({ id, name: nextName })
    const patch = updated && updated.id === id ? updated : { name: nextName }
    applyProjectMetaPatch(id, patch)
    if (updated?.id === id) updateSavedProjectMeta(updated)
  }

  async function deleteProject(id: string): Promise<void> {
    if (!id) return
    const wsStore = useWebSocketStore()
    await wsStore.rpc.deleteWattClawProject(id)
    removeSavedProject(id)
  }

  return {
    projectId,
    savedProjectIds,
    savedProjectsMeta,
    project,
    tasks,
    memberSessions,
    selectedModel,
    teamCreationMode,
    captureTeamTemplate,
    loading,
    restoring,
    runtimeReady,
    creating,
    starting,
    retrying,
    archiving,
    updatingMemberIds,
    error,
    pendingMessages,
    managerAgentId,
    hasProject,
    projectSessionKeys,
    selectModel,
    setTeamCreationMode,
    toggleTeamCreationMode,
    setCaptureTeamTemplate,
    toggleCaptureTeamTemplate,
    createDraft,
    prepareOutgoingMessage,
    stageOutgoingMessage,
    clearPendingMessage,
    refreshDiagnostics,
    initialize,
    restoreProject,
    startProject,
    updateProjectMember,
    checkFeishuChannelPermission,
    reset,
    switchToProject,
    removeSavedProject,
    loadSavedProjectsMeta,
    retryProject,
    archiveProject,
    renameProject,
    deleteProject,
    handleRealtimeEvent,
  }
})
