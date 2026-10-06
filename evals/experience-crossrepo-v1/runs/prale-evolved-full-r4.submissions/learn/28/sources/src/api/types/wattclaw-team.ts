export type WattClawProjectStatus =
  | 'creating'
  | 'waiting'
  | 'pending'
  | 'planning'
  | 'in_progress'
  | 'paused'
  | 'failed'
  | 'archived'
  | string

export type WattClawTeamCreationMode = 'template' | 'manager'

export interface WattClawCollaborationSettings {
  teamCreationMode: WattClawTeamCreationMode
  captureTeamTemplate: boolean
}

export interface WattClawProjectMemberModel {
  modelSource: string
  modelName: string
  modelAccessPointId?: string
}

export interface WattClawProjectMember {
  agentId: string
  name: string
  role: string
  soul?: string
  status?: string
  isLead?: boolean
  skills?: string[]
  richSkills?: unknown[]
  models?: WattClawProjectMemberModel[]
  createdAt?: string
  updatedAt?: string
}

export interface WattClawProjectTemplateMatch {
  normalizedIntent?: Record<string, unknown>
  decision?: 'auto_apply' | 'recommend' | 'fresh_plan' | string
  selectedTemplate?: Record<string, unknown> | null
  profileMatches?: Array<{
    slotId?: string
    roleId?: string
    profile?: WattClawAgentProfile | null
  }>
  candidates?: Array<{
    templateId?: string
    version?: string
    name?: string
    description?: string
    score?: number
    reasons?: string[]
  }>
  [key: string]: unknown
}

export interface WattClawTeamTemplate {
  id: string
  version: string
  scope?: string
  name: string
  description?: string
  status?: string
  intent?: Record<string, unknown>
  capabilities?: string[]
  slots?: Array<Record<string, unknown>>
  workflow?: Record<string, unknown>
  [key: string]: unknown
}

export interface WattClawAgentProfile {
  id: string
  userId?: string
  tenantId?: string
  roleId: string
  name: string
  gatewayAgentId?: string | null
  baseWorkspace?: string | null
  capabilityTags: string[]
  skills: string[]
  model?: string | null
  reusePolicy: string
  concurrencyLimit: number
  status: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface WattClawProjectMemberBinding {
  id: string
  projectId: string
  userId?: string
  slotId: string
  profileId: string
  runtimeAgentId?: string | null
  sessionKey?: string | null
  projectWorkspace?: string | null
  leaseUntil?: number | null
  status: string
  [key: string]: unknown
}

export interface WattClawProject {
  id: string
  name: string
  description?: string
  locale?: string
  status: WattClawProjectStatus
  createdAt?: string
  updatedAt?: string
  members: WattClawProjectMember[]
  lastStatus?: WattClawProjectStatus
  failReason?: string
  draftSuggestion?: Record<string, unknown>
  templateMatch?: WattClawProjectTemplateMatch
  feishuSync?: {
    enabled: boolean
    chatId?: string
    chatName?: string
    error?: string
    permissionUrl?: string
  }
  [key: string]: unknown
}

export interface WattClawProjectTask {
  id?: string
  taskId?: string
  projectId?: string
  title?: string
  name?: string
  description?: string
  status?: string
  agentId?: string
  assigneeAgentId?: string
  assignedAgentId?: string
  error?: string
  failReason?: string
  createdAt?: string
  updatedAt?: string
  outputs?: unknown
  [key: string]: unknown
}

export interface WattClawProjectTaskOutput {
  name: string
  path: string
  size?: number
  isDirectory?: boolean
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

export interface WattClawOutputDownloadChunk {
  chunkIndex: number
  filename: string
  outputName?: string
  data: string
  hasNext: boolean
  fileSize?: number
}

export interface WattClawMemberSession {
  agentId: string
  sessionKey: string
  available: boolean
  messageCount: number
  lastActivity?: string
  isStreaming: boolean
}
