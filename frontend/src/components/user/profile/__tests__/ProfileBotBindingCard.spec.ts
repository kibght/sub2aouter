import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ProfileBotBindingCard from '@/components/user/profile/ProfileBotBindingCard.vue'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  createCode: vi.fn(),
  revoke: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn()
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({
    showSuccess: mocks.showSuccess,
    showError: mocks.showError
  })
}))

vi.mock('@/api', () => ({
  botBindingsAPI: {
    createCode: mocks.createCode,
    list: mocks.list,
    revoke: mocks.revoke
  }
}))

const sampleBinding = {
  id: 1,
  platform: 'qq',
  external_id: 'qq-10001',
  token_prefix: 's2a_abcd',
  bound_at: '2026-01-02T03:04:05Z',
  last_used_at: null,
  created_at: '2026-01-02T03:04:05Z'
}

describe('ProfileBotBindingCard', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    mocks.list.mockReset()
    mocks.createCode.mockReset()
    mocks.revoke.mockReset()
    mocks.showSuccess.mockReset()
    mocks.showError.mockReset()
    mocks.list.mockResolvedValue({ items: [] })
  })

  afterEach(() => {
    // 卸载组件以清理倒计时定时器，避免跨用例泄漏
    wrapper?.unmount()
    wrapper = null
    vi.clearAllMocks()
  })

  it('初始加载后渲染已绑定的机器人列表', async () => {
    mocks.list.mockResolvedValue({ items: [sampleBinding] })

    wrapper = mount(ProfileBotBindingCard)
    await flushPromises()

    const rows = wrapper.findAll('[data-testid="bot-binding-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('qq')
    expect(rows[0].text()).toContain('qq-10001')
    expect(rows[0].text()).toContain('s2a_abcd')
    // last_used_at 为 null 时展示占位文案
    expect(rows[0].text()).toContain('profile.botBinding.neverUsed')
    expect(mocks.list).toHaveBeenCalledTimes(1)
    expect(mocks.showError).not.toHaveBeenCalled()
  })

  it('没有绑定记录时渲染空状态与绑定步骤', async () => {
    wrapper = mount(ProfileBotBindingCard)
    await flushPromises()

    expect(wrapper.findAll('[data-testid="bot-binding-row"]')).toHaveLength(0)
    const text = wrapper.text()
    expect(text).toContain('profile.botBinding.empty')
    expect(text).toContain('profile.botBinding.guideTitle')
    expect(text).toContain('profile.botBinding.step1')
    expect(text).toContain('profile.botBinding.step2')
    expect(text).toContain('profile.botBinding.step3')
  })

  it('生成绑定码后弹窗展示 code', async () => {
    mocks.createCode.mockResolvedValue({
      code: 'BIND-2024',
      expires_at: '2026-01-02T03:14:05Z',
      expires_in_seconds: 600
    })

    wrapper = mount(ProfileBotBindingCard)
    await flushPromises()

    const generateButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('profile.botBinding.generate'))
    expect(generateButton).toBeTruthy()

    await generateButton!.trigger('click')
    await flushPromises()

    expect(mocks.createCode).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="bot-binding-code"]').text()).toBe('BIND-2024')
    expect(wrapper.get('[data-testid="bot-binding-command"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('profile.botBinding.validHint')
    expect(mocks.showSuccess).toHaveBeenCalledWith('profile.botBinding.codeCreated')
  })

  it('解绑时调用 revoke 接口并从列表移除', async () => {
    mocks.list.mockResolvedValue({ items: [sampleBinding] })
    mocks.revoke.mockResolvedValue({ revoked: true })

    wrapper = mount(ProfileBotBindingCard)
    await flushPromises()

    const unbindButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('profile.botBinding.unbind'))
    expect(unbindButton).toBeTruthy()

    await unbindButton!.trigger('click')
    expect(wrapper.find('.btn-danger').exists()).toBe(true)

    await wrapper.get('.btn-danger').trigger('click')
    await flushPromises()

    expect(mocks.revoke).toHaveBeenCalledWith(1)
    expect(wrapper.findAll('[data-testid="bot-binding-row"]')).toHaveLength(0)
    expect(mocks.showSuccess).toHaveBeenCalledWith('profile.botBinding.unbindSuccess')
    expect(mocks.showError).not.toHaveBeenCalled()
  })
})
