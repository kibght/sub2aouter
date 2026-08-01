import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VersionBadge from '../VersionBadge.vue'

const mocks = vi.hoisted(() => ({
  fetchVersion: vi.fn().mockResolvedValue(null),
  buildType: 'release',
  hasUpdate: false,
  performUpdate: vi.fn().mockResolvedValue({ need_restart: true }),
  getRollbackVersions: vi.fn().mockResolvedValue({ versions: [] }),
}))

vi.mock('@/stores', () => ({
  useAuthStore: () => ({ isAdmin: true }),
  useAppStore: () => ({
    versionLoading: false,
    currentVersion: '2026.7.1',
    latestVersion: '2026.7.1',
    get hasUpdate() { return mocks.hasUpdate },
    releaseInfo: { html_url: 'https://github.com/kibght/sub2aouter/releases/latest' },
    get buildType() { return mocks.buildType },
    fetchVersion: mocks.fetchVersion,
    clearVersionCache: vi.fn(),
  }),
}))

vi.mock('@/api/admin/system', () => ({
  performUpdate: mocks.performUpdate,
  restartService: vi.fn(),
  getRollbackVersions: mocks.getRollbackVersions,
  rollback: vi.fn(),
}))

vi.mock('@/composables/useClipboard', () => ({
  useClipboard: () => ({ copied: false, copyToClipboard: vi.fn() }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

describe('VersionBadge update reminders', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.fetchVersion.mockClear()
    mocks.buildType = 'release'
    mocks.hasUpdate = false
    mocks.performUpdate.mockClear()
    mocks.getRollbackVersions.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders Docker updates with the original direct update action', async () => {
    mocks.buildType = 'docker'
    mocks.hasUpdate = true

    const wrapper = mount(VersionBadge, {
      global: {
        stubs: {
          Icon: true,
        },
      },
    })
    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('version.updateNow')
    expect(wrapper.text()).not.toContain('docker compose pull sub2api')

    const updateButton = wrapper.findAll('button').find((button) => button.text().includes('version.updateNow'))
    expect(updateButton).toBeDefined()
    await updateButton!.trigger('click')
    await flushPromises()
    expect(mocks.performUpdate).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('keeps version rollback available for Docker deployments', async () => {
    mocks.buildType = 'docker'
    mocks.hasUpdate = false

    const wrapper = mount(VersionBadge, {
      global: {
        stubs: {
          Icon: true,
        },
      },
    })
    await wrapper.get('button').trigger('click')
    await flushPromises()

    const rollbackButton = wrapper.findAll('button').find((button) => button.text().includes('version.rollback'))
    expect(rollbackButton).toBeDefined()
    await rollbackButton!.trigger('click')
    await flushPromises()
    expect(mocks.getRollbackVersions).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('forces a repository refresh every 30 minutes and stops after unmount', async () => {
    const wrapper = mount(VersionBadge, {
      global: {
        stubs: {
          Icon: true,
        },
      },
    })
    await flushPromises()

    expect(mocks.fetchVersion).toHaveBeenCalledTimes(1)
    expect(mocks.fetchVersion).toHaveBeenLastCalledWith(false)

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(mocks.fetchVersion).toHaveBeenCalledTimes(2)
    expect(mocks.fetchVersion).toHaveBeenLastCalledWith(true)

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(mocks.fetchVersion).toHaveBeenCalledTimes(2)
  })
})