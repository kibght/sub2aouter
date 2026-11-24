<template>
  <section class="card space-y-5 p-6" data-test="bot-lottery-settings">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white">{{ t('admin.botLottery.title') }}</h2>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{{ t('admin.botLottery.description') }}</p>
      </div>
      <div :class="{ 'pointer-events-none opacity-50': loading || saving }"><Toggle v-model="config.enabled" /></div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-50 px-4 py-3 dark:bg-dark-700">
      <div>
        <p class="font-medium text-gray-900 dark:text-white">{{ t('admin.botLottery.enabled') }}</p>
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.botLottery.enabledHint') }}</p>
      </div>
      <span class="text-sm text-gray-500 dark:text-gray-400">{{ t('admin.botLottery.prizePoolTotal', { total: totalWeight }) }}</span>
    </div>

    <div v-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">{{ error }}</div>
    <p v-if="successMessage" role="status" class="text-sm text-emerald-700 dark:text-emerald-300">{{ successMessage }}</p>
    <div v-if="loading" class="py-4 text-center text-sm text-gray-500">{{ t('common.loading') }}</div>
    <template v-else>
      <div v-if="config.prizes.length === 0" class="rounded border border-dashed border-gray-300 px-4 py-5 text-center text-sm text-gray-500 dark:border-dark-600">{{ t('admin.botLottery.emptyPrizes') }}</div>
      <div v-else class="space-y-3">
        <div v-for="(prize, index) in config.prizes" :key="prize.id" class="grid grid-cols-1 items-end gap-3 rounded-lg border border-gray-200 p-4 dark:border-dark-600 md:grid-cols-[minmax(0,1fr)_150px_120px_100px_auto]">
          <label class="block"><span class="input-label">{{ t('admin.botLottery.prizeName') }}</span><input v-model.trim="prize.name" class="input" maxlength="80" required /></label>
          <label class="block"><span class="input-label">{{ t('admin.botLottery.prizeAmount') }}</span><input v-model.number="prize.amount" class="input" type="number" min="0" max="1000000" step="0.00000001" required /></label>
          <label class="block"><span class="input-label">{{ t('admin.botLottery.prizeWeight') }}</span><input v-model.number="prize.weight" class="input" type="number" min="1" max="1000000" step="1" required /></label>
          <p class="pb-2 text-sm text-gray-500">{{ t('admin.botLottery.probability') }}: {{ formatProbability(prize.weight) }}</p>
          <button type="button" class="btn btn-secondary" :aria-label="`${t('admin.botLottery.removePrize')} ${prize.name || index + 1}`" @click="removePrize(index)">{{ t('admin.botLottery.removePrize') }}</button>
        </div>
      </div>

      <div class="flex flex-wrap justify-between gap-3">
        <button type="button" class="btn btn-secondary" :disabled="config.prizes.length >= 100" @click="addPrize">{{ t('admin.botLottery.addPrize') }}</button>
        <button type="button" class="btn btn-primary" data-test="save-lottery-settings" :disabled="saving || !loaded || !valid" @click="save">
          {{ saving ? t('admin.botLottery.saving') : t('admin.botLottery.save') }}
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminAPI } from '@/api/admin'
import { extractApiErrorMessage } from '@/utils/apiError'
import type { BotLotteryConfig, BotLotteryPrize } from '@/api/admin/botLottery'
import Toggle from '@/components/common/Toggle.vue'

const { t } = useI18n()
const loading = ref(true)
const loaded = ref(false)
const saving = ref(false)
const error = ref('')
const successMessage = ref('')
const config = reactive<BotLotteryConfig>({ enabled: false, prizes: [] })
const totalWeight = computed(() => config.prizes.reduce((sum, prize) => sum + (Number(prize.weight) || 0), 0))
const valid = computed(() => {
  const ids = config.prizes.map(prize => prize.id.trim())
  const validPrizes = new Set(ids).size === ids.length && config.prizes.every(prize =>
    prize.id.trim().length > 0 && prize.name.trim().length > 0
    && Number.isFinite(prize.amount) && prize.amount >= 0 && prize.amount <= 1_000_000 && Number(prize.amount.toFixed(8)) === prize.amount
    && Number.isSafeInteger(prize.weight) && prize.weight > 0 && prize.weight <= 1_000_000
  )
  return validPrizes && config.prizes.length <= 100 && (!config.enabled || (config.prizes.length > 0 && totalWeight.value > 0))
})

function formatProbability(weight: number): string {
  return totalWeight.value > 0 ? `${((weight / totalWeight.value) * 100).toFixed(2)}%` : '0.00%'
}

function newPrize(): BotLotteryPrize {
  return { id: globalThis.crypto?.randomUUID?.() ?? `prize-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: '', amount: 0, weight: 1 }
}

function addPrize() {
  config.prizes.push(newPrize())
}

function removePrize(index: number) {
  config.prizes.splice(index, 1)
}

async function load() {
  loading.value = true
  error.value = ''
  successMessage.value = ''
  try {
    const response = await adminAPI.botLottery.getConfig()
    config.enabled = response.enabled === true
    config.prizes.splice(0, config.prizes.length, ...(Array.isArray(response.prizes) ? response.prizes.map(prize => ({ ...prize })) : []))
    loaded.value = true
  } catch (cause) {
    error.value = extractApiErrorMessage(cause, t('admin.botLottery.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!valid.value || saving.value || !loaded.value) {
    if (!valid.value) error.value = t('admin.botLottery.invalidPool')
    return
  }
  saving.value = true
  error.value = ''
  successMessage.value = ''
  try {
    const response = await adminAPI.botLottery.updateConfig({
      enabled: config.enabled,
      prizes: config.prizes.map(prize => ({ ...prize, amount: Number(prize.amount), weight: Number(prize.weight) }))
    })
    config.enabled = response.enabled === true
    config.prizes.splice(0, config.prizes.length, ...(response.prizes || []).map(prize => ({ ...prize })))
    successMessage.value = t('admin.botLottery.saved')
  } catch (cause) {
    error.value = extractApiErrorMessage(cause, t('admin.botLottery.saveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>
