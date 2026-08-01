import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VersionBadge from '../VersionBadge.vue'

const mocks = vi.hoisted(() => ({
  fetchVersion: vi.fn().mockResolvedValue(null),
  buildType: 'release',
  hasUpdate: false,
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
  performUpdate: vi.fn(),
  restartService: vi.fn(),
  getRollbackVersions: vi.fn().mockResolvedValue({ versions: [] }),
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
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders Docker updates as Compose commands without a binary update button', async () => {
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

    expect(wrapper.text()).toContain('docker compose pull sub2api')
    expect(wrapper.text()).toContain('docker compose up -d --no-deps sub2api')
    expect(wrapper.text()).not.toContain('version.updateNow')
    wrapper.unmount()
  })

  it('keeps direct update action for binary release builds', async () => {
    mocks.buildType = 'release'
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