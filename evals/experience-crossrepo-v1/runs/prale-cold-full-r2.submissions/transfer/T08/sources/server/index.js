// server/index.js — Application assembler
// Initializes Express, Gateway connection, core infrastructure routes,
// and registers all business-domain route handlers.

import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { parse } from 'dotenv'

// ── Internal modules ──
import { OpenClawGateway } from './gateway.js'
// import { createPollingCache } from './utils.js'  // REMOVED: no longer used after skillsStatusPolling removal
import db from './database.js'
import { initMessageStore, isReady as isMessageStoreReady, mergeSessionMessages, deleteSessionMessages, dedupSessionMessages } from './message-store.js'
import {
  initDefaultAdmin,
  getUserOwnedAgentIds, getUserOwnedSessionKeys,
  getWattClawProjectAccessStatesForRetention,
  getWattClawProjectAccessStates,
  getUserIdsByAgentId,
  markWattClawProjectArchived,
  markWattClawProjectArchivedForRetention,
  markWattClawProjectRestored,
  resolveTenantIdForSession,
  removeWattClawProjectAccess,
  trackSessionForUser, trackAgentForUser,
  touchWattClawProjectAccess,
  upsertExternalSessionProjection,
  removeSessionForUser,
  getChannelsByAgentId,
  deduplicateSharedSessions,
  getAgentsWithoutModel, backfillAgentModel,
  backfillAgentWorkspacesFromGatewayAgents,
} from './user-manager.js'
import { createIssuesRouter } from './issues.js'
import { createNotificationsRouter } from './notifications.js'
import { createAvatarUploadRouter } from './avatar-upload.js'

// ── Core modules ──
import {
  setGateway, setEnvConfig, setGatewayVersion, setUpdateInfo,
  setReconnectGatewayFn, setFlushPendingTokenUpdateFn,
  sseClients, streamIdMap,
} from './core/index.js'
import { broadcastSSE, sendSSEToClient } from './core/sse.js'
import { recordRequest, cacheSessionModel, getCachedSessionModel, getStatus as getCongestionStatus, initMonitorConfig } from './model-concurrency-monitor.js'
import { broadcastGlobalSSE } from './core/sse.js'
import { isAuthEnabled, authMiddleware } from './core/auth.js'
import {
  initGatewayClient, gatewayAdminRpc,
  HTTP_RPC_METHODS, fetchHistoryFromGateway, gatewayHttpGet, gatewayHttpPost,
} from './core/gateway-client.js'
import { syncModelsFromGateway } from './model-manager.js'
import { startModelHealthMonitor } from './model-health-monitor.js'
import { listCronJobsFromDb, refreshCronJobsForScope, syncCronFromGateway } from './cron-manager.js'
import { attachMessageSync, isExternalChannelSession } from './core/message-sync.js'
import { resolveSessionDisplayTitle, shouldBackfillDisplayTitle } from './services/session-title-service.js'
import { repairSessionTitleAndActivitySemantics } from './services/session-activity-service.js'
import { backfillExternalSessionTitles } from './services/external-session-projection.js'
import {
  activateWattClawProjectRuntime,
  ensureWattClawProjectRuntime,
  extractWattClawProject,
  extractWattClawProjects,
  filterWattClawProjectsByOwnedAgents,
  nextWattClawRetentionRunAt,
  pruneWattClawProjectsForUser,
  trackWattClawProjectOwnership,
  userOwnsWattClawProject,
} from './services/wattclaw-project-runtime.js'
import {
  captureSuccessfulProjectTemplateCandidate,
  getProjectTemplateMatch,
  listTeamTemplates,
  matchTeamTemplatesFromRegistry,
  recordProjectTemplateMatch,
  saveTeamTemplate,
} from './services/team-template-service.js'
import {
  bindAgentProfileToProject,
  findReusableAgentProfile,
  getAgentProfile,
  listAgentProfiles,
  listProjectMemberBindings,
  releaseProjectMemberBinding,
  releaseProjectMemberBindings,
  upsertAgentProfile,
} from './services/agent-profile-service.js'
import { initMultiTenantGateway, callGatewayForAllTenants, callGatewayForTenant, listOpenClawTenants } from './core/multi-tenant-gateway.js'

// ── Handler modules ──
import { createAuthRoutes } from './handlers/auth.js'
import { createUserRoutes } from './handlers/users.js'
import { createTenantRoutes } from './handlers/tenants.js'
import {
  createSessionRoutes,
  recentlyDeletedSessions,
} from './handlers/sessions.js'
import { createUsageRoutes, setScheduleUsageSyncFn } from './handlers/usage-routes.js'
import {
  getUserAggregates,
  getAdminUserUsageAggregates,
  hasUsageSyncRows,
} from './core/session-usage-cache.js'
import {
  scheduleSessionUsageSync,
  syncUsageFromGatewayOnStartup,
} from './core/usage-sync.js'
import { createAgentTeamRoutes } from './handlers/agent-team.js'
import { createChannelRoutes } from './handlers/channels.js'
import { createModelProviderRoutes, syncGatewayProvidersToDB } from './handlers/model-providers.js'
import { createModelRoutes } from './handlers/models.js'
import { createCronRoutes } from './handlers/cron.js'
import { createChatRoutes } from './handlers/chat.js'
import { createFileRoutes } from './handlers/files.js'
import { createKnowledgeBaseRoutes } from './handlers/knowledge-bases.js'
import { createSystemRoutes } from './handlers/system.js'
import { createTerminalRoutes } from './handlers/terminal.js'
import { createDesktopRoutes } from './handlers/desktop.js'
import { createWizardRoutes } from './handlers/wizard.js'
import { createBackupRoutes } from './handlers/backup.js'
import { createUserAgentRoutes } from './handlers/user-agents.js'
import { createWorkspaceRoutes } from './handlers/workspace.js'
import { createMediaRoutes } from './handlers/media.js'
import { createSkillStoreRoutes } from './handlers/skill-store.js'
import { createFeishuProxyRoutes } from './handlers/feishu-proxy.js'
import { createFeishuAuthRoutes } from './handlers/feishu-auth.js'
import { createFeishuBotRoutes } from './handlers/feishu-bot.js'
import { createDashboardStatsRoutes } from './handlers/dashboard-stats.js'
import { attachXfyunSpeechProxy } from './handlers/xfyun-speech.js'
import {
  disableWattClawProjectFeishuSync,
  enableWattClawProjectFeishuSync,
  getFeishuPermissionUrl,
  getUserFeishuBot,
  refreshWattClawProjectFeishuMembers,
  sendWattClawProjectFeishuIntro,
  syncWattClawProjectMessage,
  verifyUserFeishuBot,
} from './services/feishu-project-sync.js'
import {
  createWattClawProjectEventService,
  resolveWattClawProjectDirectory,
} from './services/wattclaw-project-events.js'

// ── Utils ──
import {
  normalizeContent, extractUserMessageFromBootstrap,
} from './utils/index.js'

// ── Setup ──
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const envPath = join(__dirname, '../.env')

