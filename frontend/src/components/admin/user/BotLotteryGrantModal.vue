<template>
  <BaseDialog :show="show" :title="targetUser ? t('admin.botLottery.grantTitle') : t('admin.botLottery.grantAllTitle')" width="wide" @close="emit('close')">
    <div class="space-y-5">
      <div v-if="targetUser" class="rounded-xl bg-gray-50 p-4 dark:bg-dark-700">
        <p class="font-medium text-gray-900 dark:text-white">{{ targetUser.email }}</p>
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.botLottery.remaining') }}: {{ remaining }}</p>
      </div>
      <p v-else class="rounded-lg bg-blue-50 p-4 text-sm text-blue-800 dark:bg-blue-950 dark:text-blue-200">{{ t('admin.botLottery.allUsersHint') }}</p>

      <div v-if="!activeBatch || activeBatch.status === 'completed'" class="grid gap-4 md:grid-cols-2">
        <label class="block"><span class="input-label">{{ t('admin.botLottery.count') }}</span><input v-model.number="count" class="input" type="number" min="1" max="100000" step="1" required data-test="grant-count" /></label>
        <label class="block"><span class="input-label">{{ t('admin.botLottery.notes') }}</span><input v-model.trim="notes" class="input" maxlength="255" data-test="grant-notes" /></label>
      </div>

      <div v-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">{{ error }}</div>
      <p v-if="successMessage" role="status" class="text-sm text-emerald-700 dark:text-emerald-300">{{ successMessage }}</p>

      <template v-if="history && targetUser">
        <div class="flex items-center justify-between border-t border-gray-100 pt-4 dark:border-dark-700">
          <h4 class="font-semibold text-gray-900 dark:text-white">{{ t('admin.botLottery.records') }}</h4>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="loadingHistory" @click="loadHistory">{{ t('common.refresh') }}</button>
        </div>
        <div class="max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-dark-600">
          <table class="w-full text-left text-sm">
            <thead class="sticky top-0 bg-gray-50 text-xs text-gray-500 dark:bg-dark-700"><tr><th class="px-3 py-2">{{ t('admin.botLottery.recordAction') }}</th><th class="px-3 py-2">{{ t('admin.botLottery.recordCount') }}</th><th class="px-3 py-2">{{ t('admin.botLottery.recordRemaining') }}</th><th class="px-3 py-2">{{ t('admin.botLottery.recordReward') }}</th><th class="px-3 py-2">{{ t('admin.botLottery.recordNotes') }}</th><th class="px-3 py-2">{{ t('admin.botLottery.recordTime') }}</th></tr></thead>
            <tbody><tr v-for="record in history.records" :key="record.id" class="border-t border-gray-100 dark:border-dark-700"><td class="px-3 py-2">{{ record.action === 'draw' ? t('admin.botLottery.actionDraw') : t('admin.botLottery.actionGrant') }}<span v-if="record.prize_name"> · {{ record.prize_name }}</span></td><td class="px-3 py-2">{{ record.action === 'draw' ? -record.count : `+${record.count}` }}</td><td class="px-3 py-2">{{ record.remaining }}</td><td class="px-3 py-2">{{ record.action === 'draw' && record.reward != null ? `$${record.reward.toFixed(8)}` : '-' }}</td><td class="max-w-40 truncate px-3 py-2" :title="record.notes || ''">{{ record.notes || '-' }}</td><td class="whitespace-nowrap px-3 py-2">{{ formatTime(record.created_at) }}</td></tr></tbody>
          </table>
          <p v-if="!loadingHistory && history.records.length === 0" class="px-4 py-6 text-center text-sm text-gray-500">{{ t('admin.botLottery.noRecords') }}</p>
        </div>
      </template>

      <div v-if="activeBatch" class="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-dark-600" data-test="lottery-batch-status">
        <div class="flex flex-wrap items-center justify-between gap-2"><h4 class="font-semibold text-gray-900 dark:text-white">{{ t('admin.botLottery.batchId') }}: {{ activeBatch.batch_id }}</h4><span class="rounded-full bg-blue-50 px-3 py-1 text-sm text-blue-700 dark:bg-blue-950 dark:text-blue-200">{{ activeBatch.status === 'completed' ? t('admin.botLottery.batchCompleted') : t('admin.botLottery.batchPending') }}</span></div>
        <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('admin.botLottery.copyBatchId') }}</p>
        <div class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5"><div>{{ t('admin.botLottery.batchTotal') }}: <strong>{{ activeBatch.total }}</strong></div><div>{{ t('admin.botLottery.batchSuccess') }}: <strong>{{ activeBatch.success }}</strong></div><div>{{ t('admin.botLottery.batchSkipped') }}: <strong>{{ activeBatch.skipped ?? 0 }}</strong></div><div>{{ t('admin.botLottery.batchFailed') }}: <strong>{{ activeBatch.failed }}</strong></div><div>{{ t('admin.botLottery.batchRemaining') }}: <strong>{{ activeBatch.pending }}</strong></div></div>
        <div v-if="activeBatch.items?.length" class="max-h-48 overflow-auto rounded-lg border border-gray-200 dark:border-dark-600"><table class="w-full text-left text-sm"><thead class="sticky top-0 bg-gray-50 text-xs text-gray-500 dark:bg-dark-700"><tr><th class="px-3 py-2">{{ t('admin.botLottery.batchUserId') }}</th><th class="px-3 py-2">{{ t('admin.botLottery.batchStatus') }}</th><th class="px-3 py-2">{{ t('admin.botLottery.batchError') }}</th></tr></thead><tbody><tr v-for="item in activeBatch.items" :key="item.user_id" class="border-t border-gray-100 dark:border-dark-700"><td class="px-3 py-2">{{ item.user_id }}</td><td class="px-3 py-2">{{ batchItemStatus(item.status) }}</td><td class="px-3 py-2">{{ batchItemError(item.error) }}</td></tr></tbody></table></div>
        <button v-if="activeBatch.status === 'completed'" type="button" class="btn btn-secondary btn-sm" data-test="new-lottery-batch" @click="activeBatch = null">{{ t('admin.botLottery.allUsersButton') }}</button>
      </div>

      <div v-if="!targetUser" class="flex items-end gap-2 border-t border-gray-100 pt-4 dark:border-dark-700">
        <label class="block flex-1"><span class="input-label">{{ t('admin.botLottery.batchId') }}</span><input v-model.number="batchQueryId" class="input" type="number" min="1" step="1" data-test="batch-query-id" /></label>
        <button type="button" class="btn btn-secondary" :disabled="!Number.isSafeInteger(batchQueryId) || batchQueryId < 1" data-test="query-lottery-batch" @click="queryBatch">{{ t('admin.botLottery.batchStatus') }}</button>
      </div>
    </div>
    <template #footer>
      <div class="flex justify-end gap-3">
        <button type="button" class="btn btn-secondary" @click="emit('close')">{{ t('common.close') }}</button>
        <button v-if="!activeBatch || activeBatch.status === 'completed'" type="button" class="btn btn-primary" data-test="submit-lottery-grant" :disabled="submitting || !validCount" @click="submit">{{ submitting ? t('admin.botLottery.granting') : t('admin.botLottery.grant') }}</button>
      </div>
    </template>
  </BaseDialog>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseDialog from '@/components/common/BaseDialog.vue'
