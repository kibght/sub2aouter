<template>
  <section id="models" class="model-section section-pad" aria-labelledby="models-heading">
    <div class="container">
      <div class="section-heading">
        <div>
          <span class="section-index">04 / 模型网络</span>
          <h2 id="models-heading">一个入口。<br /><span class="muted-heading">连接更多可能。</span></h2>
        </div>
        <div class="section-intro">
          <p>从日常对话到复杂代码任务，<br />为你的应用找到合适的模型。</p>
          <RouterLink to="/model-plaza" class="text-link">探索模型广场 <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></RouterLink>
        </div>
      </div>
      <div v-if="status === 'ready'" class="model-toolbar">
        <div class="segment provider-tabs" role="group" aria-label="模型供应商">
          <button type="button" :aria-pressed="platform === 'all'" :class="{ active: platform === 'all' }" @click="platform = 'all'">全部模型</button>
          <button v-for="item in platforms" :key="item" type="button" :aria-pressed="platform === item" :class="{ active: platform === item }" @click="platform = item">{{ vendorLabel(item) }}</button>
        </div>
        <div class="model-filters">
          <label class="group-filter">
            <span class="sr-only">选择计费分组</span>
            <select v-model="groupId" data-test="home-pricing-group">
              <option value="all">全部分组</option>
              <option v-for="group in availableGroups" :key="group.id" :value="String(group.id)">{{ group.name }}</option>
            </select>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
          </label>
          <label class="search-field">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
            <input v-model="search" data-test="home-pricing-search" placeholder="搜索模型" aria-label="搜索模型名称或分组" />
          </label>
        </div>
      </div>
      <div v-if="status === 'loading'" class="pricing-state" role="status">
        <span class="pricing-spinner" aria-hidden="true"></span>{{ t('modelPlaza.loading') }}
      </div>
      <div v-else-if="status === 'login'" class="pricing-state" data-test="home-pricing-login">
        <p>{{ t('modelPlaza.anonymousHint') }}</p>
        <RouterLink to="/login?redirect=%2Fhome%23models" class="text-link">{{ t('modelPlaza.nav.login') }} <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></RouterLink>
      </div>
      <div v-else-if="status === 'disabled' || status === 'forbidden'" class="pricing-state" data-test="home-pricing-unavailable">
        <p>{{ t('modelPlaza.title') }} · {{ t('common.notAvailable') }}</p>
      </div>
      <div v-else-if="status === 'error'" class="pricing-state" data-test="home-pricing-error" role="status">
        <p>{{ t('modelPlaza.loadFailed') }}</p>
        <button type="button" class="text-link" @click="loadPrices">{{ t('common.tryAgain') }}</button>
      </div>
      <template v-else>
        <div class="model-table-wrap">
          <table class="model-table">
            <thead><tr><th scope="col">模型 / MODEL</th><th scope="col">计费分组</th><th scope="col">输入 <span>/ 1M tokens</span></th><th scope="col">输出 <span>/ 1M tokens</span></th><th scope="col"><span class="sr-only">查看模型</span></th></tr></thead>
            <tbody>
              <tr v-for="row in visibleRows" :key="row.key" data-test="home-price-row">
                <td>
                  <span class="model-emblem" :class="vendorClass(row.model.platform)" aria-hidden="true">{{ vendorSymbol(row.model.platform) }}</span><span class="model-name"><strong>{{ row.model.name }}</strong><span>{{ vendorLabel(row.model.platform) }}</span><small class="mobile-model-group">{{ row.group.name }}<span>分组倍率 {{ effectiveRate(row.group) }}×</span><span v-if="hasSpecialPricing(row)"><RouterLink to="/model-plaza" :title="specialPricingHint(row)">{{ t('common.more') }} ↗</RouterLink></span></small></span>
                </td>
                <td><span class="group-name">{{ row.group.name }}</span><small class="model-multiplier">分组倍率 {{ effectiveRate(row.group) }}×</small><small v-if="hasSpecialPricing(row)" class="model-pricing-note"><RouterLink to="/model-plaza" :title="specialPricingHint(row)"><template v-if="row.group.long_context_pricing_enabled && row.model.pricing?.intervals?.length">阶梯定价 · </template><template v-if="row.model.time_pricing?.periods?.length">分时倍率 · </template><template v-if="row.group.peak_rate_enabled">高峰时段 · </template>{{ t('common.more') }} ↗</RouterLink></small></td>
                <td class="price">{{ paidPrice(row.model.pricing?.input_price, row.group) }}</td>
                <td class="price">{{ paidPrice(row.model.pricing?.output_price, row.group) }}</td>
                <td><RouterLink to="/model-plaza" class="model-arrow" :aria-label="'在模型广场查看 ' + row.model.name + ' ' + row.group.name"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></RouterLink></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="filteredRows.length === 0" class="pricing-state" data-test="home-pricing-empty">{{ searchActive ? t('modelPlaza.noSearchResult') : t('modelPlaza.empty') }}</div>
        <div class="model-bottom">
          <p>文本参考价为美元 / 百万 tokens，已包含分组倍率。 图片、视频、Fast、长上下文及个人优惠以<RouterLink :to="authStore.isAuthenticated ? (authStore.isAdmin ? '/admin/dashboard' : '/dashboard') : '/login'">控制台</RouterLink>计费为准； 不适用或未确认的价格显示为“—”。</p>
          <button v-if="filteredRows.length > 6" type="button" class="text-link" data-test="home-pricing-expand" :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? t('common.collapse') : '查看全部 ' + filteredRows.length + ' 个配置' }}<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down" :style="expanded ? { transform: 'rotate(180deg)' } : undefined"><path d="m6 9 6 6 6-6"></path></svg></button>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore, useAuthStore } from '@/stores'