function loadEnvConfig() {
  const defaults = {
    INSTANCE_ID: 'test',
    PROJECT_ROOT: '',
    PORT: 3001,
    OPENCLAW_WS_URL: 'ws://localhost:18789',
    OPENCLAW_AUTH_TOKEN: '',
    OPENCLAW_AUTH_PASSWORD: '',
    OPENCLAW_MULTI_TENANT: 'true',
    OPENCLAW_MANAGE_CONTAINERS: 'true',
    OPENCLAW_IMAGE: 'ghcr.io/openclaw/openclaw:latest',
    OPENCLAW_BROWSER_PACKAGES: 'chromium nss freetype harfbuzz ttf-freefont',
    OPENCLAW_APT_BROWSER_PACKAGES: 'chromium libnss3 libfreetype6 libharfbuzz0b fonts-freefont-ttf',
    OPENCLAW_BROWSER_IMAGE: '',
    OPENCLAW_BUILD_BROWSER_IMAGE: 'true',
    OPENCLAW_BROWSER_IMAGE_FORCE_BUILD: 'true',
    OPENCLAW_NETWORK: 'multi-openclaw-net',
    OPENCLAW_CONTAINER_PREFIX: 'openclaw-tenant',
    OPENCLAW_PORT: '18789',
    OPENCLAW_HOST_PORT_BASE: '19789',
    OPENCLAW_HOST_PORT_BIND: '0.0.0.0',
    OPENCLAW_CONTAINER_MEMORY_MB: '8192',
    OPENCLAW_CONTAINER_CPUS: '4',
    OPENCLAW_PUBLIC_PROTOCOL: 'http',
    OPENCLAW_PUBLIC_HOST: '',
    OPENCLAW_WS_PATH: '',
    OPENCLAW_MAX_USERS: '20',
    OPENCLAW_INITIAL_TENANTS: '1',
    OPENCLAW_MAX_TENANTS: '100',
    OPENCLAW_CPUSETS: '',
    OPENCLAW_TOKEN_PREFIX: 'openclaw-token',
    OPENCLAW_DATA_VOLUME_PREFIX: 'openclaw-data',
    OPENCLAW_HOST_DATA_DIR: '',
    OPENCLAW_CONTAINER_DATA_DIR: '',
    OPENCLAW_WATTCLAW_HOST_DIR: '/home/wattman/.wattclaw',
    OPENCLAW_WATTCLAW_CONTAINER_DIR: '/home/wattman/.wattclaw',
    OPENCLAW_AGENTS_SHARE_HOST_DIR: '/home/wattman/.openclaw/agents',
    OPENCLAW_AGENTS_SHARE_CONTAINER_DIR: '/home/node/.openclaw/agents',
    OPENCLAW_LARK_AUTO_INSTALL: 'true',
    OPENCLAW_LARK_PACKAGE: '@larksuite/openclaw-lark',
    OPENCLAW_LARK_PATCH_DIR: '/app/openclaw-lark-patches',
    OPENCLAW_LARK_FAIL_ON_ERROR: 'false',
    OPENCLAW_DIST_MONITOR_TARGET: '/home/node/.npm-global/lib/node_modules/openclaw/dist/monitor-Bog7UNtj.js',
    OPENCLAW_WEB_SEARCH_PROVIDER: '',
    OPENCLAW_WEB_SEARCH_ENABLED: '',
    OPENCLAW_WEB_SEARCH_MAX_RESULTS: '',
    BRAVE_API_KEY: '',
    DEV_FRONTEND_URL: 'http://localhost:3000',
    AUTH_USERNAME: '',
    AUTH_PASSWORD: '',
    FEISHU_BOT_CREDENTIAL_KEY: '',
    MEDIA_DIR: '',
    LOG_LEVEL: 'INFO',
    XFYUN_APP_ID: '',
    XFYUN_API_KEY: '',
    XFYUN_API_SECRET: '',
    GATEWAY_SSH_USER: '',
    GATEWAY_MEDIA_DIR: '',
    GATEWAY_SKILLS_STORE_PATH: '/home/wattman/skills-store',
    MODEL_HEALTH_CHECK_ENABLED: 'true',
    MODEL_HEALTH_INTERVAL_MS: '1800000',
    MODEL_HEALTH_TIMEOUT_MS: '30000',
    MODEL_HEALTH_MAX_RETRIES: '2',
    MODEL_HEALTH_MAX_TOKENS: '16',
    MODEL_HEALTH_INITIAL_DELAY_MS: '10000',
    OPENCLAW_HERMES_ENABLED: 'true',
    OPENCLAW_HERMES_MODE: 'dedicated',
    HERMES_IMAGE: '',
    HERMES_RUNTIME_IMAGE: '',
    HERMES_DEFAULT_MODEL: '',
    HERMES_ACP_CMD: '',
    OPENCLAW_HERMES_CONTAINER_PREFIX: '',
    OPENCLAW_HERMES_ACP_PORT: '3100',
    OPENCLAW_HERMES_DATA_DIR: '/home/node/hermes-data',
    OPENCLAW_HERMES_CONTAINER_MEMORY_MB: '4096',
    OPENCLAW_HERMES_CONTAINER_CPUS: '2',
    OPENCLAW_HERMES_BUILD_CONTEXT_DIR: '',
    OPENCLAW_HERMES_PLUGIN_DIR: '',
    OPENCLAW_HERMES_PLUGIN_AUTO_INSTALL: 'true',
    OPENCLAW_HERMES_PLUGIN_FAIL_ON_ERROR: 'false',
    OPENCLAW_HERMES_PLUGIN_INSTALL_TIMEOUT_MS: '600000',
    OPENCLAW_HERMES_PLUGIN_RETRY_COOLDOWN_MS: '300000',
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: '',
  }

  let fileConfig = {}
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, 'utf-8')
      fileConfig = parse(content)
    } catch (err) {
      console.warn('[Config] Failed to read .env file:', err.message)
    }
  }

  return {
    INSTANCE_ID: process.env.INSTANCE_ID || fileConfig.INSTANCE_ID || defaults.INSTANCE_ID,
    PROJECT_ROOT: process.env.PROJECT_ROOT || fileConfig.PROJECT_ROOT || defaults.PROJECT_ROOT,
    PORT: process.env.PORT || fileConfig.PORT || defaults.PORT,
    OPENCLAW_WS_URL: process.env.OPENCLAW_WS_URL || fileConfig.OPENCLAW_WS_URL || defaults.OPENCLAW_WS_URL,
    OPENCLAW_AUTH_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_AUTH_TOKEN || fileConfig.OPENCLAW_GATEWAY_TOKEN || fileConfig.OPENCLAW_AUTH_TOKEN || defaults.OPENCLAW_AUTH_TOKEN,
    OPENCLAW_AUTH_PASSWORD: process.env.OPENCLAW_AUTH_PASSWORD || fileConfig.OPENCLAW_AUTH_PASSWORD || defaults.OPENCLAW_AUTH_PASSWORD,
    OPENCLAW_MULTI_TENANT: process.env.OPENCLAW_MULTI_TENANT || fileConfig.OPENCLAW_MULTI_TENANT || defaults.OPENCLAW_MULTI_TENANT,
    OPENCLAW_MANAGE_CONTAINERS: process.env.OPENCLAW_MANAGE_CONTAINERS || fileConfig.OPENCLAW_MANAGE_CONTAINERS || defaults.OPENCLAW_MANAGE_CONTAINERS,
    OPENCLAW_IMAGE: process.env.OPENCLAW_IMAGE || fileConfig.OPENCLAW_IMAGE || defaults.OPENCLAW_IMAGE,
    OPENCLAW_BROWSER_PACKAGES: process.env.OPENCLAW_BROWSER_PACKAGES || fileConfig.OPENCLAW_BROWSER_PACKAGES || defaults.OPENCLAW_BROWSER_PACKAGES,
    OPENCLAW_APT_BROWSER_PACKAGES: process.env.OPENCLAW_APT_BROWSER_PACKAGES || fileConfig.OPENCLAW_APT_BROWSER_PACKAGES || defaults.OPENCLAW_APT_BROWSER_PACKAGES,
    OPENCLAW_BROWSER_IMAGE: process.env.OPENCLAW_BROWSER_IMAGE || fileConfig.OPENCLAW_BROWSER_IMAGE || defaults.OPENCLAW_BROWSER_IMAGE,
    OPENCLAW_BUILD_BROWSER_IMAGE: process.env.OPENCLAW_BUILD_BROWSER_IMAGE || fileConfig.OPENCLAW_BUILD_BROWSER_IMAGE || defaults.OPENCLAW_BUILD_BROWSER_IMAGE,
    OPENCLAW_BROWSER_IMAGE_FORCE_BUILD: process.env.OPENCLAW_BROWSER_IMAGE_FORCE_BUILD || fileConfig.OPENCLAW_BROWSER_IMAGE_FORCE_BUILD || defaults.OPENCLAW_BROWSER_IMAGE_FORCE_BUILD,
    OPENCLAW_NETWORK: process.env.OPENCLAW_NETWORK || fileConfig.OPENCLAW_NETWORK || defaults.OPENCLAW_NETWORK,
    OPENCLAW_CONTAINER_PREFIX: process.env.OPENCLAW_CONTAINER_PREFIX || fileConfig.OPENCLAW_CONTAINER_PREFIX || defaults.OPENCLAW_CONTAINER_PREFIX,
    OPENCLAW_PORT: process.env.OPENCLAW_PORT || fileConfig.OPENCLAW_PORT || defaults.OPENCLAW_PORT,
    OPENCLAW_HOST_PORT_BASE: process.env.OPENCLAW_HOST_PORT_BASE || fileConfig.OPENCLAW_HOST_PORT_BASE || defaults.OPENCLAW_HOST_PORT_BASE,
    OPENCLAW_HOST_PORT_BIND: process.env.OPENCLAW_HOST_PORT_BIND || fileConfig.OPENCLAW_HOST_PORT_BIND || defaults.OPENCLAW_HOST_PORT_BIND,
    OPENCLAW_CONTAINER_MEMORY_MB: process.env.OPENCLAW_CONTAINER_MEMORY_MB || fileConfig.OPENCLAW_CONTAINER_MEMORY_MB || defaults.OPENCLAW_CONTAINER_MEMORY_MB,
    OPENCLAW_CONTAINER_CPUS: process.env.OPENCLAW_CONTAINER_CPUS || fileConfig.OPENCLAW_CONTAINER_CPUS || defaults.OPENCLAW_CONTAINER_CPUS,
    OPENCLAW_PUBLIC_PROTOCOL: process.env.OPENCLAW_PUBLIC_PROTOCOL || fileConfig.OPENCLAW_PUBLIC_PROTOCOL || defaults.OPENCLAW_PUBLIC_PROTOCOL,
    OPENCLAW_PUBLIC_HOST: process.env.OPENCLAW_PUBLIC_HOST || fileConfig.OPENCLAW_PUBLIC_HOST || defaults.OPENCLAW_PUBLIC_HOST,
    OPENCLAW_WS_PATH: process.env.OPENCLAW_WS_PATH || fileConfig.OPENCLAW_WS_PATH || defaults.OPENCLAW_WS_PATH,
    OPENCLAW_MAX_USERS: process.env.OPENCLAW_MAX_USERS || fileConfig.OPENCLAW_MAX_USERS || defaults.OPENCLAW_MAX_USERS,
    OPENCLAW_INITIAL_TENANTS: process.env.OPENCLAW_INITIAL_TENANTS || fileConfig.OPENCLAW_INITIAL_TENANTS || defaults.OPENCLAW_INITIAL_TENANTS,
    OPENCLAW_MAX_TENANTS: process.env.OPENCLAW_MAX_TENANTS || fileConfig.OPENCLAW_MAX_TENANTS || defaults.OPENCLAW_MAX_TENANTS,
    OPENCLAW_CPUSETS: process.env.OPENCLAW_CPUSETS || fileConfig.OPENCLAW_CPUSETS || defaults.OPENCLAW_CPUSETS,
    OPENCLAW_TOKEN_PREFIX: process.env.OPENCLAW_TOKEN_PREFIX || fileConfig.OPENCLAW_TOKEN_PREFIX || defaults.OPENCLAW_TOKEN_PREFIX,
    OPENCLAW_DATA_VOLUME_PREFIX: process.env.OPENCLAW_DATA_VOLUME_PREFIX || fileConfig.OPENCLAW_DATA_VOLUME_PREFIX || defaults.OPENCLAW_DATA_VOLUME_PREFIX,
    OPENCLAW_HOST_DATA_DIR: process.env.OPENCLAW_HOST_DATA_DIR || fileConfig.OPENCLAW_HOST_DATA_DIR || defaults.OPENCLAW_HOST_DATA_DIR,
    OPENCLAW_CONTAINER_DATA_DIR: process.env.OPENCLAW_CONTAINER_DATA_DIR || fileConfig.OPENCLAW_CONTAINER_DATA_DIR || defaults.OPENCLAW_CONTAINER_DATA_DIR,
    OPENCLAW_WATTCLAW_HOST_DIR: process.env.OPENCLAW_WATTCLAW_HOST_DIR || fileConfig.OPENCLAW_WATTCLAW_HOST_DIR || defaults.OPENCLAW_WATTCLAW_HOST_DIR,
    OPENCLAW_WATTCLAW_CONTAINER_DIR: process.env.OPENCLAW_WATTCLAW_CONTAINER_DIR || fileConfig.OPENCLAW_WATTCLAW_CONTAINER_DIR || defaults.OPENCLAW_WATTCLAW_CONTAINER_DIR,
    OPENCLAW_AGENTS_SHARE_HOST_DIR: process.env.OPENCLAW_AGENTS_SHARE_HOST_DIR || fileConfig.OPENCLAW_AGENTS_SHARE_HOST_DIR || defaults.OPENCLAW_AGENTS_SHARE_HOST_DIR,
    OPENCLAW_AGENTS_SHARE_CONTAINER_DIR: process.env.OPENCLAW_AGENTS_SHARE_CONTAINER_DIR || fileConfig.OPENCLAW_AGENTS_SHARE_CONTAINER_DIR || defaults.OPENCLAW_AGENTS_SHARE_CONTAINER_DIR,
    OPENCLAW_LARK_AUTO_INSTALL: process.env.OPENCLAW_LARK_AUTO_INSTALL || fileConfig.OPENCLAW_LARK_AUTO_INSTALL || defaults.OPENCLAW_LARK_AUTO_INSTALL,
    OPENCLAW_LARK_PACKAGE: process.env.OPENCLAW_LARK_PACKAGE || fileConfig.OPENCLAW_LARK_PACKAGE || defaults.OPENCLAW_LARK_PACKAGE,
    OPENCLAW_LARK_PATCH_DIR: process.env.OPENCLAW_LARK_PATCH_DIR || fileConfig.OPENCLAW_LARK_PATCH_DIR || defaults.OPENCLAW_LARK_PATCH_DIR,
    OPENCLAW_LARK_FAIL_ON_ERROR: process.env.OPENCLAW_LARK_FAIL_ON_ERROR || fileConfig.OPENCLAW_LARK_FAIL_ON_ERROR || defaults.OPENCLAW_LARK_FAIL_ON_ERROR,
    OPENCLAW_DIST_MONITOR_TARGET: process.env.OPENCLAW_DIST_MONITOR_TARGET || fileConfig.OPENCLAW_DIST_MONITOR_TARGET || defaults.OPENCLAW_DIST_MONITOR_TARGET,
    OPENCLAW_WEB_SEARCH_PROVIDER: process.env.OPENCLAW_WEB_SEARCH_PROVIDER || fileConfig.OPENCLAW_WEB_SEARCH_PROVIDER || defaults.OPENCLAW_WEB_SEARCH_PROVIDER,
    OPENCLAW_WEB_SEARCH_ENABLED: process.env.OPENCLAW_WEB_SEARCH_ENABLED || fileConfig.OPENCLAW_WEB_SEARCH_ENABLED || defaults.OPENCLAW_WEB_SEARCH_ENABLED,
    OPENCLAW_WEB_SEARCH_MAX_RESULTS: process.env.OPENCLAW_WEB_SEARCH_MAX_RESULTS || fileConfig.OPENCLAW_WEB_SEARCH_MAX_RESULTS || defaults.OPENCLAW_WEB_SEARCH_MAX_RESULTS,
    BRAVE_API_KEY: process.env.BRAVE_API_KEY || fileConfig.BRAVE_API_KEY || defaults.BRAVE_API_KEY,
    DEV_FRONTEND_URL: process.env.DEV_FRONTEND_URL || fileConfig.DEV_FRONTEND_URL || defaults.DEV_FRONTEND_URL,
    AUTH_USERNAME: process.env.AUTH_USERNAME || fileConfig.AUTH_USERNAME || defaults.AUTH_USERNAME,
    AUTH_PASSWORD: process.env.AUTH_PASSWORD || fileConfig.AUTH_PASSWORD || defaults.AUTH_PASSWORD,
    FEISHU_BOT_CREDENTIAL_KEY: process.env.FEISHU_BOT_CREDENTIAL_KEY || fileConfig.FEISHU_BOT_CREDENTIAL_KEY || defaults.FEISHU_BOT_CREDENTIAL_KEY,
    MEDIA_DIR: process.env.MEDIA_DIR || fileConfig.MEDIA_DIR || defaults.MEDIA_DIR,
    LOG_LEVEL: process.env.LOG_LEVEL || fileConfig.LOG_LEVEL || defaults.LOG_LEVEL,
    XFYUN_APP_ID: process.env.XFYUN_APP_ID || fileConfig.XFYUN_APP_ID || defaults.XFYUN_APP_ID,
    XFYUN_API_KEY: process.env.XFYUN_API_KEY || fileConfig.XFYUN_API_KEY || defaults.XFYUN_API_KEY,
    XFYUN_API_SECRET: process.env.XFYUN_API_SECRET || fileConfig.XFYUN_API_SECRET || defaults.XFYUN_API_SECRET,
    GATEWAY_SSH_USER: process.env.GATEWAY_SSH_USER || fileConfig.GATEWAY_SSH_USER || defaults.GATEWAY_SSH_USER,
    GATEWAY_MEDIA_DIR: process.env.GATEWAY_MEDIA_DIR || fileConfig.GATEWAY_MEDIA_DIR || defaults.GATEWAY_MEDIA_DIR,
    GATEWAY_SKILLS_STORE_PATH: process.env.GATEWAY_SKILLS_STORE_PATH || fileConfig.GATEWAY_SKILLS_STORE_PATH || defaults.GATEWAY_SKILLS_STORE_PATH,
    MODEL_HEALTH_CHECK_ENABLED: process.env.MODEL_HEALTH_CHECK_ENABLED || fileConfig.MODEL_HEALTH_CHECK_ENABLED || defaults.MODEL_HEALTH_CHECK_ENABLED,
    MODEL_HEALTH_INTERVAL_MS: process.env.MODEL_HEALTH_INTERVAL_MS || fileConfig.MODEL_HEALTH_INTERVAL_MS || defaults.MODEL_HEALTH_INTERVAL_MS,
    MODEL_HEALTH_TIMEOUT_MS: process.env.MODEL_HEALTH_TIMEOUT_MS || fileConfig.MODEL_HEALTH_TIMEOUT_MS || defaults.MODEL_HEALTH_TIMEOUT_MS,
    MODEL_HEALTH_MAX_RETRIES: process.env.MODEL_HEALTH_MAX_RETRIES || fileConfig.MODEL_HEALTH_MAX_RETRIES || defaults.MODEL_HEALTH_MAX_RETRIES,
    MODEL_HEALTH_MAX_TOKENS: process.env.MODEL_HEALTH_MAX_TOKENS || fileConfig.MODEL_HEALTH_MAX_TOKENS || defaults.MODEL_HEALTH_MAX_TOKENS,
    MODEL_HEALTH_INITIAL_DELAY_MS: process.env.MODEL_HEALTH_INITIAL_DELAY_MS || fileConfig.MODEL_HEALTH_INITIAL_DELAY_MS || defaults.MODEL_HEALTH_INITIAL_DELAY_MS,
    OPENCLAW_HERMES_ENABLED: process.env.OPENCLAW_HERMES_ENABLED || fileConfig.OPENCLAW_HERMES_ENABLED || defaults.OPENCLAW_HERMES_ENABLED,
    OPENCLAW_HERMES_MODE: process.env.OPENCLAW_HERMES_MODE || fileConfig.OPENCLAW_HERMES_MODE || defaults.OPENCLAW_HERMES_MODE,
    HERMES_IMAGE: process.env.HERMES_IMAGE || fileConfig.HERMES_IMAGE || defaults.HERMES_IMAGE,
    HERMES_RUNTIME_IMAGE: process.env.HERMES_RUNTIME_IMAGE || fileConfig.HERMES_RUNTIME_IMAGE || defaults.HERMES_RUNTIME_IMAGE,
    HERMES_DEFAULT_MODEL: process.env.HERMES_DEFAULT_MODEL || fileConfig.HERMES_DEFAULT_MODEL || defaults.HERMES_DEFAULT_MODEL,
    HERMES_ACP_CMD: process.env.HERMES_ACP_CMD || fileConfig.HERMES_ACP_CMD || defaults.HERMES_ACP_CMD,
    OPENCLAW_HERMES_CONTAINER_PREFIX: process.env.OPENCLAW_HERMES_CONTAINER_PREFIX || fileConfig.OPENCLAW_HERMES_CONTAINER_PREFIX || defaults.OPENCLAW_HERMES_CONTAINER_PREFIX,
    OPENCLAW_HERMES_ACP_PORT: process.env.OPENCLAW_HERMES_ACP_PORT || fileConfig.OPENCLAW_HERMES_ACP_PORT || defaults.OPENCLAW_HERMES_ACP_PORT,
    OPENCLAW_HERMES_DATA_DIR: process.env.OPENCLAW_HERMES_DATA_DIR || fileConfig.OPENCLAW_HERMES_DATA_DIR || defaults.OPENCLAW_HERMES_DATA_DIR,
    OPENCLAW_HERMES_CONTAINER_MEMORY_MB: process.env.OPENCLAW_HERMES_CONTAINER_MEMORY_MB || fileConfig.OPENCLAW_HERMES_CONTAINER_MEMORY_MB || defaults.OPENCLAW_HERMES_CONTAINER_MEMORY_MB,
    OPENCLAW_HERMES_CONTAINER_CPUS: process.env.OPENCLAW_HERMES_CONTAINER_CPUS || fileConfig.OPENCLAW_HERMES_CONTAINER_CPUS || defaults.OPENCLAW_HERMES_CONTAINER_CPUS,
    OPENCLAW_HERMES_BUILD_CONTEXT_DIR: process.env.OPENCLAW_HERMES_BUILD_CONTEXT_DIR || fileConfig.OPENCLAW_HERMES_BUILD_CONTEXT_DIR || defaults.OPENCLAW_HERMES_BUILD_CONTEXT_DIR,
    OPENCLAW_HERMES_PLUGIN_DIR: process.env.OPENCLAW_HERMES_PLUGIN_DIR || fileConfig.OPENCLAW_HERMES_PLUGIN_DIR || defaults.OPENCLAW_HERMES_PLUGIN_DIR,
    OPENCLAW_HERMES_PLUGIN_AUTO_INSTALL: process.env.OPENCLAW_HERMES_PLUGIN_AUTO_INSTALL || fileConfig.OPENCLAW_HERMES_PLUGIN_AUTO_INSTALL || defaults.OPENCLAW_HERMES_PLUGIN_AUTO_INSTALL,
    OPENCLAW_HERMES_PLUGIN_FAIL_ON_ERROR: process.env.OPENCLAW_HERMES_PLUGIN_FAIL_ON_ERROR || fileConfig.OPENCLAW_HERMES_PLUGIN_FAIL_ON_ERROR || defaults.OPENCLAW_HERMES_PLUGIN_FAIL_ON_ERROR,
    OPENCLAW_HERMES_PLUGIN_INSTALL_TIMEOUT_MS: process.env.OPENCLAW_HERMES_PLUGIN_INSTALL_TIMEOUT_MS || fileConfig.OPENCLAW_HERMES_PLUGIN_INSTALL_TIMEOUT_MS || defaults.OPENCLAW_HERMES_PLUGIN_INSTALL_TIMEOUT_MS,
    OPENCLAW_HERMES_PLUGIN_RETRY_COOLDOWN_MS: process.env.OPENCLAW_HERMES_PLUGIN_RETRY_COOLDOWN_MS || fileConfig.OPENCLAW_HERMES_PLUGIN_RETRY_COOLDOWN_MS || defaults.OPENCLAW_HERMES_PLUGIN_RETRY_COOLDOWN_MS,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || fileConfig.OPENAI_API_KEY || defaults.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || fileConfig.OPENAI_BASE_URL || defaults.OPENAI_BASE_URL,
  }
}

