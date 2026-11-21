import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { reactive } from 'vue'
import type { ModelPlazaGroup, ModelPlazaResponse, PlazaModel } from '@/api/modelPlaza'
import HomeModelPricing from '../HomeModelPricing.vue'

const state = vi.hoisted(() => ({
  app: {} as { publicSettingsLoaded: boolean; cachedPublicSettings: Record<string, boolean>; fetchPublicSettings: ReturnType<typeof vi.fn> },
  auth: {} as { isAuthenticated: boolean; isAdmin: boolean; user: { id: number } | null },
  getModelPlaza: vi.fn(),
}))
vi.mock('@/stores', () => ({ useAppStore: () => state.app, useAuthStore: () => state.auth }))
vi.mock('@/api/modelPlaza', () => ({ getModelPlaza: state.getModelPlaza }))
vi.mock('vue-i18n', async importOriginal => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({ tm: (key: string) => key, rt: (message: string) => message }),
}))

function model(name: string, overrides: Partial<PlazaModel> = {}): PlazaModel {
  return { name, platform: 'openai', official_pricing: null, pricing: { billing_mode: 'token', input_price: 0.000003, output_price: 0.000015, cache_write_price: null, cache_read_price: null, image_input_price: null, image_output_price: null, per_request_price: null, intervals: [] }, ...overrides }
}
function group(id: number, models: PlazaModel[], overrides: Partial<ModelPlazaGroup> = {}): ModelPlazaGroup {
  return { id, name: `Group ${id}`, description: '', platform: 'openai', subscription_type: 'standard', rate_multiplier: 0.1, peak_rate_enabled: false, peak_start: '', peak_end: '', peak_rate_multiplier: 1, is_exclusive: false, image_rate_independent: false, image_rate_multiplier: 1, video_rate_independent: false, video_rate_multiplier: 1, long_context_pricing_enabled: false, models, ...overrides }
}
const wrappers: ReturnType<typeof mount>[] = []
function mountPricing() {
  const wrapper = mount(HomeModelPricing, { global: { stubs: { RouterLink: RouterLinkStub } } })
  wrappers.push(wrapper)
  return wrapper
}
function respond(groups: ModelPlazaGroup[]) {
  state.getModelPlaza.mockResolvedValue({ description: '', groups } satisfies ModelPlazaResponse)
}