import { getModelPlaza, type ModelPlazaGroup, type ModelPlazaResponse, type PlazaModel } from '@/api/modelPlaza'
import { formatScaled } from '@/utils/pricing'
import { platformLabel } from '@/utils/platformColors'
import { BILLING_MODE_TOKEN } from '@/constants/channel'

interface PriceRow { key: string; group: ModelPlazaGroup; model: PlazaModel }
type PriceStatus = 'loading' | 'ready' | 'login' | 'disabled' | 'forbidden' | 'error'

const emit = defineEmits<{ 'model-count': [count: number | null] }>()
const { tm, rt } = useI18n({ useScope: 'global' })
const appStore = useAppStore()
const authStore = useAuthStore()
const response = ref<ModelPlazaResponse | null>(null)
const status = ref<PriceStatus>('loading')
const platform = ref('all')
const groupId = ref('all')
const search = ref('')
const expanded = ref(false)
let requestId = 0
let controller: AbortController | undefined

const allRows = computed<PriceRow[]>(() => (response.value?.groups ?? []).flatMap(group => group.models
  .filter(model => (model.pricing?.billing_mode || BILLING_MODE_TOKEN) === BILLING_MODE_TOKEN)
  .map(model => ({ key: `${group.id}:${model.platform}:${model.name}`, group, model }))))
const platforms = computed(() => {
  const order = ['anthropic', 'openai', 'gemini', 'grok']
  return [...new Set(allRows.value.map(row => row.model.platform).filter(Boolean))]
    .sort((a, b) => (order.indexOf(a) < 0 ? order.length : order.indexOf(a)) - (order.indexOf(b) < 0 ? order.length : order.indexOf(b)))
})
const availableGroups = computed(() => (response.value?.groups ?? []).filter(group => allRows.value.some(row => row.group.id === group.id)))
const searchActive = computed(() => search.value.trim() !== '' || platform.value !== 'all' || groupId.value !== 'all')
const filteredRows = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return allRows.value.filter(row => (platform.value === 'all' || row.model.platform === platform.value)
    && (groupId.value === 'all' || String(row.group.id) === groupId.value)
    && (!query || row.model.name.toLocaleLowerCase().includes(query)))
})
const visibleRows = computed(() => expanded.value ? filteredRows.value : filteredRows.value.slice(0, 6))

function t(key: string, values?: Record<string, string | number>): string {
  // Read existing plain-text messages without requiring a runtime compiler.
  const message = tm(key) as string | ReturnType<typeof tm>
  if (typeof message === 'string') {
    return message.replace(/\{(\w+)\}/g, (placeholder: string, name: string) => String(values?.[name] ?? placeholder))
  }
  const compiledMessage = message as Parameters<typeof rt>[0]
  return values ? rt(compiledMessage, values) : rt(compiledMessage)
}