const envConfig = loadEnvConfig()
setEnvConfig(envConfig)
initMonitorConfig()

const isDebug = envConfig.LOG_LEVEL === 'DEBUG'
function debug(...args) {
  if (isDebug) console.log('[DEBUG]', ...args)
}

const app = express()
const server = createServer(app)
attachXfyunSpeechProxy(server, envConfig)

const distPath = join(__dirname, '../dist')
const hasDist = existsSync(join(distPath, 'index.html'))
const sharedDir = join(__dirname, '..', 'data', 'shared')
mkdirSync(sharedDir, { recursive: true })

app.use(cors())
app.use(express.json({ limit: '5mb' }))

// ── Gateway initialization ──
const gateway = envConfig.OPENCLAW_MULTI_TENANT === 'false'
  ? new OpenClawGateway(envConfig.OPENCLAW_WS_URL, envConfig.OPENCLAW_AUTH_TOKEN, envConfig.OPENCLAW_AUTH_PASSWORD, envConfig.LOG_LEVEL)
  : initMultiTenantGateway(envConfig)
setGateway(gateway)
initGatewayClient(gateway, envConfig)

initDefaultAdmin(envConfig.AUTH_USERNAME, envConfig.AUTH_PASSWORD)

// Clean up stale stream IDs every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of streamIdMap) {
    if (now - entry.startTime > 10 * 60 * 1000) {
      streamIdMap.delete(id)
    }
  }
}, 5 * 60 * 1000)

let gatewayVersion = null
let updateInfo = null
let modelsBackfilled = false
const wattClawProjectTenantCache = new Map()
const wattClawRetentionRuns = new Map()
let wattClawRetentionTimer = null

function broadcastWattClawProjectsChanged(tenantId = '', reason = 'updated') {
  for (const [clientId, client] of sseClients) {
    if (!client.isAdmin && tenantId && client.tenantId !== tenantId) continue
    sendSSEToClient(clientId, {
      type: 'event',
      event: 'wattclaw.team.projects.changed',
      payload: { reason },
    })
  }
}

async function runWattClawRetentionForTenant(tenantId = '') {
  const retentionKey = tenantId || 'default'
  const activeRun = wattClawRetentionRuns.get(retentionKey)
  if (activeRun) return activeRun

  let projectAccessStates = new Map()
  try {
    projectAccessStates = getWattClawProjectAccessStatesForRetention()
  } catch (error) {
    console.warn('[WattClawRetention] failed to read project access state:', error?.message || error)
  }

  const gatewayRpc = tenantId && envConfig.OPENCLAW_MULTI_TENANT !== 'false'
    ? (method, params) => callGatewayForTenant(tenantId, method, params, 120000)
    : (method, params) => gateway.call(method, params, 120000)
  const run = pruneWattClawProjectsForUser({
    gatewayRpc,
    projectAccessStates,
  }).then((result) => {
    for (const projectId of result.archived) {
      markWattClawProjectArchivedForRetention(projectId)
    }
    return result
  }).finally(() => {
    if (wattClawRetentionRuns.get(retentionKey) === run) wattClawRetentionRuns.delete(retentionKey)
  })
  wattClawRetentionRuns.set(retentionKey, run)
  return run
}

async function runScheduledWattClawRetention() {
  const tenantIds = envConfig.OPENCLAW_MULTI_TENANT === 'false'
    ? ['']
    : listOpenClawTenants()
      .filter(tenant => tenant.status === 'active')
      .map(tenant => tenant.id)
  const summary = { tenants: tenantIds.length, scanned: 0, archived: 0, failed: 0 }
  for (const tenantId of tenantIds) {
    try {
      const result = await runWattClawRetentionForTenant(tenantId)
      summary.scanned += result.scanned
      summary.archived += result.archived.length
      summary.failed += result.failed.length
      if (result.archived.length > 0) {
        broadcastWattClawProjectsChanged(tenantId, 'retention')
      }
    } catch (error) {
      summary.failed += 1
      console.warn('[WattClawRetention] scheduled tenant cleanup failed:', {
        tenantId: tenantId || null,
        error: error?.message || error,
      })
    }
  }
  console.log('[WattClawRetention] scheduled cleanup completed:', summary)
  return summary
}

function scheduleWattClawRetention() {
  const now = Date.now()
  const nextRunAt = nextWattClawRetentionRunAt(now)
  console.log('[WattClawRetention] next cleanup:', new Date(nextRunAt).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  }))
  wattClawRetentionTimer = setTimeout(async () => {
    try {
      await runScheduledWattClawRetention()
    } catch (error) {
      console.error('[WattClawRetention] scheduled cleanup failed:', error?.message || error)
    } finally {
      scheduleWattClawRetention()
    }
  }, nextRunAt - now)
  wattClawRetentionTimer.unref?.()
}

function registerWattClawProjectForUser(project, userId) {
  return trackWattClawProjectOwnership({
    project,
    agents: [],
    userId,
    trackAgent: trackAgentForUser,
    trackSession: trackSessionForUser,
  })
}

function captureAdminOwnedWattClawProjectTemplate(project, userId) {
  if (!project?.id || !userId) return null
  const match = getProjectTemplateMatch(project.id, userId)
  if (!match || match.userId !== userId) return null
  return captureSuccessfulProjectTemplateCandidate({ project, userId })
}

const wattClawProjectEvents = createWattClawProjectEventService({
  publish({ clientIds, event, payload }) {
    if (event === 'wattclaw.team.project.updated' && payload.project) {
      const registeredUsers = new Set()
      for (const clientId of clientIds) {
        const client = sseClients.get(clientId)
        if (!client || registeredUsers.has(client.userId)) continue
        if (client.isAdmin) {
          if (String(payload.project.status || '').trim().toLowerCase() === 'success') {
            try {
              captureAdminOwnedWattClawProjectTemplate(payload.project, client.userId)
            } catch (error) {
              console.error('[WattClawProjectEvents] Failed to capture admin project template:', {
                projectId: payload.projectId,
                userId: client.userId,
                error: error?.message || String(error),
              })
            } finally {
              releaseProjectMemberBindings(payload.project.id, client.userId)
            }
          }
          registeredUsers.add(client.userId)
          continue
        }
        try {
          registerWattClawProjectForUser(payload.project, client.userId)
          if (String(payload.project.status || '').trim().toLowerCase() === 'success') {
            try {
              captureSuccessfulProjectTemplateCandidate({
                project: payload.project,
                userId: client.userId,
              })
            } finally {
              releaseProjectMemberBindings(payload.project.id, client.userId)
            }
          }
        } catch (error) {
          console.error('[WattClawProjectEvents] Failed to register project members:', {
            projectId: payload.projectId,
            userId: client.userId,
            error: error?.message || String(error),
          })
        }
        registeredUsers.add(client.userId)
      }
    }
    for (const clientId of clientIds) {
      sendSSEToClient(clientId, { type: 'event', event, payload })
    }
  },
})

async function resolveWattClawProjectTenant(projectId) {
  if (!projectId) return null
  const cached = wattClawProjectTenantCache.get(projectId)
  if (cached) return cached

  const outcomes = await callGatewayForAllTenants('wattclaw.team.project.get', { id: projectId })
  if (!outcomes) return null
  for (const outcome of outcomes) {
    if (!outcome.ok) continue
    const project = extractWattClawProject(outcome.value)
    if (project?.id === projectId && outcome.tenantId) {
      wattClawProjectTenantCache.set(projectId, outcome.tenantId)
      return outcome.tenantId
    }
  }
  return null
}

async function authorizeWattClawProjectSubscription(req, projectId) {
  const isAdmin = req.currentUser.role === 'admin'
  const tenantId = isAdmin
    ? await resolveWattClawProjectTenant(projectId)
    : req.currentTenant?.id || null
  const result = isAdmin && tenantId
    ? await callGatewayForTenant(tenantId, 'wattclaw.team.project.get', { id: projectId })
    : await gateway.call('wattclaw.team.project.get', { id: projectId })
  const project = extractWattClawProject(result)

  if (!project) {
    const error = new Error(`WattClaw project not found: ${projectId}`)
    error.statusCode = 404
    throw error
  }
  if (!isAdmin && !userOwnsWattClawProject(project, getUserOwnedAgentIds(req.currentUser.id))) {
    const error = new Error('Access denied')
    error.statusCode = 403
    throw error
  }

  return { project, tenantId }
}

// ── Gateway lifecycle helpers ──

async function backfillAgentModels() {
  try {
    if (modelsBackfilled) {
      debug('[Backfill] Already backfilled models, skipping')
      return
    }
    let cfgResult = null
    {
      const rpcResult = await gatewayAdminRpc('config.get', {})
      cfgResult = rpcResult.ok ? rpcResult.payload : null
    }
    const payload = cfgResult || {}
    const gatewayConfig = payload.sourceConfig || payload.config || payload.parsed || {}
    const primaryModel = gatewayConfig?.models?.primary || gatewayConfig?.agents?.defaults?.model?.primary || ''
    if (!primaryModel) {
      console.log('[Backfill] No primary model found in Gateway config')
      return
    }
    const agents = getAgentsWithoutModel()
    if (agents.length === 0) {
      console.log('[Backfill] No agents without model found')
      modelsBackfilled = true
      return
    }
    console.log(`[Backfill] Found ${agents.length} agents without model, setting to ${primaryModel}`)
    const updatedCount = backfillAgentModel(primaryModel)
    console.log(`[Backfill] Updated ${updatedCount} agents`)
    modelsBackfilled = true
  } catch (err) {
    console.error('[Backfill] error:', err.message)
  }
}

