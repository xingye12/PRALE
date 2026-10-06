<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NButton, NEmpty, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useWattClawCollaborationStore } from '@/stores/wattclaw-collaboration'
import { getWattClawTaskDeliverables } from '@/utils/wattclaw-deliverable'
import type { WattClawProjectMember, WattClawProjectTask } from '@/api/types'
import WattClawDeliverableOutput from './WattClawDeliverableOutput.vue'

const { t, te } = useI18n()
const router = useRouter()
const message = useMessage()
const collaborationStore = useWattClawCollaborationStore()

const project = computed(() => collaborationStore.project)

function statusText(status?: string): string {
  if (!status) return t('pages.wattClawCollaboration.status.unknown')
  const key = `pages.wattClawCollaboration.status.${status}`
  return te(key) ? t(key) : status
}

function statusType(status?: string): 'success' | 'warning' | 'error' | 'info' | 'default' {
  if (status === 'in_progress' || status === 'running' || status === 'success' || status === 'Success' || status === 'restored') return 'success'
  if (status === 'failed' || status === 'fail' || status === 'Failed' || status === 'Block') return 'error'
  if (status === 'pending' || status === 'planning' || status === 'creating' || status === 'waiting') return 'warning'
  if (status === 'undispatched' || status === 'Pending') return 'default'
  if (status === 'paused' || status === 'archived') return 'default'
  return 'info'
}

function sessionFor(member: WattClawProjectMember) {
  return collaborationStore.memberSessions.find((session) => session.agentId === member.agentId)
}

function taskTitle(task: WattClawProjectTask): string {
  return task.title || task.name || task.taskId || task.id || t('pages.wattClawCollaboration.unnamedTask')
}

function taskAgent(task: WattClawProjectTask): string {
  return task.assignedAgentId || task.assigneeAgentId || task.agentId || ''
}

function taskError(task: WattClawProjectTask): string {
  return task.failReason || task.error || ''
}

const COMPLETED_TASK_STATUSES = new Set(['Success', 'completed', 'done'])
const FAILED_TASK_STATUSES = new Set(['failed', 'Failed', 'Block', 'error'])
const RUNNING_TASK_STATUSES = new Set(['InProgress', 'in_progress', 'running', 'Dispatched', 'dispatched'])

// When the project itself has failed, reconcile per-task display status:
// completed → keep completed, running/dispatched → failed, pending → undispatched.
function displayTaskStatus(task: WattClawProjectTask): string {
  const raw = task.status || ''
  if (project.value?.status !== 'failed') return raw

  if (COMPLETED_TASK_STATUSES.has(raw)) return raw
  if (FAILED_TASK_STATUSES.has(raw)) return raw
  if (RUNNING_TASK_STATUSES.has(raw)) return 'Failed'
  return 'undispatched'
}

function formatTime(value?: string): string {
  if (!value) return t('pages.wattClawCollaboration.noActivity')
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  return new Date(time).toLocaleString()
}

// ── Deliverables ──
const tasksWithDeliverables = computed(() =>
  collaborationStore.tasks.filter((task) => getWattClawTaskDeliverables(task).length > 0)
)

const deliverableCount = computed(() =>
  tasksWithDeliverables.value.reduce(
    (count, task) => count + getWattClawTaskDeliverables(task).length,
    0,
  )
)

const deliverablesByAgent = computed(() => {
  const groups: Record<string, WattClawProjectTask[]> = {}
  for (const task of tasksWithDeliverables.value) {
    const agent = taskAgent(task) || 'unknown'
    if (!groups[agent]) groups[agent] = []
    groups[agent].push(task)
  }
  return groups
})

function agentName(agentId: string): string {
  const member = project.value?.members.find((m) => m.agentId === agentId)
  return member?.name || agentId
}

function isFinalDeliverable(task: WattClawProjectTask): boolean {
  return task.status === 'Success' || task.status === 'completed'
}

