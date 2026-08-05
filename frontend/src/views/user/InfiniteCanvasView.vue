<template>
  <AppLayout>
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

type CanvasStatus = 'idle' | 'connecting' | 'ready' | 'error'

const { t } = useI18n()
const appStore = useAppStore()
const canvasFrame = ref<HTMLIFrameElement | null>(null)
const apiKeys = ref<ApiKey[]>([])
const selectedKeyId = ref<number | null>(null)
const loadingKeys = ref(true)
const frameRevision = ref(0)
const canvasStatus = ref<CanvasStatus>('idle')
const canvasUrl = normalizeCanvasAppPath()
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
      baseUrl: buildGatewayBaseUrl(window.location.origin),
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
  window.open(canvasUrl, '_blank', 'noopener,noreferrer')
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
})

onBeforeUnmount(() => {
  window.removeEventListener('message', handleMessage)
  themeObserver?.disconnect()
  clearConnectTimer()
})
</script>

<style scoped>
.canvas-page {
  display: flex;
  min-height: calc(100vh - 7.5rem);
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
  min-height: 34rem;
  flex: 1;
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
  min-height: 34rem;
  border: 0;
  background: transparent;
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
    min-height: calc(100vh - 6rem);
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

  .canvas-key-picker,
  .canvas-key-select {
    min-width: 0;
    flex: 1;
  }
}
</style>
