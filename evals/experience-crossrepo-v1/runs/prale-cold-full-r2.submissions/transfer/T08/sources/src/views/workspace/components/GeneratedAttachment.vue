<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { Icon } from '@iconify/vue'
import { apiPath } from '@/utils/api-path'
import { base64ToBlob, downloadBlob } from '@/utils/file-blob'
import { getFileMeta } from '@/utils/file-icons'
import type { GeneratedAttachment } from '@/utils/generated-attachments'

const props = defineProps<{
  attachment: GeneratedAttachment
  sessionKey: string
}>()

const message = useMessage()
const { t } = useI18n()
const downloading = ref(false)

const fileIcon = computed(() => `vscode-icons:${getFileMeta(props.attachment.name).icon}`)

async function download() {
  if (downloading.value) return
  downloading.value = true
  const traceId = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `generated-file-${Date.now()}`
  try {
    const query = new URLSearchParams({
      sessionKey: props.sessionKey,
      path: props.attachment.path,
      traceId,
    })
    console.info('[GeneratedAttachment] download request', {
      traceId,
      sessionKey: props.sessionKey,
      path: props.attachment.path,
    })
    const token = localStorage.getItem('auth_token')
    const response = await fetch(apiPath(`/api/chat/generated-file?${query.toString()}`), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error?.message || `HTTP ${response.status}`)
    }

    const content = String(data.content || '')
    const mimeType = String(data.file?.mimeType || 'application/octet-stream')
    const filename = String(data.file?.name || props.attachment.name)
    const blob = data.isBase64
      ? base64ToBlob(content, mimeType)
      : new Blob([content], { type: mimeType })
    downloadBlob(blob, filename)
    console.info('[GeneratedAttachment] download complete', { traceId, filename, size: blob.size })
  } catch (error) {
    console.error('[GeneratedAttachment] download failed', {
      traceId,
      sessionKey: props.sessionKey,
      path: props.attachment.path,
      error,
    })
    const reason = error instanceof Error ? error.message : String(error)
    message.error(t('pages.workspace.chat.generatedFileDownloadFailed', { error: reason }))
  } finally {
    downloading.value = false
  }
}
</script>

<template>
  <button
    type="button"
    class="generated-attachment"
    :disabled="downloading"
    :title="t('pages.workspace.chat.generatedFileDownload')"
    @click="download"
  >
    <span class="generated-attachment__icon">
      <Icon :icon="fileIcon" width="28" height="28" />
    </span>
    <span class="generated-attachment__content">
      <span class="generated-attachment__name">{{ attachment.name }}</span>
      <span class="generated-attachment__path">{{ attachment.path }}</span>
    </span>
    <span class="generated-attachment__action material-symbols-outlined">
      {{ downloading ? 'progress_activity' : 'download' }}
    </span>
  </button>
</template>

<style scoped>
.generated-attachment {
  width: min(420px, 100%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 12px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-card);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease;
}

.generated-attachment:hover:not(:disabled) {
  border-color: var(--primary);
  background: var(--bg-hover);
}

.generated-attachment:disabled {
  cursor: wait;
  opacity: 0.7;
}

.generated-attachment__icon {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 8px;
  background: var(--bg-secondary);
}

.generated-attachment__content {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.generated-attachment__name,
.generated-attachment__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.generated-attachment__name {
  font-size: 14px;
  font-weight: 600;
}

.generated-attachment__path {
  color: var(--text-tertiary);
  font-size: 12px;
}

.generated-attachment__action {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: 20px;
}

.generated-attachment:disabled .generated-attachment__action {
  animation: generated-attachment-spin 0.9s linear infinite;
}

@keyframes generated-attachment-spin {
  to { transform: rotate(360deg); }
}
</style>