// ── Retry ──
async function handleRetry() {
  if (!collaborationStore.runtimeReady || collaborationStore.restoring || project.value?.status === 'archived') return
  try {
    await collaborationStore.retryProject()
    message.success(t('pages.wattClawCollaboration.retrySuccess'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('pages.wattClawCollaboration.retryFailed'))
  }
}

function fallbackCopyText(text: string): boolean {
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

async function copyProjectId() {
  if (!collaborationStore.projectId) return
  const projectId = collaborationStore.projectId
  // navigator.clipboard 仅在安全上下文（HTTPS/localhost）可用；服务器经 HTTP+IP 访问时
  // 为非安全上下文，navigator.clipboard 为 undefined 会抛错 → 回退到 execCommand。
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(projectId)
      message.success(t('pages.wattClawCollaboration.projectIdCopied'))
      return
    }
  } catch {
    // 忽略，走下面的 fallback
  }
  if (fallbackCopyText(projectId)) {
    message.success(t('pages.wattClawCollaboration.projectIdCopied'))
  } else {
    message.error(t('pages.wattClawCollaboration.copyFailed'))
  }
}

// ── Archive / Restore ──
// Any finished project (success / failed / paused) can be manually archived at
// any time, with no time-based retention restriction. A restored project can be
// archived again as well.
const ARCHIVABLE_STATUSES = new Set(['success', 'fail', 'failed', 'paused', 'restored'])
const canArchive = computed(() => {
  const status = String(project.value?.status || '').trim().toLowerCase()
  return ARCHIVABLE_STATUSES.has(status)
})

// Archived projects are restored only on explicit user action (button click),
// never automatically on open.
const canRestore = computed(() => {
  const status = String(project.value?.status || '').trim().toLowerCase()
  return status === 'archived' && !collaborationStore.runtimeReady
})