import { adminAPI } from '@/api/admin'
import type { AdminUser } from '@/types'
import type { BotLotteryGrantBatch, BotLotteryUserHistory } from '@/api/admin/botLottery'
import { extractApiErrorMessage } from '@/utils/apiError'

const props = defineProps<{ show: boolean; user: AdminUser | null }>()
const emit = defineEmits<{ (event: 'close'): void; (event: 'success'): void }>()
const { t } = useI18n()
const count = ref(1)
const notes = ref('')
const remaining = ref(0)
const history = ref<BotLotteryUserHistory | null>(null)
const activeBatch = ref<BotLotteryGrantBatch | null>(null)
const batchQueryId = ref(0)
const error = ref('')
const successMessage = ref('')
const submitting = ref(false)
const loadingHistory = ref(false)
const validCount = computed(() => Number.isSafeInteger(count.value) && count.value > 0 && count.value <= 100_000)
const targetUser = computed(() => props.user)
let pollTimer: ReturnType<typeof setTimeout> | undefined
let requestVersion = 0
let polling = false
let pollingVersion = -1
type PendingGrant = { requestId: string; count: number; notes: string }
const pendingGrant = ref<PendingGrant | null>(null)

function pendingStorageKey(userId: number | undefined) {
  return `sub2api:bot-lottery:pending:${userId ?? 'all'}`
}

function batchStorageKey() {
  return 'sub2api:bot-lottery:last-batch'
}

function readStoredValue<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}

function writeStoredValue(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* storage may be disabled by the browser */ }
}

function removeStoredValue(key: string) {
  try { localStorage.removeItem(key) } catch { /* storage may be disabled by the browser */ }
}

function batchItemStatus(status: string) {
  if (status === 'pending') return t('admin.botLottery.batchPending')
  if (status === 'success') return t('admin.botLottery.batchItemSuccess')
  if (status === 'skipped') return t('admin.botLottery.batchItemSkipped')
  if (status === 'failed') return t('admin.botLottery.batchItemFailed')
  return status
}

function batchItemError(error?: string) {
  if (error?.toLowerCase() === 'user_inactive') return t('admin.botLottery.userInactive')
  if (error?.toLowerCase() === 'binding_inactive') return t('admin.botLottery.bindingInactive')
  return error || '-'
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = undefined
}

