<template>
  <AppLayout full-height>
    <section class="canvas-page">
      <header class="canvas-toolbar">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <div class="canvas-mark" aria-hidden="true">
              <Icon name="sparkles" size="md" />
            </div>
            <div class="min-w-0">
              <h1 class="truncate text-base font-semibold text-gray-950 dark:text-white">
                {{ t('infiniteCanvas.title') }}
              </h1>
              <p class="truncate text-xs text-gray-500 dark:text-dark-300">
                {{ t('infiniteCanvas.description') }}
              </p>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-end gap-2">
          <label v-if="apiKeys.length" class="canvas-key-picker">
            <span class="sr-only">{{ t('infiniteCanvas.selectKey') }}</span>
            <select
              v-model.number="selectedKeyId"
              class="canvas-key-select"
              :aria-label="t('infiniteCanvas.selectKey')"
              @change="handleKeyChange"
            >
              <option v-for="key in apiKeys" :key="key.id" :value="key.id">
                {{ key.name }} · {{ maskApiKey(key.key) }}
              </option>
            </select>
          </label>

          <span class="canvas-status" :class="`canvas-status--${canvasStatus}`">
            <span class="canvas-status-dot" aria-hidden="true"></span>
            {{ statusLabel }}
          </span>

          <button
            type="button"
            class="btn btn-secondary btn-sm"
            data-test="codex-agent-toggle"
            :aria-expanded="showAgentGuide"
            @click="showAgentGuide = !showAgentGuide"
          >
            <Icon name="terminal" size="sm" />
            <span class="hidden sm:inline">{{ t('infiniteCanvas.connectCodex') }}</span>
          </button>

          <button type="button" class="btn btn-secondary btn-sm" @click="reloadCanvas">
            <Icon name="refresh" size="sm" />
            <span class="hidden sm:inline">{{ t('common.refresh') }}</span>
          </button>
          <button type="button" class="btn btn-secondary btn-sm" @click="openStandalone">
            <Icon name="externalLink" size="sm" />
            <span class="hidden sm:inline">{{ t('infiniteCanvas.openStandalone') }}</span>
          </button>
        </div>
      </header>

      <div class="canvas-stage">
        <div v-if="loadingKeys" class="canvas-overlay">
          <div class="canvas-loader" aria-hidden="true"></div>
          <p>{{ t('infiniteCanvas.loadingKeys') }}</p>
        </div>

        <div v-else-if="!apiKeys.length" class="canvas-empty">
          <div class="canvas-empty-icon" aria-hidden="true">
            <Icon name="key" size="xl" />
          </div>
          <h2>{{ t('infiniteCanvas.noKeyTitle') }}</h2>
          <p>{{ t('infiniteCanvas.noKeyDescription') }}</p>
          <RouterLink to="/keys" class="btn btn-primary">
            {{ t('infiniteCanvas.manageKeys') }}
          </RouterLink>
        </div>

        <template v-else>
          <iframe
            :key="frameRevision"
            ref="canvasFrame"
            class="canvas-frame"
            :src="canvasUrl"
            :title="t('infiniteCanvas.frameTitle')"
            allow="clipboard-read; clipboard-write; fullscreen"
            referrerpolicy="same-origin"
            @load="handleFrameLoad"
          ></iframe>

          <div v-if="canvasStatus === 'connecting'" class="canvas-overlay canvas-overlay--glass">
            <div class="canvas-loader" aria-hidden="true"></div>
            <p>{{ t('infiniteCanvas.connecting') }}</p>
          </div>

          <div v-else-if="canvasStatus === 'error'" class="canvas-overlay canvas-overlay--glass">
            <div class="canvas-error-icon" aria-hidden="true">
              <Icon name="exclamationCircle" size="xl" />
            </div>
            <h2>{{ t('infiniteCanvas.connectionFailed') }}</h2>
            <p>{{ t('infiniteCanvas.connectionFailedDescription') }}</p>
            <button type="button" class="btn btn-primary" @click="reloadCanvas">
              {{ t('infiniteCanvas.retry') }}
            </button>
          </div>
        </template>

        <aside
          v-if="showAgentGuide"
          class="canvas-agent-card"
          data-test="codex-agent-card"
          aria-labelledby="codex-agent-card-title"
        >
          <div class="canvas-agent-card-header">
            <div class="min-w-0">
              <p class="canvas-agent-eyebrow">{{ t('infiniteCanvas.connectCodex') }}</p>
              <h2 id="codex-agent-card-title">{{ t('infiniteCanvas.codexHelpTitle') }}</h2>
            </div>
            <button
              type="button"
              class="canvas-agent-close"
              :aria-label="t('infiniteCanvas.closeCodexHelp')"
              @click="showAgentGuide = false"
            >
              <Icon name="x" size="sm" />
            </button>
          </div>

          <p class="canvas-agent-description">{{ t('infiniteCanvas.codexHelpDescription') }}</p>

          <a
            data-test="codex-agent-entry"
            class="canvas-agent-entry"
            :href="canvasEntryUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span class="min-w-0">
              <span class="block text-xs text-gray-500 dark:text-dark-300">{{ t('infiniteCanvas.fixedEntry') }}</span>
              <span class="block truncate">{{ canvasEntryUrl }}</span>
            </span>
            <Icon name="externalLink" size="sm" />
          </a>

          <div class="canvas-agent-command">
            <code>{{ AGENT_COMMAND }}</code>
            <button
              type="button"
              data-test="codex-agent-copy"
              class="canvas-agent-copy"
              :aria-label="t('infiniteCanvas.copyAgentCommand')"
              @click="copyAgentCommand"
            >
              <Icon :name="agentCommandCopied ? 'check' : 'copy'" size="sm" />
              <span class="sr-only">{{ t('infiniteCanvas.copyAgentCommand') }}</span>
            </button>
          </div>

          <div class="canvas-agent-status" :class="`canvas-agent-status--${agentStatus}`">
            <span class="canvas-status-dot" aria-hidden="true"></span>
            <span v-if="agentStatus === 'checking'">{{ t('infiniteCanvas.agentChecking') }}</span>
            <span v-else-if="agentStatus === 'available'">{{ t('infiniteCanvas.agentAvailable') }}</span>
            <span v-else>{{ t('infiniteCanvas.agentUnavailable') }}</span>
            <button type="button" class="canvas-agent-recheck" @click="checkAgent">
              {{ t('infiniteCanvas.checkAgentAgain') }}
            </button>
          </div>

          <div v-if="agentStatus === 'unavailable'" class="canvas-agent-fallback">
            <strong>{{ t('infiniteCanvas.downloadStartAgent') }}</strong>
            <p>{{ t('infiniteCanvas.downloadStartAgentDescription') }}</p>
          </div>

          <p class="canvas-agent-safety">{{ t('infiniteCanvas.noTokenInUrl') }}</p>
        </aside>
      </div>
    </section>
  </AppLayout>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { keysAPI } from '@/api/keys'
