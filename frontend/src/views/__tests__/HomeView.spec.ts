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
      Icon: { template: '<span data-test="icon" />' },
      RouterLink: {
        props: ['to'],
        template: '<a :href="to"><slot /></a>',
      },
    },
  },
})

describe('HomeView apophis landing theme', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark')
    localStorage.clear()
    state.authStore.checkAuth.mockClear()
    state.appStore.fetchPublicSettings.mockClear()
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('renders the complete landing structure using the current site configuration', () => {
    const wrapper = mountHome()

    expect(wrapper.get('[data-test="home-nav"]').exists()).toBe(true)
    expect(wrapper.get('h1').text()).toBe('一站接入全球 AI 能力，像调用 OpenAI 一样调用所有模型')
    expect(wrapper.text()).toContain('AiGate to API Conversion Platform')
    expect(wrapper.get('[data-test="hero-stats"]').text()).toContain('99.9%')
    expect(wrapper.get('#models').text()).toContain('一个入口，覆盖主流大模型平台')
    expect(wrapper.get('#features').text()).toContain('从接入、调度到运营的一体化网关')
    expect(wrapper.get('#workflow').text()).toContain('三步完成从订阅到 API 服务化')
    expect(wrapper.get('[data-test="privacy-card"]').text()).toContain('您的请求，只用于提供服务')
    expect(wrapper.get('[data-test="home-cta"]').text()).toContain('准备把 AI 能力交付给团队了吗？')
    expect(wrapper.get('[data-test="endpoint-url"]').text()).toBe('https://api.kinght.top/v1')
  })

  it('exposes the fixed Canvas workbench entry without token-bearing URL parameters', () => {
    const wrapper = mountHome()
    const card = wrapper.get('[data-test="canvas-workbench-card"]')
    const link = card.get('[data-test="canvas-workbench-link"]')

    expect(card.text()).toContain('生图工作台')
    expect(link.text()).toContain('打开 Canvas')
    expect(link.attributes('href')).toBe('https://api.kinght.top/canvas?mode=new')
    expect(link.attributes('href')).not.toMatch(/token|api[_-]?key|secret/i)
  })

  it('switches between OpenAI and Claude endpoint modes', async () => {
    const wrapper = mountHome()

    await wrapper.get('[data-test="endpoint-tab-claude"]').trigger('click')
    expect(wrapper.get('[data-test="endpoint-url"]').text()).toBe('https://api.kinght.top')
    expect(wrapper.get('[data-test="endpoint-note"]').text()).toContain('无 /v1 后缀')
    expect(wrapper.get('[data-test="endpoint-examples"]').text()).toContain('POST /v1/messages')

    await wrapper.get('[data-test="endpoint-tab-openai"]').trigger('click')
    expect(wrapper.get('[data-test="endpoint-url"]').text()).toBe('https://api.kinght.top/v1')
    expect(wrapper.get('[data-test="endpoint-examples"]').text()).toContain('POST /chat/completions')
  })

  it('copies the active endpoint and persists theme changes', async () => {
    const wrapper = mountHome()

    await wrapper.get('[data-test="copy-endpoint"]').trigger('click')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://api.kinght.top/v1')

    await wrapper.get('[data-test="theme-toggle"]').trigger('click')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('theme')).toBe('dark')
  })
})