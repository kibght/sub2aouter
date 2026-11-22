import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BotLotteryGrantModal from '../BotLotteryGrantModal.vue'
import type { AdminUser } from '@/types'

const mocks = vi.hoisted(() => ({
  getUserHistory: vi.fn(),
  grant: vi.fn(),
  getGrantBatch: vi.fn(),
  showSuccess: vi.fn()
}))

vi.mock('@/api/admin', () => ({
  adminAPI: { botLottery: mocks }
}))
vi.mock('@/stores/app', () => ({ useAppStore: () => ({ showSuccess: mocks.showSuccess }) }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

const user = { id: 17, email: 'user@example.test', balance: 0 } as AdminUser
const mountModal = (target: AdminUser | null) => mount(BotLotteryGrantModal, {
  props: { show: true, user: target },
  global: { stubs: { teleport: true, transition: false } }
})

describe('机器人抽奖次数发放', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.getUserHistory.mockResolvedValue({ user_id: user.id, remaining: 2, records: [] })
    mocks.grant.mockResolvedValue({ status: 'success', user_id: user.id, count: 2, remaining: 4, replayed: false })
    mocks.getGrantBatch.mockResolvedValue({ status: 'completed', batch_id: 41, count: 2, total: 3, success: 2, skipped: 1, failed: 0, pending: 0, items: [] })
    vi.stubGlobal('confirm', vi.fn(() => true))
  })

  it('单个网站用户发放次数后刷新余额记录', async () => {
    mocks.getUserHistory
      .mockResolvedValueOnce({ user_id: user.id, remaining: 2, records: [] })
      .mockResolvedValueOnce({ user_id: user.id, remaining: 4, records: [] })
    const wrapper = mountModal(user)
    await flushPromises()
    await wrapper.get('[data-test="grant-count"]').setValue('2')
    await wrapper.get('[data-test="grant-notes"]').setValue('活动奖励')
    await wrapper.get('[data-test="submit-lottery-grant"]').trigger('click')
    await flushPromises()

    expect(mocks.grant).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 17,
      count: 2,
      notes: '活动奖励',
      request_id: expect.any(String)
    }))
    expect(mocks.getUserHistory).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('admin.botLottery.remaining: 4')
  })

  it('全体绑定用户批次需要确认并显示完成统计', async () => {
    mocks.grant.mockResolvedValueOnce({
      status: 'pending', batch_id: 41, count: 2, total: 3, success: 0, skipped: 0, failed: 0, pending: 3
    })
    const wrapper = mountModal(null)
    await flushPromises()
    await wrapper.get('[data-test="grant-count"]').setValue('2')
    await wrapper.get('[data-test="submit-lottery-grant"]').trigger('click')
    await flushPromises()

    expect(window.confirm).toHaveBeenCalledOnce()
    expect(mocks.grant).toHaveBeenCalledWith(expect.objectContaining({ target: 'all', count: 2 }))
    expect(mocks.getGrantBatch).toHaveBeenCalledWith(41)
    expect(wrapper.text()).toContain('admin.botLottery.batchCompleted')
    expect(wrapper.text()).toContain('admin.botLottery.batchTotal: 3')
  })

  it('恢复网络结果未知的请求时复用原幂等编号', async () => {
    mocks.grant.mockRejectedValueOnce(new Error('network down'))
    const wrapper = mountModal(user)
    await flushPromises()
    await wrapper.get('[data-test="submit-lottery-grant"]').trigger('click')
    await flushPromises()
    const firstRequestId = mocks.grant.mock.calls[0]![0].request_id
    await wrapper.get('[data-test="submit-lottery-grant"]').trigger('click')
    await flushPromises()

    expect(mocks.grant).toHaveBeenCalledTimes(2)
    expect(mocks.grant.mock.calls[1]![0].request_id).toBe(firstRequestId)
  })
})
