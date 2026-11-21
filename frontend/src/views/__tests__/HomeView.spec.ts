import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import HomeView from '../HomeView.vue'

const state = vi.hoisted(() => ({
  authStore: {
    isAuthenticated: false,
    isAdmin: false,
    user: null as null | { email: string },
    checkAuth: vi.fn(),
  },
  appStore: {
    cachedPublicSettings: {
      site_name: 'AiGate',
      site_logo: '/logo.svg',
      site_subtitle: 'AiGate to API Conversion Platform',
      api_base_url: 'https://api.kinght.top',
      contact_info: '售后客服群聊：702891993',
      home_content: '',
      home_hero_image: '',
      doc_url: '',
      custom_menu_items: [
        {
          label: 'QQ售后群',
          url: 'https://qm.qq.com/q/nhueQZ5BkI',
          visibility: 'user',
        },
      ],
    },
    siteName: 'AiGate',
    siteLogo: '/logo.svg',
    docUrl: '',
    publicSettingsLoaded: true,
    fetchPublicSettings: vi.fn(),
  },
}))

vi.mock('@/stores', () => ({
  useAuthStore: () => state.authStore,
  useAppStore: () => state.appStore,
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => ({
        'common.login': '登录',
        'common.dashboard': '控制台',
        'home.footer.allRightsReserved': '保留所有权利。',
      })[key] ?? key,
    }),
  }
})

const mountHome = () => mount(HomeView, {
  global: {
    stubs: {
      LocaleSwitcher: { template: '<button data-test="locale-switcher">ZH</button>' },
      HomeModelPricing: { template: '<section id="models" data-test="home-pricing" />' },
      HomeHeroScene: { props: ['imageUrl'], template: '<div data-test="hero-scene" :data-image="imageUrl" />' },
      Icon: { template: '<span data-test="icon" />' },
      RouterLink: {
        props: ['to'],
        template: '<a :href="to"><slot /></a>',
      },
    },
  },
})

describe('HomeView configurable landing', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark')
    localStorage.clear()
    state.authStore.isAuthenticated = false
    state.authStore.isAdmin = false
    state.appStore.cachedPublicSettings.home_hero_image = ''
    state.appStore.cachedPublicSettings.api_base_url = 'https://api.kinght.top'
    state.authStore.checkAuth.mockClear()
    state.appStore.fetchPublicSettings.mockClear()
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('uses site branding throughout the complete landing and only shows the configured QQ group', () => {
    const wrapper = mountHome()
    expect(wrapper.get('h1').text()).toBe('AiGate')
    expect(wrapper.get('.hero-subtitle').text()).toBe('AiGate to API Conversion Platform')
    expect(wrapper.get('.hero-content > p:not(.hero-subtitle)').text()).toContain('一个 API 入口，连接全球大模型。安全的连接，透明的用量。你的数据，始终属于你。')
    for (const id of ['models', 'features', 'security', 'performance', 'developers', 'faq', 'contact']) {
      expect(wrapper.find(`#${id}`).exists()).toBe(true)
    }
    expect(wrapper.findAll('details')).toHaveLength(4)
    expect(wrapper.get('footer').text()).toContain('702891993')
    expect(wrapper.get('footer').text()).toContain('AiGate')
    expect(wrapper.get('footer').text()).not.toContain('Telegram')
    expect(wrapper.get('[data-test="hero-stats"]').text()).toContain('—')
    expect(wrapper.get('[data-test="hero-stats"]').text()).not.toContain('99.9%')
    expect(wrapper.find('[data-test="canvas-workbench-card"]').exists()).toBe(false)
  })

  it('uses the original Responses integration and switches example languages', async () => {
    const wrapper = mountHome()
    expect(wrapper.get('[data-test="endpoint-url"]').text()).toBe('https://api.kinght.top')
    expect(wrapper.get('#home-code-example').text()).toContain('client.responses.create')
    await wrapper.get('#code-tab-cURL').trigger('click')
    expect(wrapper.get('#home-code-example').text()).toContain('https://api.kinght.top/responses')
    await wrapper.get('[id="code-tab-Node.js"]').trigger('click')
    expect(wrapper.get('#home-code-example').text()).toContain('await client.responses.create')
    await wrapper.get('#code-tab-Python').trigger('click')
    expect(wrapper.get('#home-code-example').text()).toContain('response.output_text')
  })

  it('normalizes a configured v1 suffix and copies exact endpoint and QQ values', async () => {
    state.appStore.cachedPublicSettings.api_base_url = 'https://api.kinght.top/v1/'
    const wrapper = mountHome()
    await wrapper.get('[data-test="copy-endpoint"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://api.kinght.top')
    await wrapper.get('[data-test="copy-qq"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('702891993')
  })

  it('passes only sanitized image URLs to the hero', () => {
    state.appStore.cachedPublicSettings.home_hero_image = 'javascript:alert(1)'
    expect(mountHome().get('[data-test="hero-scene"]').attributes('data-image')).toBe('')
    state.appStore.cachedPublicSettings.home_hero_image = '/images/hero.webp'
    expect(mountHome().get('[data-test="hero-scene"]').attributes('data-image')).toBe('/images/hero.webp')
  })

  it('keeps failed copy actions usable and reports the failure', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'))
    const wrapper = mountHome()
    await wrapper.get('[data-test="copy-qq"]').trigger('click')
    expect(wrapper.get('.contact-copy-feedback').text()).not.toBe('')
    expect(wrapper.get('[data-test="copy-qq"]').attributes('aria-label')).toBe('复制 QQ 群号')
  })

  it('routes an authenticated administrator to the correct console and opens the mobile menu', async () => {
    state.authStore.isAuthenticated = true
    state.authStore.isAdmin = true
    const wrapper = mountHome()
    expect(wrapper.get('.nav-actions .button-lime').attributes('href')).toBe('/admin/dashboard')
    await wrapper.get('[aria-controls="home-mobile-menu"]').trigger('click')
    expect(wrapper.get('#home-mobile-menu').classes()).toContain('is-open')
    await wrapper.get('#home-mobile-menu a').trigger('click')
    expect(wrapper.get('#home-mobile-menu').classes()).not.toContain('is-open')
  })
})
