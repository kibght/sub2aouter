<template>
  <div class="card">
    <div class="flex items-start justify-between border-b border-gray-100 px-6 py-4 dark:border-dark-700">
      <div>
        <h2 class="text-lg font-medium text-gray-900 dark:text-white">
          {{ t('profile.botBinding.title') }}
        </h2>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {{ t('profile.botBinding.description') }}
        </p>
      </div>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="busy"
        @click="generateCode"
      >
        {{ busy ? t('profile.botBinding.generating') : t('profile.botBinding.generate') }}
      </button>
    </div>

    <div class="px-6 py-6">
      <div v-if="loading" class="flex justify-center py-6">
        <div class="h-8 w-8 animate-spin rounded-full border-b-2 border-primary-500"></div>
      </div>

      <div
        v-else-if="bindings.length === 0"
        class="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-500 dark:border-dark-700 dark:text-gray-400"
      >
        <p>{{ t('profile.botBinding.empty') }}</p>
        <div class="mt-4 text-left">
          <p class="font-medium text-gray-700 dark:text-gray-300">
            {{ t('profile.botBinding.guideTitle') }}
          </p>
          <ol class="mt-2 list-decimal space-y-1 pl-5">
            <li>{{ t('profile.botBinding.step1') }}</li>
            <li>{{ t('profile.botBinding.step2') }}</li>
            <li>{{ t('profile.botBinding.step3') }}</li>
          </ol>
        </div>
      </div>

      <div v-else class="divide-y divide-gray-100 dark:divide-dark-700">
        <div
          v-for="binding in bindings"
          :key="binding.id"
          data-testid="bot-binding-row"
          class="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <Icon name="chatBubble" size="md" class="shrink-0 text-primary-500" />
              <span
                class="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-700 dark:bg-primary-900/30 dark:text-primary-300"
              >
                {{ binding.platform }}
              </span>
              <p class="truncate font-medium text-gray-900 dark:text-white">
                {{ binding.external_id }}
              </p>
            </div>
            <dl class="mt-2 grid gap-x-6 gap-y-1 text-xs text-gray-500 dark:text-gray-400 sm:grid-cols-2">
              <div class="flex gap-1">
                <dt>{{ t('profile.botBinding.boundAt') }}</dt>
                <dd>{{ formatDate(binding.bound_at) }}</dd>
              </div>
              <div class="flex gap-1">
                <dt>{{ t('profile.botBinding.lastUsedAt') }}</dt>
                <dd>{{ binding.last_used_at ? formatDate(binding.last_used_at) : t('profile.botBinding.neverUsed') }}</dd>
              </div>
              <div class="flex gap-1">
                <dt>{{ t('profile.botBinding.tokenPrefix') }}</dt>
                <dd>
                  <code class="font-mono text-xs">{{ binding.token_prefix }}</code>
                </dd>
              </div>
            </dl>
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-sm text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
            :disabled="busy"
            @click="askUnbind(binding)"
          >
            {{ t('profile.botBinding.unbind') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 解绑确认 -->
    <div v-if="unbindTarget" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex min-h-full items-center justify-center p-4">
        <div class="fixed inset-0 bg-black/50 transition-opacity" @click="closeUnbindDialog"></div>
        <div
          class="relative w-full max-w-md transform rounded-xl bg-white p-6 shadow-xl transition-all dark:bg-dark-800"
        >
          <h3 class="text-lg font-semibold text-gray-900 dark:text-white">
            {{ t('profile.botBinding.unbindTitle') }}
          </h3>
          <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {{ t('profile.botBinding.unbindConfirm', { name: unbindTarget.external_id }) }}
          </p>
          <div class="mt-4 flex justify-end gap-3">
            <button type="button" class="btn btn-secondary" :disabled="busy" @click="closeUnbindDialog">
              {{ t('common.cancel') }}
            </button>
            <button type="button" class="btn btn-danger" :disabled="busy" @click="confirmUnbind">
              {{ busy ? t('common.processing') : t('profile.botBinding.unbind') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 绑定码弹窗 -->
    <div v-if="bindingCode" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex min-h-full items-center justify-center p-4">
        <div class="fixed inset-0 bg-black/50 transition-opacity" @click="closeCodeDialog"></div>
        <div
          class="relative w-full max-w-md transform rounded-xl bg-white p-6 shadow-xl transition-all dark:bg-dark-800"
        >
          <h3 class="text-lg font-semibold text-gray-900 dark:text-white">
            {{ t('profile.botBinding.codeTitle') }}
          </h3>
          <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {{ t('profile.botBinding.codeDescription') }}
          </p>

          <div class="mt-4 rounded-lg border border-gray-200 px-4 py-4 text-center dark:border-dark-700">
            <p
              data-testid="bot-binding-code"
              class="break-all font-mono text-xl font-semibold tracking-[0.2em] text-gray-900 sm:text-2xl sm:tracking-[0.35em] dark:text-white"
            >
              {{ bindingCode.code }}
            </p>
          </div>

          <div class="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
            <span class="text-gray-500 dark:text-gray-400">
              {{
                remainingSeconds > 0
                  ? t('profile.botBinding.expiresIn', { time: countdownLabel })
                  : t('profile.botBinding.expired')
              }}
            </span>
            <button type="button" class="btn btn-secondary btn-sm" @click="copyCode">
              <Icon :name="copied ? 'check' : 'copy'" size="sm" class="mr-1" />
              {{ copied ? t('profile.botBinding.copied') : t('profile.botBinding.copy') }}
            </button>
          </div>

          <div class="mt-4 rounded-lg bg-gray-50 px-4 py-3 dark:bg-dark-900">
            <p class="text-xs text-gray-500 dark:text-gray-400">
              {{ t('profile.botBinding.commandHint') }}
            </p>
            <code
              data-testid="bot-binding-command"
              class="mt-1 block break-all font-mono text-sm text-gray-900 dark:text-white"
            >
              {{ t('profile.botBinding.commandExample', { code: bindingCode.code }) }}
            </code>
          </div>

          <p class="mt-3 text-xs text-gray-500 dark:text-gray-400">
            {{ t('profile.botBinding.validHint') }}
          </p>

          <div class="mt-5 flex justify-end">
            <button type="button" class="btn btn-primary" @click="closeCodeDialog">
              {{ t('common.close') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { botBindingsAPI, type BotBinding, type BotBindingCode } from '@/api'
import { Icon } from '@/components/icons'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
const appStore = useAppStore()

const bindings = ref<BotBinding[]>([])
const loading = ref(false)
const busy = ref(false)
const bindingCode = ref<BotBindingCode | null>(null)
const unbindTarget = ref<BotBinding | null>(null)
const remainingSeconds = ref(0)
const copied = ref(false)
let countdownTimer: ReturnType<typeof setInterval> | null = null

const countdownLabel = computed(() => {
  const total = Math.max(0, remainingSeconds.value)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
})

// apiClient 拦截器把错误规范化为 { code, reason, message }；
// 优先透出后端消息，否则回退到 i18n 兜底文案。
function extractErrorMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: string } | null)?.message
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

async function loadBindings(): Promise<void> {
  loading.value = true
  try {
    const response = await botBindingsAPI.list()
    bindings.value = Array.isArray(response?.items) ? response.items : []
  } catch (error) {
    appStore.showError(extractErrorMessage(error, t('profile.botBinding.loadFailed')))
  } finally {
    loading.value = false
  }
}

async function generateCode(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const created = await botBindingsAPI.createCode()
    bindingCode.value = created
    copied.value = false
    startCountdown(created.expires_in_seconds)
    appStore.showSuccess(t('profile.botBinding.codeCreated'))
  } catch (error) {
    appStore.showError(extractErrorMessage(error, t('profile.botBinding.createFailed')))
  } finally {
    busy.value = false
  }
}

function startCountdown(seconds: number): void {
  stopCountdown()
  const initial = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  remainingSeconds.value = initial
  if (initial <= 0) return
  countdownTimer = setInterval(() => {
    if (remainingSeconds.value <= 1) {
      remainingSeconds.value = 0
      stopCountdown()
      return
    }
    remainingSeconds.value -= 1
  }, 1000)
}

function stopCountdown(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

function closeCodeDialog(): void {
  bindingCode.value = null
  copied.value = false
  remainingSeconds.value = 0
  stopCountdown()
  // 绑定码可能已被使用，关闭弹窗后同步最新的绑定列表
  void loadBindings()
}

async function copyCode(): Promise<void> {
  const value = bindingCode.value?.code
  if (!value) return
  const success = await writeToClipboard(value)
  if (success) {
    copied.value = true
    appStore.showSuccess(t('profile.botBinding.copied'))
  } else {
    appStore.showError(t('profile.botBinding.copyFailed'))
  }
}

async function writeToClipboard(value: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // 权限被拒绝等情况回退到 execCommand
    }
  }
  return legacyCopy(value)
}

function legacyCopy(value: string): boolean {
  if (typeof document === 'undefined') return false
  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copiedByCommand =
      typeof document.execCommand === 'function' && document.execCommand('copy')
    document.body.removeChild(textarea)
    return copiedByCommand
  } catch {
    return false
  }
}

function askUnbind(binding: BotBinding): void {
  unbindTarget.value = binding
}

function closeUnbindDialog(): void {
  unbindTarget.value = null
}

async function confirmUnbind(): Promise<void> {
  const target = unbindTarget.value
  if (!target || busy.value) return
  busy.value = true
  try {
    await botBindingsAPI.revoke(target.id)
    bindings.value = bindings.value.filter((item) => item.id !== target.id)
    appStore.showSuccess(t('profile.botBinding.unbindSuccess'))
    closeUnbindDialog()
  } catch (error) {
    appStore.showError(extractErrorMessage(error, t('profile.botBinding.unbindFailed')))
  } finally {
    busy.value = false
  }
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

onMounted(() => {
  void loadBindings()
})

onUnmounted(stopCountdown)
</script>
