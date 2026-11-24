import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import BotLotterySettings from '../BotLotterySettings.vue'
import zhBotLottery from '@/i18n/locales/zh/admin/botLottery'
import zhCommon from '@/i18n/locales/zh/common'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  showSuccess: vi.fn()
}))

vi.mock('@/api/admin', () => ({
  adminAPI: { botLottery: { getConfig: mocks.getConfig, updateConfig: mocks.updateConfig } }
}))
vi.mock('@/stores/app', () => ({ useAppStore: () => ({ showSuccess: mocks.showSuccess }) }))

const mountSettings = () => mount(BotLotterySettings, {
  global: {
    plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh: { admin: { botLottery: zhBotLottery.botLottery }, common: zhCommon.common } } })]
  }
})

describe('机器人抽奖奖池配置', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getConfig.mockResolvedValue({
      enabled: true,
      prizes: [
        { id: 'small', name: '小奖', amount: 0.25, weight: 3 },
        { id: 'large', name: '大奖', amount: 2, weight: 1 }
      ]
    })
    mocks.updateConfig.mockImplementation(async value => value)
  })

  it('显示按权重计算的概率，并提交奖池设置', async () => {
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.text()).toContain('75.00%')
    expect(wrapper.text()).toContain('25.00%')
    await wrapper.get('[data-test="save-lottery-settings"]').trigger('click')
    await flushPromises()

    expect(mocks.updateConfig).toHaveBeenCalledWith({
      enabled: true,
      prizes: [
        { id: 'small', name: '小奖', amount: 0.25, weight: 3 },
        { id: 'large', name: '大奖', amount: 2, weight: 1 }
      ]
    })
    expect(wrapper.get('[role="status"]').exists()).toBe(true)
  })

  it('禁止启用空奖池', async () => {
    mocks.getConfig.mockResolvedValueOnce({ enabled: false, prizes: [] })
    const wrapper = mountSettings()
    await flushPromises()
    await wrapper.get('[role="switch"]').trigger('click')

    expect(wrapper.get('[data-test="save-lottery-settings"]').attributes('disabled')).toBeDefined()
    expect(mocks.updateConfig).not.toHaveBeenCalled()
  })
})
