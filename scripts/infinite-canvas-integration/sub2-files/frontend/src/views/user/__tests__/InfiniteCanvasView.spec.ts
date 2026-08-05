import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import InfiniteCanvasView from '../InfiniteCanvasView.vue'
import { CANVAS_CONFIGURED_MESSAGE, CANVAS_INIT_MESSAGE, CANVAS_READY_MESSAGE } from '@/features/infiniteCanvas/bridge'

const { listKeys, showError } = vi.hoisted(() => ({
  listKeys: vi.fn(),
  showError: vi.fn(),
}))

vi.mock('@/api/keys', () => ({
  keysAPI: { list: listKeys },
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({ showError }),
}))

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>()
  return { ...actual, getLocale: () => 'zh' }
})

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  }
})

const activeKey = {
  id: 7,
  user_id: 1,
  key: 'sk-canvas-secret',
  name: 'Canvas key',
  group_id: null,
  status: 'active',
  ip_whitelist: [],
  ip_blacklist: [],
  last_used_at: null,
  last_used_ip: null,
  quota: 0,
  quota_used: 0,
  expires_at: null,
  created_at: '2026-08-03T00:00:00Z',
  updated_at: '2026-08-03T00:00:00Z',
  current_concurrency: 0,
  rate_limit_5h: 0,
  rate_limit_1d: 0,
  rate_limit_7d: 0,
  usage_5h: 0,
  usage_1d: 0,
  usage_7d: 0,
  window_5h_start: null,
  window_1d_start: null,
  window_7d_start: null,
  reset_5h_at: null,
  reset_1d_at: null,
  reset_7d_at: null,
}

describe('InfiniteCanvasView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    listKeys.mockResolvedValue({ items: [activeKey], total: 1, page: 1, page_size: 100, pages: 1 })
  })

  it('never places the API key in the iframe URL and sends it only after a trusted ready event', async () => {
    const wrapper = mount(InfiniteCanvasView, {
      global: {
        stubs: {
          AppLayout: { template: '<div><slot /></div>' },
          RouterLink: { template: '<a><slot /></a>' },
          Icon: true,
        },
      },
    })
    await flushPromises()

    const iframe = wrapper.get('iframe')
    expect(iframe.attributes('src')).toBe('/canvas-app/')
    expect(iframe.attributes('src')).not.toContain('sk-canvas-secret')

    const targetWindow = { postMessage: vi.fn() } as unknown as Window
    Object.defineProperty(iframe.element, 'contentWindow', { value: targetWindow })
    const postMessage = vi.mocked(targetWindow.postMessage)

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: targetWindow,
        data: { type: CANVAS_READY_MESSAGE, version: 1 },
      })
    )

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CANVAS_INIT_MESSAGE,
        payload: expect.objectContaining({ apiKey: 'sk-canvas-secret' }),
      }),
      window.location.origin
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: targetWindow,
        data: { type: CANVAS_CONFIGURED_MESSAGE, version: 1 },
      })
    )
    await nextTick()
    expect(wrapper.text()).toContain('infiniteCanvas.statusReady')

    await iframe.trigger('load')
    await nextTick()
    expect(wrapper.text()).toContain('infiniteCanvas.statusReady')
  })
})