import AppLayout from '@/components/layout/AppLayout.vue'
import Icon from '@/components/icons/Icon.vue'
import {
  buildCanvasEntryUrl,
  buildCanvasInitMessage,
  buildGatewayBaseUrl,
  isTrustedCanvasConfiguredMessage,
  isTrustedCanvasReadyMessage,
  normalizeCanvasAppPath,
} from '@/features/infiniteCanvas/bridge'
import { getLocale } from '@/i18n'
import { useAppStore } from '@/stores/app'
import type { ApiKey } from '@/types'
import { maskApiKey } from '@/utils/maskApiKey'

const STORAGE_KEY = 'sub2:infinite-canvas:key-id'
const CONNECT_TIMEOUT_MS = 15_000
const AGENT_CHECK_TIMEOUT_MS = 1_800
const AGENT_CONFIG_URL = 'http://127.0.0.1:17371/config'
const AGENT_COMMAND = 'npx -y @basketikun/canvas-agent'

type CanvasStatus = 'idle' | 'connecting' | 'ready' | 'error'
type AgentStatus = 'checking' | 'available' | 'unavailable'

const { t } = useI18n()
const appStore = useAppStore()
const canvasFrame = ref<HTMLIFrameElement | null>(null)
const apiKeys = ref<ApiKey[]>([])
const selectedKeyId = ref<number | null>(null)
const loadingKeys = ref(true)
const frameRevision = ref(0)
const canvasStatus = ref<CanvasStatus>('idle')
const showAgentGuide = ref(false)
const agentStatus = ref<AgentStatus>('checking')
const agentCommandCopied = ref(false)
const canvasUrl = normalizeCanvasAppPath()
const canvasEntryUrl = buildCanvasEntryUrl(window.location.origin)
let agentCheckController: AbortController | null = null
let agentCheckTimer: ReturnType<typeof setTimeout> | null = null
let agentCopyTimer: ReturnType<typeof setTimeout> | null = null
let connectTimer: ReturnType<typeof setTimeout> | null = null
let themeObserver: MutationObserver | null = null