async function loadHistory() {
  if (!props.user) return
  const version = ++requestVersion
  loadingHistory.value = true
  try {
    const response = await adminAPI.botLottery.getUserHistory(props.user.id)
    if (version !== requestVersion) return
    history.value = response
    remaining.value = response.remaining
  } catch (cause) {
    if (version === requestVersion) error.value = extractApiErrorMessage(cause, t('admin.botLottery.loadFailed'))
  } finally {
    if (version === requestVersion) loadingHistory.value = false
  }
}

async function pollBatch(batchId: number) {
  if ((polling && pollingVersion === requestVersion) || !props.show) return
  const version = requestVersion
  polling = true
  pollingVersion = version
  try {
    const response = await adminAPI.botLottery.getGrantBatch(batchId)
    if (version !== requestVersion || !props.show) return
    activeBatch.value = response
    batchQueryId.value = response.batch_id
    if (response.status === 'completed') {
      emit('success')
      stopPolling()
      return
    }
  } catch (cause) {
    if (version === requestVersion) error.value = extractApiErrorMessage(cause, t('admin.botLottery.grantFailed'))
  } finally {
    if (pollingVersion === version) polling = false
  }
  if (version === requestVersion && props.show && activeBatch.value?.status !== 'completed') pollTimer = setTimeout(() => pollBatch(batchId), 2000)
}

async function queryBatch() {
  if (!Number.isSafeInteger(batchQueryId.value) || batchQueryId.value < 1) return
  requestVersion++
  stopPolling()
  activeBatch.value = null
  error.value = ''
  await pollBatch(batchQueryId.value)
}

async function submit() {
  if (!validCount.value || submitting.value) {
    if (!validCount.value) error.value = t('admin.botLottery.invalidCount')
    return
  }
  const isAll = !props.user
  const targetId = props.user?.id
  const version = requestVersion
  if (isAll && !window.confirm(t('admin.botLottery.confirmAll', { count: count.value }))) return
  submitting.value = true
  error.value = ''
  successMessage.value = ''
  try {
    const stored = pendingGrant.value ?? readStoredValue<PendingGrant>(pendingStorageKey(targetId))
    if (stored && (stored.count !== count.value || stored.notes !== notes.value)) {
      error.value = t('admin.botLottery.pendingGrantMismatch')
      return
    }
    const request = stored ?? {
      requestId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      count: count.value,
      notes: notes.value
    }
    pendingGrant.value = request
    writeStoredValue(pendingStorageKey(targetId), JSON.stringify(request))
    const result = await adminAPI.botLottery.grant({
      ...(targetId ? { user_id: targetId } : { target: 'all' as const }),
      count: request.count,
      notes: request.notes,
      request_id: request.requestId
    })
    removeStoredValue(pendingStorageKey(targetId))
    if ('batch_id' in result) writeStoredValue(batchStorageKey(), String(result.batch_id))
    if (version !== requestVersion || !props.show) return
    pendingGrant.value = null
    if ('batch_id' in result) {
      activeBatch.value = result
      batchQueryId.value = result.batch_id
      void pollBatch(result.batch_id)
    } else {
      remaining.value = result.remaining
      successMessage.value = t('common.success')
      emit('success')
      await loadHistory()
    }
  } catch (cause) {
    const status = typeof cause === 'object' && cause !== null && 'status' in cause ? Number(cause.status) : 0
    if (status >= 400 && status < 500 && status !== 408 && status !== 409) {
      if (version === requestVersion) pendingGrant.value = null
      removeStoredValue(pendingStorageKey(targetId))
    }
    if (version === requestVersion) error.value = extractApiErrorMessage(cause, t('admin.botLottery.grantFailed'))
  } finally {
    submitting.value = false
  }
}

watch(() => [props.show, props.user?.id] as const, ([visible]) => {
  requestVersion++
  stopPolling()
  history.value = null
  activeBatch.value = null
  error.value = ''
  successMessage.value = ''
  pendingGrant.value = null
  if (!visible) return
  count.value = 1
  notes.value = ''
  const stored = readStoredValue<PendingGrant>(pendingStorageKey(props.user?.id))
  if (stored) {
    pendingGrant.value = stored
    count.value = stored.count
    notes.value = stored.notes
  }
  if (props.user) {
    void loadHistory()
  } else {
    const previousBatchId = Number(readStoredValue<string>(batchStorageKey()) ?? 0)
    if (Number.isSafeInteger(previousBatchId) && previousBatchId > 0) {
      batchQueryId.value = previousBatchId
      void pollBatch(previousBatchId)
    }
  }
}, { immediate: true })

onUnmounted(() => {
  requestVersion++
  stopPolling()
})
</script>