describe('Home model prices', () => {
  beforeEach(() => {
    state.app = reactive({ publicSettingsLoaded: true, cachedPublicSettings: { model_plaza_enabled: true, model_plaza_require_auth: false, backend_mode_enabled: false }, fetchPublicSettings: vi.fn() })
    state.auth = reactive({ isAuthenticated: false, isAdmin: false, user: null })
    state.getModelPlaza.mockReset()
    respond([])
  })
  afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()) })

  it('uses real paid token prices, personal rates and preserves zero and missing prices', async () => {
    const missing = model('missing')
    missing.pricing!.input_price = null
    const free = model('free')
    free.pricing!.output_price = 0
    respond([group(1, [model('paid'), missing, free]), group(2, [model('personal')], { rate_multiplier: 3, user_rate_multiplier: 0 })])
    const wrapper = mountPricing()
    await flushPromises()
    const rows = wrapper.findAll('[data-test="home-price-row"]')
    expect(rows[0].findAll('td')[2].text()).toBe('$0.3')
    expect(rows[0].findAll('td')[3].text()).toBe('$1.5')
    expect(rows[1].findAll('td')[2].text()).toBe('—')
    expect(rows[2].findAll('td')[3].text()).toBe('$0')
    expect(rows[3].findAll('td')[2].text()).toBe('$0')
    expect(state.getModelPlaza).toHaveBeenCalledWith({ signal: expect.any(AbortSignal), skipAuthRedirect: true })
  })

  it('filters non-token units without substituting official prices and preserves groups', async () => {
    const image = model('image'); image.pricing!.billing_mode = 'image'
    const video = model('video'); video.pricing!.billing_mode = 'video'
    const request = model('request'); request.pricing!.billing_mode = 'per_request'
    respond([group(1, [model('shared'), image, video, request]), group(2, [model('shared', { pricing: null, official_pricing: { input_price: 9, output_price: 10, cache_write_price: null, cache_read_price: null } })])])
    const wrapper = mountPricing()
    await flushPromises()
    const rows = wrapper.findAll('[data-test="home-price-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Group 1')
    expect(rows[1].text()).toContain('Group 2')
    expect(rows[1].findAll('td')[2].text()).toBe('—')
    expect(wrapper.emitted('model-count')?.at(-1)).toEqual([4])
  })

  it('shows six rows, expands and collapses when search changes', async () => {
    respond([group(1, Array.from({ length: 9 }, (_, index) => model(`model-${index}`)))])
    const wrapper = mountPricing()
    await flushPromises()
    expect(wrapper.findAll('[data-test="home-price-row"]')).toHaveLength(6)
    await wrapper.get('[data-test="home-pricing-expand"]').trigger('click')
    expect(wrapper.findAll('[data-test="home-price-row"]')).toHaveLength(9)
    await wrapper.get('[data-test="home-pricing-search"]').setValue('MODEL-7')
    expect(wrapper.findAll('[data-test="home-price-row"]')).toHaveLength(1)
    await wrapper.get('[data-test="home-pricing-search"]').setValue('')
    expect(wrapper.findAll('[data-test="home-price-row"]')).toHaveLength(6)
  })

  it('discloses tier and time pricing without applying optional period multipliers to the standard price', async () => {
    const priced = model('tiered', { time_pricing: { timezone: 'Asia/Shanghai', periods: [{ start_time: '18:00', end_time: '22:00', multiplier: 2 }] } })
    priced.pricing!.intervals = [{ min_tokens: 200000, max_tokens: null, input_price: 0.000006, output_price: 0.00003, cache_write_price: null, cache_read_price: null, per_request_price: null }]
    respond([group(1, [priced], { long_context_pricing_enabled: true, peak_rate_enabled: true, peak_start: '18:00', peak_end: '22:00', peak_rate_multiplier: 1.5 })])
    const wrapper = mountPricing()
    await flushPromises()
    const row = wrapper.get('[data-test="home-price-row"]')
    expect(row.findAll('td')[2].text()).toBe('$0.3')
    const details = row.findComponent(RouterLinkStub)
    expect(details.attributes('title')).toContain('modelPlaza.table.tierHint')
    expect(details.attributes('title')).toContain('modelPlaza.table.timePricingRowHint')
    expect(details.attributes('title')).toContain('modelPlaza.detail.peakNote')
    expect(details.props('to')).toBe('/model-plaza')
  })

  it('combines group and model-platform filters for composite groups', async () => {
    respond([group(1, [model('openai-1'), model('claude-1', { platform: 'anthropic' })], { platform: 'composite' }), group(2, [model('claude-2', { platform: 'anthropic' })])])
    const wrapper = mountPricing()
    await flushPromises()
    await wrapper.findAll('.provider-tabs button').find(button => button.text() === 'Anthropic')!.trigger('click')
    expect(wrapper.findAll('[data-test="home-price-row"]')).toHaveLength(2)
    await wrapper.get('[data-test="home-pricing-group"]').setValue('1')
    expect(wrapper.findAll('[data-test="home-price-row"]')).toHaveLength(1)
    expect(wrapper.get('[data-test="home-price-row"]').text()).toContain('claude-1')
    await wrapper.get('[data-test="home-pricing-search"]').setValue('unavailable')
    expect(wrapper.get('[data-test="home-pricing-empty"]').text()).toBe('modelPlaza.noSearchResult')
  })

  it.each([
    [{ model_plaza_enabled: false }, false, false, 'home-pricing-unavailable'],
    [{ model_plaza_require_auth: true }, false, false, 'home-pricing-login'],
    [{ backend_mode_enabled: true }, false, false, 'home-pricing-login'],
    [{ backend_mode_enabled: true }, true, false, 'home-pricing-unavailable'],
  ])('respects public access flags without requesting protected prices', async (settings, authenticated, admin, selector) => {
    Object.assign(state.app.cachedPublicSettings, settings)
    state.auth.isAuthenticated = authenticated
    state.auth.isAdmin = admin
    const wrapper = mountPricing()
    await flushPromises()
    expect(wrapper.find(`[data-test="${selector}"]`).exists()).toBe(true)
    expect(state.getModelPlaza).not.toHaveBeenCalled()
  })

  it('loads administrator prices in backend mode and reloads on login', async () => {
    state.app.cachedPublicSettings.backend_mode_enabled = true
    const wrapper = mountPricing()
    await flushPromises()
    expect(state.getModelPlaza).not.toHaveBeenCalled()
    state.auth.isAuthenticated = true
    state.auth.isAdmin = true
    state.auth.user = { id: 1 }
    respond([group(1, [model('admin-model')])])
    await flushPromises()
    expect(wrapper.get('[data-test="home-price-row"]').text()).toContain('admin-model')
  })

  it.each([[401, 'home-pricing-login'], [403, 'home-pricing-unavailable'], [404, 'home-pricing-unavailable']])('handles stale public flags and HTTP %s locally', async (status, selector) => {
    state.getModelPlaza.mockRejectedValue({ status })
    const wrapper = mountPricing()
    await flushPromises()
    expect(wrapper.find(`[data-test="${selector}"]`).exists()).toBe(true)
  })

  it('shows connection errors and retries without inventing rows', async () => {
    state.getModelPlaza.mockRejectedValueOnce({ status: 0 })
    const wrapper = mountPricing()
    await flushPromises()
    expect(wrapper.findAll('[data-test="home-price-row"]')).toHaveLength(0)
    expect(wrapper.emitted('model-count')?.at(-1)).toEqual([null])
    respond([group(1, [model('retry-model')])])
    await wrapper.get('[data-test="home-pricing-error"] button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="home-price-row"]').text()).toContain('retry-model')
  })

  it('waits for public settings before requesting prices', async () => {
    state.app.publicSettingsLoaded = false
    state.app.fetchPublicSettings.mockImplementation(async () => {
      state.app.cachedPublicSettings.model_plaza_require_auth = true
      state.app.publicSettingsLoaded = true
    })
    const wrapper = mountPricing()
    await flushPromises()
    expect(wrapper.find('[data-test="home-pricing-login"]').exists()).toBe(true)
    expect(state.getModelPlaza).not.toHaveBeenCalled()
  })

  it('cancels and ignores stale responses after the access configuration changes', async () => {
    let finish!: (value: ModelPlazaResponse) => void
    state.getModelPlaza.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const wrapper = mountPricing()
    await flushPromises()
    const signal = state.getModelPlaza.mock.calls[0][0].signal as AbortSignal
    state.app.cachedPublicSettings.model_plaza_enabled = false
    await flushPromises()
    expect(signal.aborted).toBe(true)
    finish({ description: '', groups: [group(1, [model('stale')])] })
    await flushPromises()
    expect(wrapper.find('[data-test="home-pricing-unavailable"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="home-price-row"]')).toHaveLength(0)
  })
})