async function syncSessionsFromGateway() {
  // No longer calls refreshAllSessionsCache() — the 9s polling was removed.
  // user_sessions table is already kept up-to-date by SSE event handlers
  // (trackSessionForUser) and session ownership checks (isSessionOwned).
  // We keep this function as a no-op hook for future one-time syncs if needed.
  console.log('[SessionSync] Skipped — using on-demand local DB queries')
}

async function syncAgentWorkspacesFromGateway() {
  const rpcResult = await gatewayAdminRpc('agents.list')
  if (!rpcResult.ok) {
    throw new Error(rpcResult.error?.message || rpcResult.error || 'agents.list failed')
  }

  const result = backfillAgentWorkspacesFromGatewayAgents(rpcResult.payload)
  console.log(`[AgentWorkspaceSync] scanned=${result.scanned} updated=${result.updated} skipped=${result.skipped}`)
}

async function refreshSessionFromGateway(sessionKey) {
  if (!isMessageStoreReady()) return
  try {
    if (!isExternalChannelSession(sessionKey)) return

    const messages = await fetchHistoryFromGateway(sessionKey, 1000)
    console.log(`[MessageStore] refreshSessionFromGateway ${sessionKey}: fetched=${messages.length} from Gateway`)
    if (messages.length > 0) {
      const result = await mergeSessionMessages(sessionKey, messages)
      console.log(`[MessageStore] refreshSessionFromGateway ${sessionKey}: merged`, result)
    } else {
      await dedupSessionMessages(sessionKey)
    }
  } catch (err) {
    console.error('[MessageStore] refreshSessionFromGateway error:', err.message)
  }
}

// ── Auto-title for channel sessions ──
const _autoTitleInFlight = new Set()
const _titleRowStmt = db.prepare(
  'SELECT display_title, peer_id, channel FROM user_sessions WHERE session_key = ? LIMIT 1'
)

function safeTrackSessionForUser(userId, sessionKey, agentId, label, channel) {
  try {
    trackSessionForUser(userId, sessionKey, agentId, label, channel)
  } catch (err) {
    console.error('[SessionTrack] failed:', err.message)
  }
}

async function tryAutoTitleForChannelSession(sessionKey) {
  if (_autoTitleInFlight.has(sessionKey)) return
  _autoTitleInFlight.add(sessionKey)
  try {
    const parts = sessionKey.split(':')
    const agentId = parts[1]
    // 外部 channel session（agent:agentId:channel:peer，4+ 段）channel 取 parts[2]；
    // 移动端 webchat 等内部 session（agent:agentId:uuid，3 段）channel 留空，稍后取 DB 值，避免把 uuid 当 channel
    let channel = parts.length >= 4 ? (parts[2] || null) : null
    const peerId = parts.length >= 5 ? parts.slice(4).join(':') : null
    if (!agentId) return

    // 外部渠道 session 才要求 agent 配置了对应外部渠道；
    // 移动端 webchat 等内部 session(agent:agentId:uuid)无外部渠道，仍需从首条消息生成标题。
    if (channel !== null) {
      const channels = getChannelsByAgentId(agentId)
      if (!channels || channels.length === 0) return
    }

    const userIds = getUserIdsByAgentId(agentId)
    if (userIds.length === 0) return

    const titleRow = _titleRowStmt.get(sessionKey)
    // 移动端 webchat 等内部 session 的 channel 取 DB 值（webchat → 在线对话），不依赖 sessionKey 段解析
    if (!channel && titleRow?.channel) {
      channel = titleRow.channel
    }
    if (titleRow && !shouldBackfillDisplayTitle(titleRow.display_title, titleRow.peer_id || peerId)) return

    const httpResult = await gatewayHttpGet(
      `/sessions/${encodeURIComponent(sessionKey)}/history`,
      { limit: 10 }
    )
    if (!httpResult.ok) return

    let messages
    const data = httpResult.data
    if (Array.isArray(data)) {
      messages = data
    } else if (data && typeof data === 'object') {
      messages = data.messages || data.history || data.items || data.payload || []
    }
    if (!Array.isArray(messages)) return

    const TS_RE = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/
    for (const msg of messages) {
      if (msg.role !== 'user') continue
      let content = normalizeContent(msg.content)
      if (!content) continue
      if (content.startsWith('[Bootstrap')) {
        content = extractUserMessageFromBootstrap(content)
      }
      content = content.replace(TS_RE, '').trim()
      if (!content) continue

      const title = resolveSessionDisplayTitle({
        channel,
        peerProfile: null,
        firstUserMessage: content,
      })
      for (const uid of userIds) {
        upsertExternalSessionProjection({
          userId: uid,
          sessionKey,
          agentId,
          channel,
          peer: peerId,
          title,
          lastActivity: msg.timestamp || null,
        })
      }
      console.log(`[AutoTitle] Resolved display title for channel session ${sessionKey}: "${title}"`)
      return
    }
  } catch (err) {
    debug('[AutoTitle] Failed for %s: %s', sessionKey, err.message)
  } finally {
    _autoTitleInFlight.delete(sessionKey)
  }
}

// ── Token update push (delegates to usage-sync debounce) ──
const TOKEN_UPDATE_COOLDOWN_MS = 1000

function pushTokenUpdate(sessionKey) {
  scheduleSessionUsageSync(sessionKey, { delayMs: TOKEN_UPDATE_COOLDOWN_MS })
}

function broadcastSessionMessageActivity(sessionKey, payload) {
  if (!sessionKey) return
  const message = payload?.message && typeof payload.message === 'object'
    ? payload.message
    : null
  const messageId = payload?.messageId
    || payload?.message_id
    || message?.__openclaw?.id
    || message?.id
  const messageSeq = payload?.messageSeq ?? payload?.message_seq ?? payload?.seq ?? message?.__openclaw?.seq
  const activityPayload = {
    sessionKey,
    messageDelta: 1,
    ...(messageId !== undefined && messageId !== null ? { messageId: String(messageId) } : {}),
    ...(messageSeq !== undefined && messageSeq !== null ? { messageSeq } : {}),
    ...(payload?.tenantId ? { tenantId: payload.tenantId } : {}),
  }
  broadcastSSE(
    { type: 'event', event: 'session.message.activity', payload: activityPayload },
    activityPayload,
  )
}

// ── Polling caches ──
// REMOVED: skillsStatusPolling — now using on-demand sync via /api/skill-store/scan
// See server/handlers/skill-store.js for bootstrapSkillsCache()


// ── Gateway event handlers ──
gateway.on('connected', () => {
  console.log('[Gateway] Connected to OpenClaw')
  syncModelsFromGateway().catch(err => console.error('[Models] sync error:', err.message))
  syncSessionsFromGateway().then(() => syncUsageFromGatewayOnStartup()).catch(err => {
    console.error('[UsageStartupSync] Failed:', err?.message || err)
  })
  backfillAgentModels()
  syncCronFromGateway(gatewayAdminRpc).catch(err => console.error('[Cron] sync error:', err.message))
  // Bootstrap model providers:Gateway→DB 幂等同步(替代原 list 接口内的 migration),补 DB 缺失项
  syncGatewayProvidersToDB().catch(err => console.error('[ModelProviders] sync error:', err.message))
  // Bootstrap skill cache once on first connection (replaces 17s polling)
  import('./handlers/skill-store.js').then(m => m.bootstrapSkillsCache?.())
})

gateway.on('version', (info) => {
  debug('Gateway version info:', info)
  updateInfo = info
  gatewayVersion = info.currentVersion
  setGatewayVersion(info.currentVersion)
  setUpdateInfo(info)
  broadcastSSE({ type: 'gatewayState', state: 'connected', version: info.currentVersion, updateAvailable: info })
})

gateway.on('disconnected', () => {
  console.log('[Gateway] Disconnected from OpenClaw')
  gatewayVersion = null
  setGatewayVersion(null)
  broadcastSSE({ type: 'gatewayState', state: 'disconnected' })
})

gateway.on('error', (err) => {
  console.error('[Gateway] Error:', err.message)
  debug('Error stack:', err.stack)
})

gateway.on('event', (event, payload) => {
  debug('Gateway event:', event, 'payload keys:', payload ? Object.keys(payload) : null)
  const eventSessionKey = payload?.sessionKey || payload?.session_key || payload?.key || ''
  if (event === 'session.message') {
    syncWattClawProjectMessage(payload).catch(err => {
      console.error('[FeishuProjectSync] event handling failed:', err.message)
    })
  }
  if (payload) {
    const sk = payload.sessionKey || payload.session_key || payload.key || ''
    if (event === 'agent' || event === 'chat' || event.startsWith('agent.') || event.startsWith('chat.')) {
      const stream = payload.stream || payload.data?.stream || ''
      const phase = payload.phase || payload.data?.phase || ''
      const state = payload.state || payload.data?.state || ''
      const runId = payload.runId || ''
      console.log(`[Gateway-WS] event=${event} stream=${stream} phase=${phase} state=${state} sessionKey=${sk} runId=${runId}`)
    }
    if (sk) {
      const agentId = sk.match(/^agent:([^:]+):/)?.[1]
      if (agentId) {
        const userIds = getUserIdsByAgentId(agentId)
        for (const uid of userIds) {
          safeTrackSessionForUser(uid, sk, agentId)
        }
      }
      const stream = payload.stream || payload.data?.stream
      const phase = payload.phase || payload.data?.phase
      if ((stream === 'lifecycle' && phase === 'end') || event === 'agent.done') {
        tryAutoTitleForChannelSession(sk)
        pushTokenUpdate(sk)
      }
      const chatState = (typeof payload.state === 'string' ? payload.state : '') ||
        (payload.data && typeof payload.data.state === 'string' ? payload.data.state : '')
      const isChatCompletion = event === 'chat.done' || event === 'chat.final' ||
        (event === 'chat' && chatState === 'final')
      if (isChatCompletion) {
        pushTokenUpdate(sk)
      }
      if (isChatCompletion) {
        // 外部渠道会话由 message-sync 增量写入，跳过全量替换避免竞争
        if (isExternalChannelSession(sk)) return
        refreshSessionFromGateway(sk).catch(err =>
          console.error('[MessageStore] refresh error:', err.message)
        )
      }
    }
  }
  // session.message 对 WattClaw 内部会话不回传正文，但发送轻量活动事件供协作诊断同步消息数；
  // 外部渠道（飞书等）仍正常推送正文。
  if (event === 'session.message' && !isExternalChannelSession(eventSessionKey)) {
    broadcastSessionMessageActivity(eventSessionKey, payload)
    return
  }
  broadcastSSE({ type: 'event', event, payload }, payload)
})

gateway.on('stateChange', (state) => {
  debug('Gateway state changed to:', state)
  broadcastSSE({ type: 'gatewayState', state })
})

gateway.on('tenantState', (payload) => {
  broadcastSSE(
    { type: 'tenantState', tenantId: payload.tenantId, state: payload.state },
    payload
  )
})

debug('Connecting to Gateway at:', envConfig.OPENCLAW_WS_URL)
// 挂载外部渠道消息同步模块
attachMessageSync(gateway, db)
gateway.connect().catch(err => {
  console.error('[Gateway] initial connect failed:', err.message)
})

// Register Gateway reconnection callback for system.js config changes
setReconnectGatewayFn(() => {
  console.log('[Config] Reconnecting to Gateway with new config...')
  gateway.disconnect()
  if (envConfig.OPENCLAW_MULTI_TENANT !== 'false') {
    console.log('[Config] Reconnecting OpenClaw tenant gateways...')
    gateway.connect()
      .then(() => {
        syncModelsFromGateway().catch(err => console.error('[Models] sync error:', err.message))
        syncSessionsFromGateway()
        backfillAgentModels()
        syncCronFromGateway(gatewayAdminRpc).catch(err => console.error('[Cron] sync error:', err.message))
      })
      .catch(err => console.error('[Gateway] Reconnect error:', err.message))
    return
  }
  const newGw = new OpenClawGateway(envConfig.OPENCLAW_WS_URL, envConfig.OPENCLAW_AUTH_TOKEN, envConfig.OPENCLAW_AUTH_PASSWORD, envConfig.LOG_LEVEL)

  newGw.on('connected', () => {
    console.log('[Gateway] Re-connected to OpenClaw')
    syncModelsFromGateway().catch(err => console.error('[Models] sync error:', err.message))
    syncSessionsFromGateway()
    backfillAgentModels()
    syncCronFromGateway(gatewayAdminRpc).catch(err => console.error('[Cron] sync error:', err.message))
    syncGatewayProvidersToDB().catch(err => console.error('[ModelProviders] sync error:', err.message))
  })
  newGw.on('version', (info) => {
    debug('Gateway version info:', info)
    gatewayVersion = info.currentVersion
    setGatewayVersion(info.currentVersion)
    setUpdateInfo(info)
    broadcastSSE({ type: 'gatewayState', state: 'connected', version: info.currentVersion, updateAvailable: info })
  })
  newGw.on('disconnected', () => {
    console.log('[Gateway] Disconnected from OpenClaw')
    gatewayVersion = null
    setGatewayVersion(null)
    broadcastSSE({ type: 'gatewayState', state: 'disconnected' })
  })
  newGw.on('error', (err) => console.error('[Gateway] Error:', err.message))
  newGw.on('event', (event, payload) => {
    debug('Gateway event:', event)
    const eventSessionKey = payload?.sessionKey || payload?.session_key || payload?.key || ''
    if (event === 'session.message') {
      syncWattClawProjectMessage(payload).catch(err => {
        console.error('[FeishuProjectSync] event handling failed:', err.message)
      })
    }
    if (payload) {
      const sk = payload.sessionKey || payload.session_key || payload.key || ''
      if (sk) {
        const agentId = sk.match(/^agent:([^:]+):/)?.[1]
        if (agentId) {
          const userIds = getUserIdsByAgentId(agentId)
          for (const uid of userIds) safeTrackSessionForUser(uid, sk, agentId)
        }
        const stream = payload.stream || payload.data?.stream
        const phase = payload.phase || payload.data?.phase
        if ((stream === 'lifecycle' && phase === 'end') || event === 'agent.done') {
          tryAutoTitleForChannelSession(sk)
          pushTokenUpdate(sk)
        }
        const chatState = (typeof payload.state === 'string' ? payload.state : '') ||
          (payload.data && typeof payload.data.state === 'string' ? payload.data.state : '')
        const isChatCompletion = event === 'chat.done' || event === 'chat.final' ||
          (event === 'chat' && chatState === 'final')
        if (isChatCompletion) {
          pushTokenUpdate(sk)
          // 外部渠道会话由 message-sync 增量写入，跳过全量替换避免竞争
          if (isExternalChannelSession(sk)) return
          refreshSessionFromGateway(sk).catch(err => console.error('[MessageStore] refresh error:', err.message))
        }
      }
    }
    if (event === 'session.message' && !isExternalChannelSession(eventSessionKey)) {
      broadcastSessionMessageActivity(eventSessionKey, payload)
      return
    }
    broadcastSSE({ type: 'event', event, payload }, payload)
  })
  newGw.on('stateChange', (state) => {
    debug('Gateway state changed to:', state)
    broadcastSSE({ type: 'gatewayState', state })
  })

  setGateway(newGw)
  // 挂载外部渠道消息同步到新 gateway 实例
  attachMessageSync(newGw, db)
  // gateway global is now read-only in core/index.js, update the import alias
  // The handlers import { gateway } from core — they get the new instance via setGateway
  newGw.connect().catch(err => {
    console.error('[Gateway] reconnect failed:', err.message)
  })
})