function vendorLabel(value: string): string {
  return ({ openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google', grok: 'xAI' } as Record<string, string>)[value] || platformLabel(value)
}
function vendorSymbol(value: string): string {
  return ({ openai: 'O', anthropic: 'A', gemini: 'G', grok: 'X' } as Record<string, string>)[value] || vendorLabel(value).slice(0, 1)
}
function vendorClass(value: string): string {
  return ({ gemini: 'google', grok: 'xai' } as Record<string, string>)[value] || value
}
function effectiveRate(group: ModelPlazaGroup): number { return group.user_rate_multiplier ?? group.rate_multiplier }
function paidPrice(value: number | null | undefined, group: ModelPlazaGroup): string {
  return value == null ? '—' : formatScaled(value * effectiveRate(group), 1_000_000)
}
function hasSpecialPricing(row: PriceRow): boolean {
  return !!row.model.time_pricing?.periods?.length || row.group.peak_rate_enabled
    || (row.group.long_context_pricing_enabled && !!row.model.pricing?.intervals?.length)
    || Object.values(row.model.pricing?.reasoning_effort_multipliers ?? {}).some(value => value !== 1)
}
function specialPricingHint(row: PriceRow): string {
  const hints: string[] = []
  if (row.group.long_context_pricing_enabled && row.model.pricing?.intervals?.length) {
    hints.push(t(row.model.long_context_basis === 'marginal' ? 'modelPlaza.table.tierHintMarginal' : 'modelPlaza.table.tierHint'))
  }
  if (row.model.time_pricing?.periods?.length) hints.push(t('modelPlaza.table.timePricingRowHint', { timezone: row.model.time_pricing.timezone }))
  if (row.group.peak_rate_enabled) hints.push(t('modelPlaza.detail.peakNote', { window: `${row.group.peak_start}–${row.group.peak_end}`, multiplier: row.group.peak_rate_multiplier }))
  return hints.join(' · ')
}

async function loadPrices() {
  const activeRequest = ++requestId
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  response.value = null
  expanded.value = false
  status.value = 'loading'
  emit('model-count', null)
  if (!appStore.publicSettingsLoaded) {
    try { await appStore.fetchPublicSettings() } catch { /* The API remains the source of truth. */ }
    if (activeRequest !== requestId) return
  }
  const settings = appStore.cachedPublicSettings
  if (appStore.publicSettingsLoaded && settings?.model_plaza_enabled === false) { status.value = 'disabled'; return }
  if (settings?.backend_mode_enabled && !authStore.isAdmin) { status.value = authStore.isAuthenticated ? 'forbidden' : 'login'; return }
  if (settings?.model_plaza_require_auth && !authStore.isAuthenticated) { status.value = 'login'; return }
  try {
    const data = await getModelPlaza({ signal, skipAuthRedirect: true })
    if (activeRequest !== requestId) return
    response.value = data
    status.value = 'ready'
    emit('model-count', new Set(data.groups.flatMap(group => group.models.map(model => `${model.platform}:${model.name}`))).size)
  } catch (error) {
    if (signal.aborted || activeRequest !== requestId) return
    const code = (error as { status?: number }).status
    status.value = code === 401 ? 'login' : code === 403 ? 'forbidden' : code === 404 ? 'disabled' : 'error'
  }
}

watch([platform, groupId, search], () => { expanded.value = false })
watch(() => [appStore.publicSettingsLoaded, appStore.cachedPublicSettings?.model_plaza_enabled,
  appStore.cachedPublicSettings?.model_plaza_require_auth, appStore.cachedPublicSettings?.backend_mode_enabled,
  authStore.isAuthenticated, authStore.isAdmin, authStore.user?.id], () => { void loadPrices() }, { immediate: true })
onBeforeUnmount(() => { requestId++; controller?.abort() })
</script>

<style scoped>
.model-table-wrap{position:relative}
.pricing-state{min-height:220px;display:flex;flex-direction:column;gap:20px;align-items:center;justify-content:center;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font-size:14px}
.pricing-state p{margin:0}
.pricing-spinner{width:22px;height:22px;border:2px solid var(--line);border-top-color:#276769;border-radius:50%;animation:pricing-spin .8s linear infinite}
@keyframes pricing-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.pricing-spinner{animation:none}}
</style>
