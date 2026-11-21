import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import zh from '@/i18n/locales/zh'
import en from '@/i18n/locales/en'
import HomeModelPricing from '../HomeModelPricing.vue'

const state = vi.hoisted(() => ({
  app: { publicSettingsLoaded: true, cachedPublicSettings: { model_plaza_enabled: true, model_plaza_require_auth: false }, fetchPublicSettings: vi.fn() },
  auth: { isAuthenticated: false, isAdmin: false, user: null },
  getModelPlaza: vi.fn(),
}))
vi.mock('@/stores', () => ({ useAppStore: () => state.app, useAuthStore: () => state.auth }))
vi.mock('@/api/modelPlaza', () => ({ getModelPlaza: state.getModelPlaza }))

const wrappers: ReturnType<typeof mount>[] = []
function mountPricing(locale: 'zh' | 'en' = 'zh') {
  const i18n = createI18n({ legacy: false, locale, messages: { zh, en } })
  const wrapper = mount(HomeModelPricing, { global: { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } } })
  wrappers.push(wrapper)
  return { wrapper, i18n }
}

describe('Home model price messages with the runtime-only i18n build', () => {
  beforeEach(() => {
    state.app.cachedPublicSettings.model_plaza_require_auth = false
    state.getModelPlaza.mockReset()
    state.getModelPlaza.mockResolvedValue({ description: '', groups: [] })
  })
  afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()) })

  it('renders existing locale messages instead of untranslated message keys and follows locale changes', async () => {
    const { wrapper, i18n } = mountPricing()
    await flushPromises()
    expect(wrapper.get('[data-test="home-pricing-empty"]').text()).toBe(zh.modelPlaza.empty)
    expect(wrapper.text()).not.toContain('modelPlaza.')
    i18n.global.locale.value = 'en'
    await flushPromises()
    expect(wrapper.get('[data-test="home-pricing-empty"]').text()).toBe(en.modelPlaza.empty)
  })

  it('renders the login state with the original Chinese text', async () => {
    state.app.cachedPublicSettings.model_plaza_require_auth = true
    const { wrapper } = mountPricing()
    await flushPromises()
    expect(wrapper.get('[data-test="home-pricing-login"]').text()).toContain(zh.modelPlaza.anonymousHint)
    expect(wrapper.get('[data-test="home-pricing-login"]').text()).toContain(zh.modelPlaza.nav.login)
    expect(wrapper.text()).not.toContain('modelPlaza.')
  })

  it('interpolates named values in existing special-price hints without a runtime compiler', async () => {
    state.getModelPlaza.mockResolvedValue({ description: '', groups: [{ id: 1, name: 'Time group', rate_multiplier: 1, peak_rate_enabled: true, peak_start: '18:00', peak_end: '22:00', peak_rate_multiplier: 2, models: [{ name: 'time-model', platform: 'openai', pricing: { billing_mode: 'token', input_price: 0.000001, output_price: 0.000002, intervals: [] }, time_pricing: { timezone: 'Asia/Shanghai', periods: [{ start_time: '18:00', end_time: '22:00', multiplier: 2 }] } }] }] })
    const { wrapper } = mountPricing()
    await flushPromises()
    const hint = wrapper.get('.model-pricing-note a').attributes('title')
    expect(hint).toContain('Asia/Shanghai')
    expect(hint).toContain('18:00–22:00')
    expect(hint).not.toMatch(/\{\w+\}|modelPlaza\./)
  })
})