setFlushPendingTokenUpdateFn((sessionKey) => {
  scheduleSessionUsageSync(sessionKey, { delayMs: 0 })
})

// ── Error translation ──
function translateGatewayError(msg) {
  if (!msg) return '未知错误'
  if (msg.includes('rate limit')) {
    const match = msg.match(/retry after (\d+)s/)
    return match ? `操作过于频繁，请 ${match[1]} 秒后重试` : '操作过于频繁，请稍后重试'
  }
  if (msg.includes('No agent bound')) return '未绑定 Agent'
  if (msg.includes('Gateway not connected')) return 'Gateway 未连接'
  if (msg.includes('timeout')) return '请求超时，请稍后重试'
  if (msg.includes('ECONNREFUSED')) return '无法连接到 Gateway'
  return msg
}

// ════════════════════════════════════════════════════════════
// Route registration — all handler modules
// ════════════════════════════════════════════════════════════

const SESSION_SYNC_GATEWAY_RPC_TIMEOUT_MS = 8_000

async function sessionSyncGatewayRpc(method, params = {}) {
  try {
    const payload = await gateway.call(method, params, SESSION_SYNC_GATEWAY_RPC_TIMEOUT_MS)
    return { ok: true, payload }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

createAuthRoutes(app)
createUserRoutes(app)
createUserAgentRoutes(app)
createAgentTeamRoutes(app)
createSessionRoutes(app, { gatewayRpc: sessionSyncGatewayRpc })
createChannelRoutes(app)
createModelProviderRoutes(app)
createModelRoutes(app)
createCronRoutes(app)
createUsageRoutes(app)
setScheduleUsageSyncFn(scheduleUsageSyncAfterRead)
createChatRoutes(app)
createFileRoutes(app)
createKnowledgeBaseRoutes(app)
createWorkspaceRoutes(app)
createSystemRoutes(app)
createTerminalRoutes(app)
createDesktopRoutes(app)
createWizardRoutes(app)
createMediaRoutes(app)
createBackupRoutes(app)
createSkillStoreRoutes(app)
createFeishuProxyRoutes(app)
createFeishuAuthRoutes(app)
createFeishuBotRoutes(app)
createDashboardStatsRoutes(app)

// Sub-routers
app.use('/api/issues', createIssuesRouter(db))
app.use('/api/notifications', createNotificationsRouter(db, broadcastGlobalSSE))
app.use('/api/avatar-images', createAvatarUploadRouter())

// 租户管理 API:多实例启用,单实例禁用(404)
if (envConfig.OPENCLAW_MULTI_TENANT === 'false') {
  app.use('/api/tenants', (_req, res) => res.status(404).end())
} else {
  createTenantRoutes(app, { authMiddleware })
}

// ════════════════════════════════════════════════════════════
// Core infrastructure routes — kept in index.js
// ════════════════════════════════════════════════════════════

// ── SSE events stream ──
app.get('/api/events', authMiddleware, (req, res) => {
  debug('[SSE] New client connecting, auth check passed')

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const clientId = randomUUID()
  const isAdminSseClient = req.currentUser.role === 'admin'
  sseClients.set(clientId, { res, userId: req.currentUser.id, tenantId: isAdminSseClient ? null : req.currentTenant?.id || null, isAdmin: isAdminSseClient, subscriptions: new Set() })
  debug('[SSE] Client connected:', clientId, 'user:', req.currentUser.username, 'total clients:', sseClients.size)

  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`)
  res.write(`data: ${JSON.stringify({ type: 'currentUser', user: req.currentUser })}\n\n`)

  const initialState = gateway.isConnected ? 'connected' : 'disconnected'
  debug('[SSE] Sending initial state to client:', clientId, 'state:', initialState, 'gatewayVersion:', gatewayVersion)
  res.write(`data: ${JSON.stringify({
    type: 'gatewayState',
    state: initialState,
    version: initialState === 'connected' ? gatewayVersion : null,
    updateAvailable: initialState === 'connected' ? updateInfo : null
  })}\n\n`)

  // 发送拥堵状态初始快照
  const congestionSnapshot = getCongestionStatus()
  const activeCongestion = Object.entries(congestionSnapshot).filter(([, s]) => s.isCongested)
  if (activeCongestion.length > 0) {
    res.write(`data: ${JSON.stringify({
      type: 'event',
      event: 'model.congestion.snapshot',
      payload: activeCongestion.map(([model, s]) => ({ model, count: s.windowCount, isCongested: true }))
    })}\n\n`)
  }

  req.on('close', () => {
    wattClawProjectEvents.unsubscribe(clientId)
    sseClients.delete(clientId)
    debug('[SSE] Client disconnected:', clientId, 'remaining clients:', sseClients.size)
  })
})

app.put('/api/events/subscriptions/wattclaw-project', authMiddleware, async (req, res) => {
  const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : ''
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : ''
  const client = sseClients.get(clientId)

  if (!clientId || !projectId) {
    return res.status(400).json({ ok: false, error: { message: 'clientId and projectId are required' } })
  }
  if (!client || client.userId !== req.currentUser.id) {
    return res.status(404).json({ ok: false, error: { message: 'SSE client not found' } })
  }

  try {
    const { project, tenantId } = await authorizeWattClawProjectSubscription(req, projectId)
    const projectDir = resolveWattClawProjectDirectory({ envConfig, tenantId, projectId })
    if (!projectDir) {
      return res.status(503).json({ ok: false, error: { message: 'Project realtime data directory is unavailable' } })
    }

    if (!client.isAdmin) registerWattClawProjectForUser(project, req.currentUser.id)
    for (const subscription of [...client.subscriptions]) {
      if (subscription.startsWith('wattclaw-project:')) client.subscriptions.delete(subscription)
    }
    client.subscriptions.add(`wattclaw-project:${projectId}`)
    wattClawProjectEvents.subscribe({ clientId, projectId, tenantId, projectDir })
    return res.json({ ok: true, projectId })
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      ok: false,
      error: { message: error.message || 'Failed to subscribe to WattClaw project' },
    })
  }
})

app.delete('/api/events/subscriptions/wattclaw-project', authMiddleware, (req, res) => {
  const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : ''
  const client = sseClients.get(clientId)
  if (!clientId) {
    return res.status(400).json({ ok: false, error: { message: 'clientId is required' } })
  }
  if (!client || client.userId !== req.currentUser.id) {
    return res.status(404).json({ ok: false, error: { message: 'SSE client not found' } })
  }

  wattClawProjectEvents.unsubscribe(clientId)
  for (const subscription of [...client.subscriptions]) {
    if (subscription.startsWith('wattclaw-project:')) client.subscriptions.delete(subscription)
  }
  return res.json({ ok: true })
})

// ── RPC proxy — the big permission layer ──
app.post('/api/rpc', authMiddleware, async (req, res) => {
  const { method, params } = req.body

  if (!method) {
    return res.status(400).json({ error: 'Method is required' })
  }

  const normMethod = method.toLowerCase().replace(/\./g, '.').replace(/^agents\./, 'agent.').replace(/^sessions\./, 'session.').replace(/^channels\./, 'channel.')

  if (normMethod === 'models.list' || normMethod === 'models.get' || normMethod === 'model.list' || normMethod === 'model.get') {
    return res.status(410).json({ ok: false, error: { message: 'Use GET /api/models' } })
  }

  const localTeamTemplateMethods = new Set([
    'wattclaw.team.template.list',
    'wattclaw.team.template.get',
    'wattclaw.team.template.match',
    'wattclaw.team.template.upsert',
    'wattclaw.team.template.project.get',
    'wattclaw.team.profile.list',
    'wattclaw.team.profile.get',
    'wattclaw.team.profile.find',
    'wattclaw.team.profile.upsert',
    'wattclaw.team.profile.bind',
    'wattclaw.team.profile.bindings',
    'wattclaw.team.profile.release',
    'wattclaw.team.profile.release_project',
  ])

  if (!gateway.isConnected && !HTTP_RPC_METHODS.has(normMethod) && !localTeamTemplateMethods.has(normMethod)) {
    return res.status(503).json({ error: 'Gateway not connected' })
  }

  const isAdmin = req.currentUser.role === 'admin'
  const userId = req.currentUser.id

  if (localTeamTemplateMethods.has(normMethod)) {
    try {
      if (normMethod === 'wattclaw.team.template.list') {
        return res.json({
          ok: true,
          payload: listTeamTemplates({
            includeInactive: params?.includeInactive === true,
            userId: isAdmin ? null : userId,
          }),
        })
      }
      if (normMethod === 'wattclaw.team.template.get') {
        const templateId = typeof params?.templateId === 'string' ? params.templateId.trim() : ''
        if (!templateId) return res.status(400).json({ ok: false, error: { message: 'templateId is required' } })
        const template = listTeamTemplates({
          includeInactive: params?.includeInactive === true,
          userId: isAdmin ? null : userId,
        })
          .find(item => item.id === templateId && (!params?.version || item.version === params.version))
        if (!template) return res.status(404).json({ ok: false, error: { message: 'Team template not found' } })
        return res.json({ ok: true, payload: template })
      }
      if (normMethod === 'wattclaw.team.template.match') {
        const input = params?.prompt || params?.description || params?.name || ''
        return res.json({ ok: true, payload: matchTeamTemplatesFromRegistry(input) })
      }
      if (normMethod === 'wattclaw.team.template.upsert') {
        const existing = listTeamTemplates({ includeInactive: true, userId: isAdmin ? null : userId })
          .find(item => item.id === params?.id && item.version === params?.version)
        if (!isAdmin && existing?.status === 'active') {
          return res.status(403).json({ ok: false, error: { message: 'Active team templates are admin-managed' } })
        }
        const template = {
          ...params,
          scope: isAdmin ? (params?.scope || 'global') : 'user',
          status: isAdmin ? (params?.status || 'active') : 'candidate',
        }
        return res.json({
          ok: true,
          payload: saveTeamTemplate(template, userId, { allowForeignUpdate: isAdmin }),
        })
      }
      if (normMethod === 'wattclaw.team.template.project.get') {
        const projectId = typeof params?.projectId === 'string' ? params.projectId.trim() : ''
        if (!projectId) return res.status(400).json({ ok: false, error: { message: 'projectId is required' } })
        const match = getProjectTemplateMatch(projectId, isAdmin ? null : userId)
        if (!match) return res.status(404).json({ ok: false, error: { message: 'Project template match not found' } })
        return res.json({ ok: true, payload: match })
      }

      if (normMethod === 'wattclaw.team.profile.list') {
        return res.json({ ok: true, payload: listAgentProfiles(userId, { roleId: params?.roleId, status: params?.status }) })
      }
      if (normMethod === 'wattclaw.team.profile.get') {
        const profileId = typeof params?.profileId === 'string' ? params.profileId.trim() : ''
        const profile = getAgentProfile(profileId, userId)
        if (!profile) return res.status(404).json({ ok: false, error: { message: 'Agent profile not found' } })
        return res.json({ ok: true, payload: profile })
      }
      if (normMethod === 'wattclaw.team.profile.find') {
        return res.json({
          ok: true,
          payload: findReusableAgentProfile(userId, {
            roleId: params?.roleId,
            capabilities: params?.capabilities,
          }),
        })
      }
      if (normMethod === 'wattclaw.team.profile.upsert') {
        const profile = upsertAgentProfile({ ...params, userId })
        return res.json({ ok: true, payload: profile })
      }
      if (normMethod === 'wattclaw.team.profile.bind') {
        const binding = bindAgentProfileToProject({ ...params, userId })
        return res.json({ ok: true, payload: binding })
      }
      if (normMethod === 'wattclaw.team.profile.bindings') {
        const projectId = typeof params?.projectId === 'string' ? params.projectId.trim() : ''
        return res.json({ ok: true, payload: listProjectMemberBindings(projectId, userId) })
      }
      if (normMethod === 'wattclaw.team.profile.release') {
        const bindingId = typeof params?.bindingId === 'string' ? params.bindingId.trim() : ''
        const binding = releaseProjectMemberBinding(bindingId, userId)
        if (!binding) return res.status(404).json({ ok: false, error: { message: 'Project member binding not found' } })
        return res.json({ ok: true, payload: binding })
      }
      if (normMethod === 'wattclaw.team.profile.release_project') {
        const projectId = typeof params?.projectId === 'string' ? params.projectId.trim() : ''
        return res.json({ ok: true, payload: { released: releaseProjectMemberBindings(projectId, userId) } })
      }
    } catch (error) {
      return res.status(400).json({ ok: false, error: { message: error.message || 'Local team operation failed' } })
    }
  }

  let _ownedKeysSet = null
  let _ownedAgentsSet = null

  function getOwnedKeysSet() {
    if (!_ownedKeysSet) _ownedKeysSet = new Set(getUserOwnedSessionKeys(userId))
    return _ownedKeysSet
  }
  function getOwnedAgentsSet() {
    if (!_ownedAgentsSet) _ownedAgentsSet = new Set(getUserOwnedAgentIds(userId))
    return _ownedAgentsSet
  }

  function rpcIsSessionOwned(sessionKey) {
    if (!sessionKey) return false
    if (recentlyDeletedSessions.has(sessionKey)) return false
    const keysSet = getOwnedKeysSet()
    if (keysSet.has(sessionKey)) return true
    const agentId = sessionKey.match(/^agent:([^:]+):/)?.[1]
    if (agentId && getOwnedAgentsSet().has(agentId)) {
      trackSessionForUser(userId, sessionKey, agentId)
      keysSet.add(sessionKey)
      return true
    }
    return false
  }

  function rpcFilterOwnedSessions(list) {
    if (!Array.isArray(list)) return list
    return list.filter(s => {
      const key = s.key || s.sessionKey || ''
      return key && rpcIsSessionOwned(key)
    })
  }

  const isAgentTraceGet = normMethod === 'wattclawtrace.get'
  const isAgentTraceList = normMethod === 'wattclawtrace.list'

  async function callAgentTraceForSession() {
    const traceParams = params && typeof params === 'object' && !Array.isArray(params)
      ? params
      : {}
    const sessionKey = typeof traceParams.sessionKey === 'string'
      ? traceParams.sessionKey.trim()
      : ''
    const forwardedParams = isAgentTraceGet
      ? Object.fromEntries(Object.entries(traceParams).filter(([key]) => key !== 'sessionKey'))
      : traceParams

    if (!sessionKey) {
      if (!isAdmin) {
        const error = new Error('Session key is required')
        error.statusCode = 400
        throw error
      }

      if (isAgentTraceGet && typeof traceParams.runId === 'string' && traceParams.runId.trim()) {
        const outcomes = await callGatewayForAllTenants(method, forwardedParams)
        const matched = outcomes?.find(outcome => outcome.ok)
        console.info('[AgentTrace] RPC fan-out route', {
          method,
          runId: traceParams.runId,
          tenantId: matched?.tenantId || null,
          userId,
          isAdmin,
        })
        if (matched) return matched.value
      }

      return gateway.call(method, forwardedParams)
    }

    if (!isAdmin && !rpcIsSessionOwned(sessionKey)) {
      const error = new Error('Access denied')
      error.statusCode = 403
      throw error
    }

    const tenantId = resolveTenantIdForSession(sessionKey)

    console.info('[AgentTrace] RPC route', {
      method,
      sessionKey,
      tenantId: tenantId || req.currentTenant?.id || null,
      userId,
      isAdmin,
    })

    return tenantId
      ? callGatewayForTenant(tenantId, method, forwardedParams)
      : gateway.call(method, forwardedParams)
  }

  const isWattClawProjectBuild = normMethod === 'wattclaw.team.project.build'
  const isWattClawProjectCreate = normMethod === 'wattclaw.team.project.create'
  const isWattClawProjectList = normMethod === 'wattclaw.team.project.list'
  const isWattClawProjectGet = normMethod === 'wattclaw.team.project.get'
  const isWattClawProjectActivate = normMethod === 'wattclaw.team.project.activate'
  const isWattClawProjectStart = normMethod === 'wattclaw.team.project.start'
  const isWattClawProjectRetry = normMethod === 'wattclaw.team.project.retry'
  const isWattClawProjectDelete = normMethod === 'wattclaw.team.project.delete'
  const isWattClawProjectArchive = normMethod === 'wattclaw.team.project.archive'
  const isWattClawProjectScoped = normMethod.startsWith('wattclaw.team.project.')
    && !isWattClawProjectBuild
    && !isWattClawProjectCreate
    && !isWattClawProjectList
  let wattClawRuntimeAgents = null
  let authorizedWattClawProject = null
  const requestedTeamCreationMode = params?.teamCreationMode === 'manager' ? 'manager' : 'template'
  const requestedCaptureTeamTemplate = params?.captureTeamTemplate !== false

  function registerWattClawProject(project, agents) {
    const tracked = trackWattClawProjectOwnership({
      project,
      agents,
      userId,
      trackAgent: trackAgentForUser,
      trackSession: trackSessionForUser,
    })
    if (_ownedAgentsSet) {
      for (const agentId of tracked.agentIds) _ownedAgentsSet.add(agentId)
    }
    if (_ownedKeysSet) {
      for (const sessionKey of tracked.sessionKeys) _ownedKeysSet.add(sessionKey)
    }
  }

  function callCurrentWattClawGateway(rpcMethod, rpcParams) {
    return gateway.call(rpcMethod, rpcParams, 120000)
  }

  async function activateWattClawProject(
    project,
    rpc = callCurrentWattClawGateway,
    tenantId = req.currentTenant?.id || '',
  ) {
    const activated = await activateWattClawProjectRuntime({ project, gatewayRpc: rpc })
    wattClawRuntimeAgents = activated.agents
    if (!isAdmin) {
      registerWattClawProject(activated.project, activated.agents)
    }
    const currentAccessState = getWattClawProjectAccessStates(userId).get(activated.project.id)
    if (activated.restored && !currentAccessState?.restoredAt) {
      markWattClawProjectRestored(userId, activated.project.id, tenantId)
    } else if (!activated.restored && !isAdmin) {
      touchWattClawProjectAccess(userId, activated.project.id, tenantId)
    }
    return activated.project
  }

  // A project archived in the gateway plugin keeps its on-disk status as
  // 'archived' even after its agents are restored (activation only re-creates
  // agents, it does not rewrite the project file). We persist the restore state
  // in SQLite (restored_at), so we surface it as a distinct 'restored' status
  // here. States can be preloaded (list) to avoid N queries.
  function withRestoredStatus(project, states) {
    if (!project) return project
    if (String(project.status || '').trim().toLowerCase() !== 'archived') return project
    const state = states?.get(project.id)
    if (state && state.restoredAt > 0) return { ...project, status: 'restored' }
    return project
  }

  function withRestoredStatusForUser(project) {
    if (!project) return project
    if (String(project.status || '').trim().toLowerCase() !== 'archived') return project
    try {
      return withRestoredStatus(project, getWattClawProjectAccessStates(userId))
    } catch {
      return project
    }
  }

  async function requireWattClawProjectAccess() {
    if (!isWattClawProjectScoped) return null
    const projectId = params?.id || params?.projectId
    if (!projectId) return null

    // Admin may operate on projects that live in another tenant, so resolve the
    // owning tenant and fetch from there. Non-admins are always scoped to their
    // own request tenant.
    let projectResult
    if (isAdmin) {
      const tenantId = await resolveWattClawProjectTenant(projectId)
      projectResult = tenantId
        ? await callGatewayForTenant(tenantId, 'wattclaw.team.project.get', { id: projectId })
        : await gateway.call('wattclaw.team.project.get', { id: projectId })
    } else {
      projectResult = await gateway.call('wattclaw.team.project.get', { id: projectId })
    }
    const project = extractWattClawProject(projectResult)
    if (!project) {
      const error = new Error(`WattClaw project not found: ${projectId}`)
      error.statusCode = 404
      throw error
    }

    if (!isAdmin && !userOwnsWattClawProject(project, getOwnedAgentsSet())) {
      const error = new Error('Access denied')
      error.statusCode = 403
      throw error
    }

    return project
  }

  async function prepareWattClawProjectStart(project) {
    if (!project) return

    return activateWattClawProject(project)
  }

  // Admin's project list must aggregate across ALL tenants. Collaboration
  // projects are stored per-tenant (isolated .wattclaw-team/projects mounts),
  // so a single gateway.call only reaches the admin's own tenant and misses
  // projects created by users in other tenants. Unlike sessions (which live in
  // a shared agents mount), projects require an explicit per-tenant fan-out.
  //
  // The Gateway exposes no HTTP RPC endpoint (all HTTP paths 404), so the
  // fan-out must go over each tenant's cached WebSocket client. As we discover
  // which tenant owns each project we record it in wattClawProjectTenantCache
  // so subsequent scoped admin operations (get / task.list) can be routed to
  // the owning tenant instead of defaulting to the admin's own tenant.
  async function listWattClawProjectsForAdmin() {
    const outcomes = await callGatewayForAllTenants(method, params)
    if (!outcomes || outcomes.length === 0) {
      // Single-tenant mode (or multi-tenant disabled): fall back to direct call.
      return extractWattClawProjects(await gateway.call(method, params))
    }

    const byId = new Map()
    for (const outcome of outcomes) {
      if (!outcome.ok) continue
      for (const project of extractWattClawProjects(outcome.value)) {
        if (!project?.id) continue
        if (outcome.tenantId) wattClawProjectTenantCache.set(project.id, outcome.tenantId)
        if (!byId.has(project.id)) byId.set(project.id, project)
      }
    }
    return [...byId.values()]
  }

  // For admin scoped ops on a project that lives in another tenant, route the
  // RPC to the owning tenant's WS client. Non-admins (and admin-owned projects)
  // continue to use the request-context gateway.
  async function callWattClawScopedForAdmin() {
    const projectId = params?.id || params?.projectId
    const tenantId = await resolveWattClawProjectTenant(projectId)
    const result = tenantId
      ? await callGatewayForTenant(tenantId, method, params)
      : await gateway.call(method, params)
    return { result, tenantId: tenantId || '' }
  }

  async function callGatewayWithWattClawRuntime() {
    if (isWattClawProjectList) {
      if (isAdmin) {
        const projects = await listWattClawProjectsForAdmin()
        const states = getWattClawProjectAccessStates(userId)
        return projects.map(project => withRestoredStatus(project, states))
      }
      const result = await gateway.call(method, params)
      const owned = filterWattClawProjectsByOwnedAgents(extractWattClawProjects(result), getOwnedAgentsSet())
      let states = new Map()
      try {
        states = getWattClawProjectAccessStates(userId)
      } catch {
        // ignore — fall back to raw statuses
      }
      return owned.map((project) => withRestoredStatus(project, states))
    }

    if (isWattClawProjectScoped) {
      authorizedWattClawProject = await requireWattClawProjectAccess()
      if (isWattClawProjectActivate && authorizedWattClawProject) {
        const wasArchived = String(authorizedWattClawProject.status || '').trim().toLowerCase() === 'archived'
        let activatedProject
        let activatedTenantId = req.currentTenant?.id || ''
        if (isAdmin) {
          const tenantId = await resolveWattClawProjectTenant(authorizedWattClawProject.id)
          activatedTenantId = tenantId || ''
          const rpc = tenantId
            ? (rpcMethod, rpcParams) => callGatewayForTenant(tenantId, rpcMethod, rpcParams)
            : callCurrentWattClawGateway
          activatedProject = await activateWattClawProject(authorizedWattClawProject, rpc, tenantId || '')
        } else {
          activatedProject = await activateWattClawProject(authorizedWattClawProject)
        }
        const restoredProject = withRestoredStatusForUser(activatedProject)
        if (wasArchived) {
          broadcastWattClawProjectsChanged(activatedTenantId, 'restore')
        }
        return restoredProject
      }
      if (isWattClawProjectGet && authorizedWattClawProject) {
        // Re-register every current member on each get/diagnostics poll. Worker
        // agents are often added dynamically during planning (by the manager via
        // skill, outside this RPC proxy) and therefore miss the one-time
        // create/build/start registration. Tracking is idempotent (first-writer
        // -wins), so this backfills ownership for late-added members and makes
        // their sessions visible so message history can load.
        //
        // Only the owning (non-admin) user registers: user_sessions is
        // first-writer-wins, so if admin registered a cross-tenant project's
        // members here the real owner would permanently lose visibility. Admin
        // already sees every session via the all-rows query and inherits these
        // rows once the owner polls their own project.
        if (!isAdmin) {
          registerWattClawProject(authorizedWattClawProject, [])
          refreshWattClawProjectFeishuMembers(authorizedWattClawProject)
          if (String(authorizedWattClawProject.status || '').trim().toLowerCase() === 'success') {
            try {
              captureSuccessfulProjectTemplateCandidate({
                project: authorizedWattClawProject,
                userId,
              })
            } catch (error) {
              console.warn('[TeamTemplate] failed to capture successful project candidate:', error.message)
            }
            releaseProjectMemberBindings(authorizedWattClawProject.id, userId)
          }
        }
        return withRestoredStatusForUser(authorizedWattClawProject)
      }
      // Admin may open projects owned by another tenant; route to that tenant.
      if (isAdmin && !isWattClawProjectStart) {
        const scoped = await callWattClawScopedForAdmin()
        if (isWattClawProjectGet && scoped.result) {
          const project = extractWattClawProject(scoped.result)
          if (String(project?.status || '').trim().toLowerCase() === 'success') {
            try {
              captureAdminOwnedWattClawProjectTemplate(project, userId)
            } catch (error) {
              console.warn('[TeamTemplate] failed to capture admin-owned project candidate:', error.message)
            } finally {
              releaseProjectMemberBindings(project?.id || params?.id, userId)
            }
          }
        }
        if (isWattClawProjectArchive) {
          markWattClawProjectArchived(userId, params?.id || params?.projectId)
          broadcastWattClawProjectsChanged(scoped.tenantId, 'archive')
        }
        return scoped.result
      }
    }

    const wantsFeishuProjectSync = isWattClawProjectStart && params?.isCreateFeishuGroup === true
    if (wantsFeishuProjectSync) {
      const bot = getUserFeishuBot(userId)
      if (!bot) {
        const error = new Error('请先在“我的机器人”中绑定你的飞书机器人')
        error.statusCode = 400
        throw error
      }
      const verification = await verifyUserFeishuBot(userId)
      if (!verification.valid) {
        const error = new Error(verification.error || '飞书机器人凭据校验失败，请重新绑定')
        error.statusCode = 400
        throw error
      }
    }

    if (isWattClawProjectStart) {
      authorizedWattClawProject = await prepareWattClawProjectStart(authorizedWattClawProject)
    }

    let feishuSync = null
    if (wantsFeishuProjectSync) {
      try {
        feishuSync = await enableWattClawProjectFeishuSync({
          project: authorizedWattClawProject,
          userId,
          tenantId: req.currentTenant?.id || null,
          sendIntro: false,
        })
      } catch (error) {
        console.error('[FeishuProjectSync] project group creation failed:', {
          projectId: authorizedWattClawProject?.id,
          userId,
          error: error.message,
        })
        const bot = getUserFeishuBot(userId)
        return {
          ...authorizedWattClawProject,
          feishuSync: {
            enabled: false,
            error: error.message,
            permissionUrl: getFeishuPermissionUrl(bot?.appId),
          },
        }
      }
    }

    const gatewayParams = { ...(params || {}) }
    delete gatewayParams.teamCreationMode
    delete gatewayParams.captureTeamTemplate
    const forwardedParams = wantsFeishuProjectSync
      ? { ...gatewayParams, isCreateFeishuGroup: false }
      : gatewayParams
    let projectTemplateMatch = isWattClawProjectBuild
      ? {
        normalizedIntent: {},
        decision: requestedTeamCreationMode === 'manager' ? 'disabled' : 'fresh_plan',
        selectedTemplate: null,
        profileMatches: [],
        candidates: [],
      }
      : null
    if (isWattClawProjectBuild && requestedTeamCreationMode === 'template') {
      try {
        projectTemplateMatch = matchTeamTemplatesFromRegistry({
          prompt: params?.prompt || params?.description || '',
          locale: params?.locale,
        })
        const selectedSlots = Array.isArray(projectTemplateMatch.selectedTemplate?.slots)
          ? projectTemplateMatch.selectedTemplate.slots
          : []
        projectTemplateMatch.profileMatches = selectedSlots.map((slot) => {
          const profile = findReusableAgentProfile(userId, {
            roleId: slot.roleId,
            capabilities: slot.selector?.capabilities,
          })
          return {
            slotId: slot.id,
            roleId: slot.roleId,
            profile: profile ? {
              id: profile.id,
              roleId: profile.roleId,
              name: profile.name,
              gatewayAgentId: profile.gatewayAgentId,
              capabilityTags: profile.capabilityTags,
              skills: profile.skills,
              model: profile.model,
              reusePolicy: profile.reusePolicy,
              status: profile.status,
            } : null,
          }
        })
      } catch (error) {
        console.error('[TeamTemplate] match failed, falling back to fresh planning:', error.message)
      }
    }
    let result
    try {
      result = await gateway.call(method, forwardedParams)
    } catch (error) {
      if (wantsFeishuProjectSync && authorizedWattClawProject?.id) {
        disableWattClawProjectFeishuSync(
          authorizedWattClawProject.id,
          `项目启动失败：${error.message}`,
        )
      }
      throw error
    }
    if (isWattClawProjectDelete) {
      disableWattClawProjectFeishuSync(params?.id || params?.projectId, '项目已删除')
      if (!isAdmin) {
        removeWattClawProjectAccess(userId, params?.id || params?.projectId)
        releaseProjectMemberBindings(params?.id || params?.projectId, userId)
      }
      return result
    }
    if (isWattClawProjectArchive) {
      if (!isAdmin) {
        markWattClawProjectArchived(userId, params?.id || params?.projectId)
        releaseProjectMemberBindings(params?.id || params?.projectId, userId)
        broadcastWattClawProjectsChanged(req.currentTenant?.id || '', 'archive')
      }
      return result
    }
    const shouldRegisterProject = isWattClawProjectBuild
      || isWattClawProjectCreate
      || isWattClawProjectStart
      || isWattClawProjectRetry
    if (!shouldRegisterProject) return result

    let project = extractWattClawProject(result)
    if (!project) throw new Error(`WattClaw project response is invalid for ${method}`)

    if (isWattClawProjectBuild) {
      const persistedMatch = {
        normalizedIntent: projectTemplateMatch?.normalizedIntent || {},
        decision: projectTemplateMatch?.decision || 'fresh_plan',
        selectedTemplate: projectTemplateMatch?.selectedTemplate || null,
        profileMatches: projectTemplateMatch?.profileMatches || [],
        candidates: (projectTemplateMatch?.candidates || []).map(({ template, ...candidate }) => candidate),
        collaborationSettings: {
          teamCreationMode: requestedTeamCreationMode,
          captureTeamTemplate: requestedCaptureTeamTemplate,
        },
      }
      const draftSuggestion = {
        ...(project.draftSuggestion && typeof project.draftSuggestion === 'object'
          ? project.draftSuggestion
          : {}),
        collaborationSettings: {
          teamCreationMode: requestedTeamCreationMode,
          captureTeamTemplate: requestedCaptureTeamTemplate,
        },
        templateMatch: persistedMatch,
      }
      try {
        const updated = await gateway.call('wattclaw.team.project.update', {
          id: project.id,
          draftSuggestion,
        })
        const updatedProject = extractWattClawProject(updated)
        project = updatedProject
          ? {
            ...updatedProject,
            draftSuggestion: updatedProject.draftSuggestion || draftSuggestion,
          }
          : { ...project, draftSuggestion }
      } catch (error) {
        console.warn('[TeamTemplate] failed to persist match on Gateway project:', error.message)
        project = { ...project, draftSuggestion }
      }
      try {
        recordProjectTemplateMatch({
          projectId: project.id,
          userId,
          tenantId: req.currentTenant?.id || '',
          match: persistedMatch,
        })
      } catch (error) {
        console.warn('[TeamTemplate] failed to persist local match:', error.message)
      }
    }

    if (!wattClawRuntimeAgents) {
      wattClawRuntimeAgents = await ensureWattClawProjectRuntime({ project, gatewayAdminRpc })
    }
    registerWattClawProject(project, wattClawRuntimeAgents)
    if (!isAdmin) {
      touchWattClawProjectAccess(userId, project.id, req.currentTenant?.id || '')
    }
    if (!wantsFeishuProjectSync) return project
    await sendWattClawProjectFeishuIntro(project, userId)
    return { ...project, feishuSync }
  }

  try {
    if (isAgentTraceGet || isAgentTraceList) {
      const result = await callAgentTraceForSession()
      return res.json({ ok: true, payload: result })
    }

    if (!isAdmin) {
      if (normMethod === 'skills.status') {
        return res.json({ ok: true, payload: skillsStatusPolling.getData() })
      }
      if (normMethod === 'agents.list' || normMethod === 'agent.list') {
        const _rpcR = await gatewayAdminRpc(method, params)
        if (!_rpcR.ok) throw new Error(_rpcR.error)
        const result = _rpcR.payload
        if (getOwnedAgentsSet().size > 0 && result && result.agents) {
          result.agents = result.agents.filter(a => getOwnedAgentsSet().has(a.id || a.agentId))
        } else if (getOwnedAgentsSet().size === 0) {
          if (result) result.agents = []
        }
        return res.json({ ok: true, payload: result })
      }

      if (normMethod === 'session.spawn' || normMethod === 'sessions.spawn') {
        const result = await gateway.call(method, params)
        const sk = result?.sessionKey || result?.key || params?.sessionKey
        if (sk) {
          const agentId = params?.agentId || sk.match(/^agent:([^:]+):/)?.[1] || null
          trackSessionForUser(userId, sk, agentId, params?.label, params?.channel)
          if (agentId && !getOwnedAgentsSet().has(agentId)) {
            trackAgentForUser(userId, agentId, agentId)
          }
        }
        return res.json({ ok: true, payload: result })
      }

      if (normMethod === 'session.send' || normMethod === 'sessions.send') {
        const sk = params?.sessionKey || params?.key
        if (sk && !getOwnedKeysSet().has(sk)) {
          const agentId = params?.agentId || sk.match(/^agent:([^:]+):/)?.[1] || null
          trackSessionForUser(userId, sk, agentId)
          if (agentId && !getOwnedAgentsSet().has(agentId)) {
            trackAgentForUser(userId, agentId, agentId)
          }
        }
        const result = await gateway.call(method, params)
        return res.json({ ok: true, payload: result })
      }

      if (normMethod === 'chat.send') {
        const sk = params?.sessionKey
        if (sk && !getOwnedKeysSet().has(sk)) {
          const agentId = sk.match(/^agent:([^:]+):/)?.[1] || null
          trackSessionForUser(userId, sk, agentId)
          if (agentId && !getOwnedAgentsSet().has(agentId)) {
            trackAgentForUser(userId, agentId, agentId)
          }
        }
        // 并发监控（计数在发送前，缓存等 sessions.patch 确认后）
        const chatModel = params?.model
        const rpcEffectiveModel = chatModel || (sk ? getCachedSessionModel(sk) : null)
        if (rpcEffectiveModel) {
          const rpcMonitorResult = recordRequest(rpcEffectiveModel)
          if (rpcMonitorResult.shouldAlert) {
            broadcastGlobalSSE({
              type: 'event',
              event: 'model.congestion',
              payload: { isCongested: rpcMonitorResult.isCongested, count: rpcMonitorResult.count, model: rpcMonitorResult.model, windowMs: rpcMonitorResult.windowMs }
            })
          }
        }

        // Gateway chat.send does not accept model param; patch session first
        if (chatModel && sk) {
          try {
            await gateway.call('sessions.patch', { key: sk, model: chatModel })
            cacheSessionModel(sk, chatModel)
          } catch (patchErr) {
            console.error(`[RPC] sessions.patch model failed for ${sk}:`, patchErr.message)
          }
        }

        // 剔除 model 后再转发给 Gateway
        const { model: _, ...forwardParams } = params
        const result = await gateway.call(method, forwardParams)
        return res.json({ ok: true, payload: result })
      }

      if (normMethod === 'agent') {
        const sk = params?.sessionKey
        if (sk && !getOwnedKeysSet().has(sk)) {
          const agentId = sk.match(/^agent:([^:]+):/)?.[1] || null
          trackSessionForUser(userId, sk, agentId)
          if (agentId && !getOwnedAgentsSet().has(agentId)) {
            trackAgentForUser(userId, agentId, agentId)
          }
        }
        const result = await gateway.call(method, params)
        return res.json({ ok: true, payload: result })
      }

      if (normMethod === 'sessions.list' || normMethod === 'session.list') {
        return res.status(410).json({ ok: false, error: { message: 'Use GET /api/sessions' } })
      }

      if (normMethod === 'sessions.reset' || normMethod === 'session.reset') {
        const sk = params?.key || params?.sessionKey
        if (sk && !rpcIsSessionOwned(sk)) {
          return res.status(403).json({ ok: false, error: { message: 'Access denied' } })
        }
        const result = await gateway.call(method, params)
        // Clean local message store on session reset
        if (sk) {
          deleteSessionMessages(sk).catch(err =>
            console.error('[MessageStore] reset cleanup error:', err.message)
          )
        }
        return res.json({ ok: true, payload: result })
      }

      if (normMethod === 'sessions.delete' || normMethod === 'session.delete') {
        const sk = params?.key || params?.sessionKey
        if (sk && !rpcIsSessionOwned(sk)) {
          return res.status(403).json({ ok: false, error: { message: 'Access denied' } })
        }
        const result = await gateway.call(method, params)
        if (sk) {
          removeSessionForUser(userId, sk)
          // Clean local message store on session delete
          deleteSessionMessages(sk).catch(err =>
            console.error('[MessageStore] delete cleanup error:', err.message)
          )
          recentlyDeletedSessions.add(sk)
          setTimeout(() => recentlyDeletedSessions.delete(sk), 60_000)
        }
        return res.json({ ok: true, payload: result })
      }

      if (normMethod === 'sessions.get' || normMethod === 'session.get' || normMethod === 'sessions.history' || normMethod === 'session.history') {
        const sk = params?.key || params?.sessionKey
        if (sk && !rpcIsSessionOwned(sk)) {
          return res.json({ ok: true, payload: [] })
        }
        const result = await gateway.call(method, params)

        // Message count limit
        const messageLimit = Math.min(200, Math.max(10, parseInt(params?.messageLimit) || 50))
        if (result && Array.isArray(result.transcript) && result.transcript.length > messageLimit) {
          const totalMessages = result.transcript.length
          result.transcript = result.transcript.slice(-messageLimit)
          result._truncated = true
          result._totalMessages = totalMessages
        }

        return res.json({ ok: true, payload: result })
      }

      if (normMethod === 'sessions.patch' || normMethod === 'session.patch') {
        const sk = params?.key || params?.sessionKey
        if (sk && !rpcIsSessionOwned(sk)) {
          return res.status(403).json({ ok: false, error: { message: 'Access denied' } })
        }
        try {
          const result = await gateway.call(method, params)
          // Gateway 确认后才缓存 session→model 映射
          if (params?.model && (params?.key || params?.sessionKey)) {
            cacheSessionModel(params.key || params.sessionKey, params.model)
          }
          res.json({ ok: true, payload: result })
        } catch (err) {
          res.status(500).json({ ok: false, error: { message: err.message } })
        }
        return
      }

      if (normMethod === 'chat.history') {
        return res.status(410).json({ ok: false, error: { message: 'Use GET /api/chat/history' } })
      }

      if (normMethod === 'status') {
        const rpcResult = await gatewayAdminRpc(method, params)
        if (!rpcResult.ok) throw new Error(rpcResult.error)
        const result = rpcResult.payload
        if (result && result.sessions) {
          if (result.sessions.recent) result.sessions.recent = rpcFilterOwnedSessions(result.sessions.recent)
          if (result.sessions.byAgent) {
            result.sessions.byAgent = result.sessions.byAgent
              .filter(ba => getOwnedAgentsSet().has(ba.agentId))
              .map(ba => ({ ...ba, recent: rpcFilterOwnedSessions(ba.recent) }))
          }
        }
        return res.json({ ok: true, payload: result })
      }

      if (normMethod === 'session.usage' || normMethod === 'sessions.usage' || normMethod === 'usage.sessions') {
        const usageResponse = await _handleUsageProxy(params, userId, isAdmin)
        if (usageResponse.shouldEnqueueSync) {
          scheduleUsageSyncAfterRead().catch(() => {})
        }
        return res.json({
          ok: true,
          payload: usageResponse.result,
          ...(usageResponse.userUsage ? { userUsage: usageResponse.userUsage } : {}),
        })
      }

      if (normMethod === 'usage.cost' || normMethod === 'cost.usage') {
        const costResult = await _handleUsageCostProxy(params, userId, isAdmin)
        return res.json(costResult)
      }

      if (normMethod === 'sessions.export' || normMethod === 'session.export') {
        const sk = params?.key || params?.sessionKey
        if (sk && !rpcIsSessionOwned(sk)) {
          return res.json({ ok: true, payload: null })
        }
        const result = await gateway.call(method, params)
        return res.json({ ok: true, payload: result })
      }

      if (['cron.list', 'crons.list', 'schedule.list', 'schedules.list'].includes(normMethod)) {
        await refreshCronJobsForScope(gatewayAdminRpc, { userId, isAdmin })
        return res.json({ ok: true, payload: listCronJobsFromDb({ userId, isAdmin }) })
      }

      if (['cron.runs', 'crons.runs', 'cron.history', 'crons.history'].includes(normMethod)) {
        const _rpcR4 = await gatewayAdminRpc(method, params)
        if (!_rpcR4.ok) throw new Error(_rpcR4.error)
        const result = _rpcR4.payload
        const filterFn = r => {
          const aid = r.agentId || (r.sessionKey || '').match(/^agent:([^:]+):/)?.[1] || ''
          return aid && getOwnedAgentsSet().has(aid)
        }
        if (Array.isArray(result)) return res.json({ ok: true, payload: result.filter(filterFn) })
        if (result && typeof result === 'object') {
          for (const key of ['entries', 'items', 'list', 'data', 'runs', 'history']) {
            if (Array.isArray(result[key])) { result[key] = result[key].filter(filterFn); break }
          }
        }
        return res.json({ ok: true, payload: result })
      }

      if (['cron.add', 'cron.create', 'crons.add', 'crons.create'].includes(normMethod)) {
        if (!params?.agentId) return res.status(403).json({ ok: false, error: { message: 'Agent ID is required' } })
        if (!getOwnedAgentsSet().has(params.agentId)) return res.status(403).json({ ok: false, error: { message: 'Not your agent' } })
        const { agentId, ...cronParams } = params
        const rpcResult = await gatewayAdminRpc(method, params)
        if (!rpcResult.ok) throw new Error(rpcResult.error)
        return res.json({ ok: true, payload: rpcResult.payload })
      }

      if (['cron.update', 'crons.update', 'schedule.update', 'schedules.update',
           'cron.remove', 'cron.delete', 'crons.remove', 'crons.delete', 'schedule.delete', 'schedules.delete',
           'cron.run', 'crons.run', 'cron.trigger', 'crons.trigger'].includes(normMethod)) {
        const jobId = params?.id || params?.jobId || params?.taskId
        if (jobId) {
          try {
            await refreshCronJobsForScope(gatewayAdminRpc, { userId, isAdmin })
            const job = listCronJobsFromDb({ userId, isAdmin }).find(j => j.id === jobId) || null
            if (job) {
              const aid = job.agentId || ''
              if (!aid) return res.status(403).json({ ok: false, error: { message: 'Admin only' } })
              if (!getOwnedAgentsSet().has(aid)) return res.status(403).json({ ok: false, error: { message: 'Not your task' } })
            }
          } catch { /* if cron.list fails, allow through */ }
        }
        if (['cron.update', 'crons.update', 'schedule.update', 'schedules.update'].includes(normMethod)) {
          const { agentId, ...cronParams } = params || {}
          const rpcResult = await gatewayAdminRpc(method, params)
          if (!rpcResult.ok) throw new Error(rpcResult.error)
          return res.json({ ok: true, payload: rpcResult.payload })
        }
        if (['cron.remove', 'cron.delete', 'crons.remove', 'crons.delete', 'schedule.delete', 'schedules.delete'].includes(normMethod)) {
          const rpcResult = await gatewayAdminRpc(method, params)
          if (!rpcResult.ok) throw new Error(rpcResult.error)
          return res.json({ ok: true, payload: rpcResult.payload })
        }
        const rpcResult = await gatewayAdminRpc(method, params)
        if (!rpcResult.ok) throw new Error(rpcResult.error)
        return res.json({ ok: true, payload: rpcResult.payload })
      }

      if (normMethod === 'config.get') {
        const cfgRpc = await gatewayAdminRpc('config.get', {})
        const result = cfgRpc.ok ? cfgRpc.payload : null
        if (result && result.models && result.models.providers) {
          for (const p of Object.values(result.models.providers)) {
            if (typeof p === 'object' && p !== null) {
              delete p.apiKey; delete p.secret; delete p.credentials; delete p.apiSecret; delete p.token
            }
          }
        }
        return res.json({ ok: true, payload: result })
      }

      if (normMethod === 'config.patch' || normMethod === 'config.set') {
        return res.status(410).json({ ok: false, error: { message: 'Use PATCH /api/config' } })
      }

      if (normMethod === 'config.apply') {
        return res.status(403).json({ ok: false, error: { message: 'Admin only' } })
      }
    }

    // Admin passthrough
    if (isAdmin) {
      if (normMethod === 'sessions.list' || normMethod === 'session.list') {
        return res.status(410).json({ ok: false, error: { message: 'Use GET /api/sessions' } })
      }
      if (normMethod === 'cron.list' || normMethod === 'cron.get') {
        const r = await gatewayAdminRpc('cron.list', { includeDisabled: true })
        return res.json(r.ok ? { ok: true, payload: r.payload } : { ok: false, error: r.error })
      }
      if (normMethod === 'skills.status') {
        return res.json({ ok: true, payload: skillsStatusPolling.getData() })
      }
      if (normMethod === 'config.get') {
        const r = await gatewayAdminRpc('config.get', {})
        return res.json(r.ok ? { ok: true, payload: r.payload } : { ok: false, error: r.error })
      }

      const isUsage = (normMethod === 'session.usage' || normMethod === 'sessions.usage' || normMethod === 'usage.sessions')
      if (isUsage) {
        const usageResponse = await _handleUsageProxy(params, userId, isAdmin)
        if (usageResponse.shouldEnqueueSync) {
          scheduleUsageSyncAfterRead().catch(() => {})
        }
        return res.json({
          ok: true,
          payload: usageResponse.result,
          ...(usageResponse.userUsage ? { userUsage: usageResponse.userUsage } : {}),
        })
      }
      if (normMethod === 'usage.cost' || normMethod === 'cost.usage') {
        const costResult = await _handleUsageCostProxy(params, userId, isAdmin)
        return res.json(costResult)
      }

      if (HTTP_RPC_METHODS.has(normMethod)) {
        const rpcResult = await gatewayAdminRpc(method, params)
        if (!rpcResult.ok) throw new Error(rpcResult.error)
        return res.json({ ok: true, payload: rpcResult.payload })
      }
      const result = await callGatewayWithWattClawRuntime()
      return res.json({ ok: true, payload: result })
    }

    // Non-admin fallback
    if (HTTP_RPC_METHODS.has(normMethod)) {
      const rpcResult = await gatewayAdminRpc(method, params)
      if (!rpcResult.ok) throw new Error(rpcResult.error)
      return res.json({ ok: true, payload: rpcResult.payload })
    }
    const result = await callGatewayWithWattClawRuntime()
    res.json({ ok: true, payload: result })
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: { message: translateGatewayError(err.message), code: err.code } })
  }
})

// ── Static files ──
// Serve shared files with security headers (sandbox CSP, no inline SVG/HTML)
app.use('/shared', (req, res, next) => {
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  next()
}, express.static(sharedDir))

if (hasDist) {
  app.use(express.static(distPath))
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      res.sendFile(join(distPath, 'index.html'))
    } else {
      next()
    }
  })
} else {
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      res.redirect(envConfig.DEV_FRONTEND_URL + req.originalUrl)
    } else {
      next()
    }
  })
}

// ── Global error handler ──
app.use((err, req, res, _next) => {
  if (err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? '文件大小超过限制（最大 100MB）'
      : `上传错误: ${err.message}`
    return res.status(413).json({ ok: false, error: { message } })
  }
  console.error('[Server] Unhandled error:', err.message)
  res.status(500).json({ ok: false, error: { message: '服务器内部错误' } })
})

// ── Server lifecycle ──
server.listen(envConfig.PORT, () => {
  console.log(`Server running on http://localhost:${envConfig.PORT}`)
  console.log(`OpenClaw Gateway: ${envConfig.OPENCLAW_WS_URL}`)
  scheduleWattClawRetention()
  startModelHealthMonitor(envConfig)
  deduplicateSharedSessions()
  syncAgentWorkspacesFromGateway().catch(err => {
    console.error('[AgentWorkspaceSync] Failed:', err.message)
  })
  initMessageStore().then(() => {
    console.log('[MessageStore] Ready')
    return repairSessionTitleAndActivitySemantics()
  }).then((result) => {
    if (!result) return
    console.log(`[SessionRepair] titles=${result.titlesChanged}, lastMessageAt=${result.lastMessageAtChanged}, scanned=${result.sessionsScanned}`)
    return backfillExternalSessionTitles()
  }).then((result) => {
    if (!result) return
    console.log(`[ExternalSessionProjection] checked=${result.checked}, repaired=${result.repaired}, skipped=${result.skipped}`)
  }).catch(err => {
    console.error('[MessageStore] Init failed:', err.message)
  })
  if (isAuthEnabled()) {
    console.log(`Auth enabled: user "${envConfig.AUTH_USERNAME}"`)
  } else {
    console.log('Auth disabled (no AUTH_USERNAME/AUTH_PASSWORD configured)')
  }
  if (!hasDist) {
    console.log(`Development mode: Frontend at ${envConfig.DEV_FRONTEND_URL}`)
  }

  try {
    const runningTasks = db.prepare('SELECT id FROM backup_records WHERE status = ?').all('running')
    if (runningTasks.length > 0) {
      console.log(`[Backup] Marking ${runningTasks.length} interrupted tasks as failed`)
      db.prepare('UPDATE backup_records SET status = ?, error = ?, message = ? WHERE status = ?').run(
        'failed',
        'Server restarted during task execution',
        'Task interrupted by server restart',
        'running'
      )
    }
  } catch (err) {
    console.error('[Backup] Failed to cleanup interrupted tasks:', err.message)
  }
})

// ---------------------------------------------------------------------------
// Usage proxy helpers — pure SQLite read (Gateway sync in Task 4)
// ---------------------------------------------------------------------------

/** Task 4: read-triggered background sync (non-blocking, singleflight with cooldown). */
let _readTriggeredUsageSyncInFlight = null
let _lastReadTriggeredSyncAt = 0
const READ_TRIGGERED_SYNC_COOLDOWN_MS = 60_000 // 60s cooldown to prevent retry storm

async function scheduleUsageSyncAfterRead() {
  if (_readTriggeredUsageSyncInFlight) return _readTriggeredUsageSyncInFlight
  if (Date.now() - _lastReadTriggeredSyncAt < READ_TRIGGERED_SYNC_COOLDOWN_MS) return
  _lastReadTriggeredSyncAt = Date.now()
  _readTriggeredUsageSyncInFlight = syncUsageFromGatewayOnStartup()
    .catch(err => {
      debug('read-triggered usage sync failed:', err?.message || err)
    })
    .finally(() => {
      _readTriggeredUsageSyncInFlight = null
    })
  return _readTriggeredUsageSyncInFlight
}

async function _handleUsageProxy(params, userId, isAdmin) {
  const scopedUserId = isAdmin ? null : userId
  const result = getUserAggregates(scopedUserId)

  return {
    result,
    userUsage: isAdmin && _shouldIncludeUserUsage(params)
      ? getAdminUserUsageAggregates()
      : null,
    shouldEnqueueSync: !hasUsageSyncRows(scopedUserId),
  }
}

function _shouldIncludeUserUsage(params) {
  const include = String(params?.include || '')
  return include.split(',').map(s => s.trim()).includes('userUsage')
}

async function _handleUsageCostProxy(_params, userId, isAdmin) {
  const scopedUserId = isAdmin ? null : userId
  const result = getUserAggregates(scopedUserId)
  const daily = result.aggregates.daily || []
  return {
    ok: true,
    payload: {
      updatedAt: Date.now(),
      days: daily.length,
      daily,
      totals: result.totals,
    },
  }
}

let shuttingDown = false
process.on('SIGINT', () => {
  if (shuttingDown) {
    console.log('\nForce exit')
    process.exit(1)
  }
  shuttingDown = true
  console.log('\nShutting down...')
  if (wattClawRetentionTimer) clearTimeout(wattClawRetentionTimer)
  wattClawProjectEvents.stop()
  gateway.disconnect()
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections()
  }
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
  setTimeout(() => {
    console.log('Force exit (timeout)')
    process.exit(0)
  }, 3000).unref()
})