const selectedKey = computed(() =>
  apiKeys.value.find((key) => key.id === selectedKeyId.value) ?? null
)

const statusLabel = computed(() => {
  if (canvasStatus.value === 'ready') return t('infiniteCanvas.statusReady')
  if (canvasStatus.value === 'error') return t('infiniteCanvas.statusError')
  if (canvasStatus.value === 'connecting') return t('infiniteCanvas.statusConnecting')
  return t('infiniteCanvas.statusIdle')
})

function clearConnectTimer() {
  if (connectTimer) {
    clearTimeout(connectTimer)
    connectTimer = null
  }
}

function startConnectTimer() {
  clearConnectTimer()
  connectTimer = setTimeout(() => {
    if (canvasStatus.value !== 'ready') {
      canvasStatus.value = 'error'
    }
  }, CONNECT_TIMEOUT_MS)
}

function sendCanvasConfig() {
  const target = canvasFrame.value?.contentWindow
  const key = selectedKey.value
  if (!target || !key) return

  target.postMessage(
    buildCanvasInitMessage({
      baseUrl: buildGatewayBaseUrl(
        appStore.cachedPublicSettings?.api_base_url || window.location.origin
      ),
      apiKey: key.key,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      locale: getLocale() === 'zh' ? 'zh-CN' : 'en-US',
    }),
    window.location.origin
  )
}

function handleMessage(event: MessageEvent) {
  const target = canvasFrame.value?.contentWindow ?? null
  if (isTrustedCanvasReadyMessage(event, target, window.location.origin)) {
    sendCanvasConfig()
    return
  }
  if (isTrustedCanvasConfiguredMessage(event, target, window.location.origin)) {
    clearConnectTimer()
    canvasStatus.value = 'ready'
  }
}

function handleFrameLoad() {
  if (canvasStatus.value === 'ready') return
  canvasStatus.value = 'connecting'
  startConnectTimer()
}

function reloadCanvas() {
  clearConnectTimer()
  canvasStatus.value = apiKeys.value.length ? 'connecting' : 'idle'
  frameRevision.value += 1
  if (apiKeys.value.length) startConnectTimer()
}

function openStandalone() {
  window.open(canvasEntryUrl, '_blank', 'noopener,noreferrer')
}

async function checkAgent() {
  agentCheckController?.abort()
  if (agentCheckTimer) clearTimeout(agentCheckTimer)

  const controller = new AbortController()
  agentCheckController = controller
  agentStatus.value = 'checking'
  agentCheckTimer = setTimeout(() => controller.abort(), AGENT_CHECK_TIMEOUT_MS)

  try {
    const response = await fetch(AGENT_CONFIG_URL, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    })
    if (agentCheckController === controller) {
      agentStatus.value = response.ok ? 'available' : 'unavailable'
    }
  } catch {
    if (agentCheckController === controller) agentStatus.value = 'unavailable'
  } finally {
    if (agentCheckController === controller) {
      agentCheckController = null
      if (agentCheckTimer) {
        clearTimeout(agentCheckTimer)
        agentCheckTimer = null
      }
    }
  }
}