async function handleArchive() {
  if (!canArchive.value || collaborationStore.archiving) return
  try {
    await collaborationStore.archiveProject()
    message.success(t('pages.wattClawCollaboration.archiveSuccess'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('pages.wattClawCollaboration.archiveFailed'))
  }
}

async function handleRestore() {
  if (!canRestore.value || collaborationStore.restoring) return
  try {
    await collaborationStore.restoreProject()
    message.success(t('pages.wattClawCollaboration.restoreSuccess'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : t('pages.wattClawCollaboration.restoreFailed'))
  }
}

function openSession(sessionKey?: string) {
  // Viewing a member's session history is read-only, so it must NOT be gated by
  // runtime restore. Sending messages is still blocked in the store's
  // prepareOutgoingMessage() while restoring/!runtimeReady, so opening the
  // session here only lets the user read prior messages during recovery.
  if (!sessionKey) return
  void router.push({
    name: 'Workspace',
    query: {
      session: sessionKey,
      historyLimit: '10',
    },
  })
}
</script>

<template>
  <aside class="diagnostic-panel">
    <div class="panel-head">
      <div>
        <div class="panel-title">{{ t('pages.wattClawCollaboration.diagnostics') }}</div>
        <div class="panel-subtitle">{{ t('pages.wattClawCollaboration.diagnosticsHint') }}</div>
      </div>
      <NButton quaternary circle size="small" :loading="collaborationStore.loading" @click="collaborationStore.refreshDiagnostics()">
        <template #icon><span class="material-symbols-outlined">refresh</span></template>
      </NButton>
    </div>

    <div v-if="collaborationStore.loading && !project" class="panel-loading">
      <NSpin size="small" />
    </div>

    <NEmpty v-else-if="!project" :description="t('pages.wattClawCollaboration.noProject')" />

    <template v-else>
      <section class="panel-section project-summary">
        <div class="section-title-row">
          <div class="section-title">{{ project.name }}</div>
          <NTag size="small" :type="statusType(project.status)" :bordered="false">
            {{ statusText(project.status) }}
          </NTag>
        </div>
        <button type="button" class="project-id" @click="copyProjectId">
          <code>{{ project.id }}</code>
          <span class="material-symbols-outlined">content_copy</span>
        </button>
        <div v-if="project.updatedAt" class="project-updated">
          {{ t('pages.wattClawCollaboration.updatedAt', { time: formatTime(project.updatedAt) }) }}
        </div>
        <NButton
          v-if="canRestore"
          size="small"
          secondary
          block
          class="archive-btn"
          :loading="collaborationStore.restoring"
          @click="handleRestore"
        >
          <template #icon><span class="material-symbols-outlined">unarchive</span></template>
          {{ t('pages.wattClawCollaboration.restore') }}
        </NButton>
        <NButton
          v-if="canArchive"
          size="small"
          secondary
          block
          class="archive-btn"
          :loading="collaborationStore.archiving"
          @click="handleArchive"
        >
          <template #icon><span class="material-symbols-outlined">archive</span></template>
          {{ t('pages.wattClawCollaboration.archive') }}
        </NButton>
      </section>

      <NAlert v-if="project.failReason" type="error" :show-icon="true" class="failure-alert">
        <template #header>{{ t('pages.wattClawCollaboration.failureReason') }}</template>
        <div class="failure-content">
          <span>{{ project.failReason }}</span>
          <NButton
            size="small"
            type="error"
            :loading="collaborationStore.retrying"
            :disabled="!collaborationStore.runtimeReady || collaborationStore.restoring || project.status === 'archived'"
            @click="handleRetry"
          >
            {{ t('pages.wattClawCollaboration.retry') }}
          </NButton>
        </div>
      </NAlert>

      <section class="panel-section">
        <div class="section-heading">
          <span>{{ t('pages.wattClawCollaboration.members') }}</span>
          <span>{{ project.members.length }}</span>
        </div>
        <div class="member-list">
          <button
            v-for="member in project.members"
            :key="member.agentId"
            type="button"
            class="member-item"
            :title="t('pages.wattClawCollaboration.viewSession')"
            @click="openSession(sessionFor(member)?.sessionKey)"
          >
            <div class="member-icon" :class="{ lead: member.isLead }">
              <span class="material-symbols-outlined">{{ member.isLead ? 'supervisor_account' : 'smart_toy' }}</span>
            </div>
            <div class="member-main">
              <div class="member-name-row">
                <span class="member-name">{{ member.name }}</span>
                <NTag v-if="member.isLead" size="tiny" type="info" :bordered="false">
                  {{ t('pages.wattClawCollaboration.manager') }}
                </NTag>
              </div>
              <div class="member-role">{{ member.role }}</div>
              <div v-if="sessionFor(member)?.available" class="session-meta">
                <span class="session-dot" :class="{ running: sessionFor(member)?.isStreaming }" />
                <span>{{ sessionFor(member)?.isStreaming ? t('pages.wattClawCollaboration.sessionRunning') : t('pages.wattClawCollaboration.sessionReady') }}</span>
                <span>·</span>
                <span>{{ t('pages.wattClawCollaboration.sessionMessages', { count: sessionFor(member)?.messageCount || 0 }) }}</span>
              </div>
              <div v-else class="session-meta initializing">
                <span class="session-dot" />
                {{ t('pages.wattClawCollaboration.sessionInitializing') }}
              </div>
              <div v-if="sessionFor(member)?.lastActivity" class="session-time">
                {{ formatTime(sessionFor(member)?.lastActivity) }}
              </div>
            </div>
            <span class="member-open material-symbols-outlined">chevron_right</span>
          </button>
        </div>
      </section>

      <section v-if="Object.keys(deliverablesByAgent).length > 0" class="panel-section">
        <div class="section-heading">
          <span>{{ t('pages.wattClawCollaboration.deliverables') }}</span>
          <span>{{ deliverableCount }}</span>
        </div>
        <div class="deliverable-list">
          <div v-for="(group, agentId) in deliverablesByAgent" :key="agentId" class="deliverable-agent-group">
            <div class="deliverable-agent-header">
              <span class="material-symbols-outlined">smart_toy</span>
              <span class="deliverable-agent-name">{{ agentName(agentId) }}</span>
              <NTag size="tiny" :bordered="false">{{ group.length }}</NTag>
            </div>
            <div v-for="task in group" :key="task.taskId || task.id" class="deliverable-item">
              <div class="deliverable-task-title">
                {{ taskTitle(task) }}
                <NTag size="tiny" :type="isFinalDeliverable(task) ? 'success' : 'warning'" :bordered="false">
                  {{ isFinalDeliverable(task) ? t('pages.wattClawCollaboration.finalDeliverable') : t('pages.wattClawCollaboration.intermediateDeliverable') }}
                </NTag>
              </div>
              <div v-for="(output, oi) in getWattClawTaskDeliverables(task)" :key="oi" class="deliverable-output">
                <WattClawDeliverableOutput
                  :project-id="project.id"
                  :task-id="task.taskId || task.id || ''"
                  :output="output"
                  :output-index="oi"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="panel-section">
        <div class="section-heading">
          <span>{{ t('pages.wattClawCollaboration.tasks') }}</span>
          <span>{{ collaborationStore.tasks.length }}</span>
        </div>
        <NEmpty
          v-if="collaborationStore.tasks.length === 0"
          size="small"
          :description="t('pages.wattClawCollaboration.noTasks')"
        />
        <div v-else class="task-list">
          <div v-for="task in collaborationStore.tasks" :key="task.taskId || task.id || taskTitle(task)" class="task-item">
            <div class="task-title-row">
              <span class="task-title">{{ taskTitle(task) }}</span>
              <NTag size="tiny" :type="statusType(displayTaskStatus(task))" :bordered="false">
                {{ statusText(displayTaskStatus(task)) }}
              </NTag>
            </div>
            <div v-if="taskAgent(task)" class="task-agent">{{ taskAgent(task) }}</div>
            <div v-if="taskError(task)" class="task-error">{{ taskError(task) }}</div>
          </div>
        </div>
      </section>

      <NAlert v-if="collaborationStore.error" type="error" :show-icon="true">
        {{ collaborationStore.error }}
      </NAlert>
    </template>
  </aside>
</template>

<style scoped>
.diagnostic-panel {
  width: 360px;
  min-width: 320px;
  height: 100%;
  overflow-y: auto;
  border-left: 1px solid var(--border-color);
  background: var(--bg-card);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel-head,
.section-title-row,
.section-heading,
.task-title-row,
.member-name-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.panel-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}

.panel-subtitle,
.project-updated,
.member-role,
.session-time,
.task-agent {
  color: var(--text-muted);
  font-size: 12px;
}

.panel-loading {
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.panel-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.project-summary {
  padding: 14px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg);
}

.section-title {
  font-weight: 700;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-id {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  align-self: flex-start;
}

.project-id .material-symbols-outlined {
  font-size: 14px;
}

.archive-btn {
  margin-top: 4px;
}

.failure-alert {
  flex-shrink: 0;
}

.failure-content {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.failure-content span {
  line-height: 1.5;
}

.section-heading {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}

.member-list,
.task-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.member-item,
.task-item {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg);
}

.member-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 11px;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease;
}

.member-item:hover {
  border-color: var(--primary);
  background: var(--bg-hover);
}

.member-icon {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--bg-hover);
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.member-icon.lead {
  background: var(--accent-bg);
  color: var(--accent);
}

.member-icon .material-symbols-outlined {
  font-size: 18px;
}

.member-main {
  flex: 1;
  min-width: 0;
}

.member-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-role {
  margin-top: 2px;
}

.session-meta {
  margin-top: 7px;
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
  font-size: 12px;
}

.session-meta.initializing {
  color: var(--warning, #d97706);
}

.session-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
}

.session-dot.running {
  background: var(--success, #16a34a);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success, #16a34a) 18%, transparent);
}

.member-open {
  align-self: center;
  color: var(--accent);
  font-size: 20px;
}

.task-item {
  padding: 10px;
}

.task-title {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.task-agent,
.task-error {
  margin-top: 5px;
  overflow-wrap: anywhere;
}

.task-error {
  color: var(--error, #dc2626);
  font-size: 12px;
}

.deliverable-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.deliverable-agent-group {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg);
  overflow: hidden;
}

.deliverable-agent-header {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 11px;
  background: var(--bg-hover);
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.deliverable-agent-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.deliverable-agent-header .material-symbols-outlined {
  font-size: 16px;
  color: var(--text-muted);
}

.deliverable-item {
  padding: 9px 11px;
  border-top: 1px solid var(--border-color);
}

.deliverable-task-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.deliverable-output {
  margin-top: 4px;
}

@media (max-width: 1100px) {
  .diagnostic-panel {
    width: 320px;
    min-width: 280px;
  }
}
</style>