async function copyAgentCommand() {
  if (!navigator.clipboard?.writeText) return
  try {
    await navigator.clipboard.writeText(AGENT_COMMAND)
    agentCommandCopied.value = true
    if (agentCopyTimer) clearTimeout(agentCopyTimer)
    agentCopyTimer = setTimeout(() => {
      agentCommandCopied.value = false
    }, 1_800)
  } catch {
    agentCommandCopied.value = false
  }
}

function handleKeyChange() {
  if (selectedKeyId.value !== null) {
    localStorage.setItem(STORAGE_KEY, String(selectedKeyId.value))
  }
  if (canvasStatus.value === 'ready') {
    sendCanvasConfig()
  }
}

async function loadApiKeys() {
  loadingKeys.value = true
  try {
    const response = await keysAPI.list(1, 100, { status: 'active' })
    apiKeys.value = response.items.filter((key) => key.status === 'active' && Boolean(key.key))

    const storedId = Number(localStorage.getItem(STORAGE_KEY))
    const storedKey = Number.isFinite(storedId)
      ? apiKeys.value.find((key) => key.id === storedId)
      : undefined
    selectedKeyId.value = storedKey?.id ?? apiKeys.value[0]?.id ?? null

    if (selectedKeyId.value !== null) {
      localStorage.setItem(STORAGE_KEY, String(selectedKeyId.value))
      await nextTick()
      canvasStatus.value = 'connecting'
      startConnectTimer()
    }
  } catch (error) {
    apiKeys.value = []
    selectedKeyId.value = null
    appStore.showError(
      error instanceof Error ? error.message : t('infiniteCanvas.loadKeysFailed')
    )
  } finally {
    loadingKeys.value = false
  }
}

onMounted(() => {
  window.addEventListener('message', handleMessage)
  themeObserver = new MutationObserver(() => {
    if (canvasStatus.value === 'ready') sendCanvasConfig()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  void loadApiKeys()
  void checkAgent()
})

onBeforeUnmount(() => {
  window.removeEventListener('message', handleMessage)
  themeObserver?.disconnect()
  clearConnectTimer()
  agentCheckController?.abort()
  if (agentCheckTimer) clearTimeout(agentCheckTimer)
  if (agentCopyTimer) clearTimeout(agentCopyTimer)
})
</script>

<style scoped>
.canvas-page {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgb(229 231 235 / 0.9);
  border-radius: 1.25rem;
  background: rgb(255 255 255 / 0.82);
  box-shadow: 0 20px 60px rgb(15 23 42 / 0.1);
  backdrop-filter: blur(20px);
}

:global(.dark) .canvas-page {
  border-color: rgb(63 63 70 / 0.8);
  background: rgb(9 9 11 / 0.82);
  box-shadow: 0 24px 80px rgb(0 0 0 / 0.34);
}

.canvas-toolbar {
  display: flex;
  min-height: 4.5rem;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid rgb(229 231 235 / 0.85);
  padding: 0.75rem 1rem;
}

:global(.dark) .canvas-toolbar {
  border-color: rgb(63 63 70 / 0.75);
}

.canvas-mark {
  display: grid;
  width: 2.5rem;
  height: 2.5rem;
  flex: none;
  place-items: center;
  border-radius: 0.85rem;
  color: white;
  background: linear-gradient(135deg, #7c3aed, #2563eb 55%, #06b6d4);
  box-shadow: 0 10px 28px rgb(79 70 229 / 0.32);
}

.canvas-key-picker {
  display: flex;
  align-items: center;
}

.canvas-key-select {
  max-width: 15rem;
  height: 2.25rem;
  border: 1px solid rgb(209 213 219);
  border-radius: 0.65rem;
  background: rgb(255 255 255 / 0.88);
  padding: 0 2rem 0 0.75rem;
  color: rgb(31 41 55);
  font-size: 0.78rem;
  outline: none;
}

.canvas-key-select:focus {
  border-color: rgb(99 102 241);
  box-shadow: 0 0 0 3px rgb(99 102 241 / 0.15);
}

:global(.dark) .canvas-key-select {
  border-color: rgb(82 82 91);
  background: rgb(24 24 27 / 0.9);
  color: rgb(244 244 245);
}

.canvas-status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  height: 2.25rem;
  border-radius: 999px;
  padding: 0 0.7rem;
  background: rgb(244 244 245 / 0.9);
  color: rgb(82 82 91);
  font-size: 0.75rem;
  font-weight: 600;
}

.canvas-status-dot {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 999px;
  background: currentColor;
}

.canvas-status--ready {
  background: rgb(236 253 245);
  color: rgb(5 150 105);
}

.canvas-status--connecting {
  background: rgb(239 246 255);
  color: rgb(37 99 235);
}

.canvas-status--error {
  background: rgb(254 242 242);
  color: rgb(220 38 38);
}

:global(.dark) .canvas-status--ready {
  background: rgb(6 78 59 / 0.3);
  color: rgb(52 211 153);
}

:global(.dark) .canvas-status--connecting {
  background: rgb(30 64 175 / 0.25);
  color: rgb(96 165 250);
}

:global(.dark) .canvas-status--error {
  background: rgb(127 29 29 / 0.28);
  color: rgb(248 113 113);
}

.canvas-stage {
  position: relative;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
  background:
    radial-gradient(circle at 15% 15%, rgb(99 102 241 / 0.08), transparent 28%),
    radial-gradient(circle at 85% 10%, rgb(6 182 212 / 0.06), transparent 24%),
    rgb(248 250 252);
}

:global(.dark) .canvas-stage {
  background:
    radial-gradient(circle at 15% 15%, rgb(99 102 241 / 0.12), transparent 28%),
    radial-gradient(circle at 85% 10%, rgb(6 182 212 / 0.08), transparent 24%),
    rgb(9 9 11);
}

.canvas-frame {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  background: transparent;
}

.canvas-agent-card {
  position: absolute;
  z-index: 12;
  top: 1rem;
  right: 1rem;
  display: flex;
  width: min(26rem, calc(100% - 2rem));
  flex-direction: column;
  gap: 0.9rem;
  border: 1px solid rgb(199 210 254 / 0.9);
  border-radius: 1rem;
  background: rgb(255 255 255 / 0.96);
  padding: 1rem;
  color: rgb(31 41 55);
  box-shadow: 0 18px 50px rgb(15 23 42 / 0.2);
  backdrop-filter: blur(18px);
}

:global(.dark) .canvas-agent-card {
  border-color: rgb(67 56 202 / 0.65);
  background: rgb(24 24 27 / 0.96);
  color: rgb(244 244 245);
}

.canvas-agent-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.canvas-agent-eyebrow {
  color: rgb(79 70 229);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.canvas-agent-card h2 {
  margin-top: 0.2rem;
  font-size: 1rem;
  font-weight: 700;
}

.canvas-agent-close,
.canvas-agent-copy {
  display: grid;
  place-items: center;
  border-radius: 0.65rem;
  color: rgb(113 113 122);
}

.canvas-agent-close {
  width: 2rem;
  height: 2rem;
}

.canvas-agent-close:hover,
.canvas-agent-copy:hover {
  background: rgb(238 242 255);
  color: rgb(67 56 202);
}

:global(.dark) .canvas-agent-close:hover,
:global(.dark) .canvas-agent-copy:hover {
  background: rgb(49 46 129 / 0.35);
  color: rgb(165 180 252);
}

.canvas-agent-description,
.canvas-agent-fallback p,
.canvas-agent-safety {
  font-size: 0.78rem;
  line-height: 1.6;
}

.canvas-agent-description,
.canvas-agent-safety {
  color: rgb(82 82 91);
}

:global(.dark) .canvas-agent-description,
:global(.dark) .canvas-agent-safety {
  color: rgb(161 161 170);
}

.canvas-agent-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border: 1px solid rgb(224 231 255);
  border-radius: 0.8rem;
  background: rgb(238 242 255 / 0.68);
  padding: 0.7rem 0.8rem;
  color: rgb(55 48 163);
  font-size: 0.78rem;
  font-weight: 600;
}

:global(.dark) .canvas-agent-entry {
  border-color: rgb(67 56 202 / 0.55);
  background: rgb(49 46 129 / 0.25);
  color: rgb(199 210 254);
}

.canvas-agent-command {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  border: 1px solid rgb(229 231 235);
  border-radius: 0.8rem;
  background: rgb(249 250 251);
  padding: 0.55rem 0.7rem;
}

.canvas-agent-command code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: rgb(24 24 27);
  font-size: 0.75rem;
}

:global(.dark) .canvas-agent-command {
  border-color: rgb(63 63 70);
  background: rgb(9 9 11 / 0.7);
}

:global(.dark) .canvas-agent-command code {
  color: rgb(244 244 245);
}

.canvas-agent-copy {
  width: 2rem;
  height: 2rem;
  flex: none;
}

.canvas-agent-status {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  border-radius: 0.8rem;
  padding: 0.6rem 0.7rem;
  font-size: 0.75rem;
  font-weight: 600;
}

.canvas-agent-status--checking {
  background: rgb(239 246 255);
  color: rgb(37 99 235);
}

.canvas-agent-status--available {
  background: rgb(236 253 245);
  color: rgb(5 150 105);
}

.canvas-agent-status--unavailable {
  background: rgb(254 242 242);
  color: rgb(220 38 38);
}

.canvas-agent-recheck {
  margin-left: auto;
  color: inherit;
  font-size: 0.72rem;
  text-decoration: underline;
}

.canvas-agent-fallback {
  border-left: 3px solid rgb(245 158 11);
  border-radius: 0.2rem;
  background: rgb(255 251 235);
  padding: 0.7rem 0.8rem;
  color: rgb(146 64 14);
}

:global(.dark) .canvas-agent-fallback {
  background: rgb(120 53 15 / 0.2);
  color: rgb(253 186 116);
}

.canvas-overlay,
.canvas-empty {
  position: absolute;
  z-index: 5;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 0.8rem;
  padding: 2rem;
  color: rgb(82 82 91);
  text-align: center;
}

.canvas-overlay--glass {
  background: rgb(248 250 252 / 0.78);
  backdrop-filter: blur(12px);
}

:global(.dark) .canvas-overlay,
:global(.dark) .canvas-empty {
  color: rgb(161 161 170);
}

:global(.dark) .canvas-overlay--glass {
  background: rgb(9 9 11 / 0.78);
}

.canvas-empty h2,
.canvas-overlay h2 {
  color: rgb(24 24 27);
  font-size: 1.05rem;
  font-weight: 700;
}

:global(.dark) .canvas-empty h2,
:global(.dark) .canvas-overlay h2 {
  color: rgb(250 250 250);
}

.canvas-empty p,
.canvas-overlay p {
  max-width: 32rem;
  font-size: 0.875rem;
  line-height: 1.6;
}

.canvas-empty-icon,
.canvas-error-icon {
  display: grid;
  width: 4rem;
  height: 4rem;
  place-items: center;
  border-radius: 1.25rem;
  background: rgb(238 242 255);
  color: rgb(79 70 229);
}

.canvas-error-icon {
  background: rgb(254 226 226);
  color: rgb(220 38 38);
}

.canvas-loader {
  width: 2rem;
  height: 2rem;
  border: 2px solid rgb(99 102 241 / 0.18);
  border-top-color: rgb(79 70 229);
  border-radius: 999px;
  animation: canvas-spin 0.75s linear infinite;
}

@keyframes canvas-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 767px) {
  .canvas-page {
    flex: 1 1 auto;
    min-height: 0;
    margin: -0.25rem;
    border-radius: 1rem;
  }

  .canvas-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .canvas-toolbar > div:last-child {
    width: 100%;
    justify-content: flex-start;
  }

  .canvas-agent-card {
    top: 0.75rem;
    right: 0.75rem;
  }

  .canvas-key-picker,
  .canvas-key-select {
    min-width: 0;
    flex: 1;
  }
}
</style>
