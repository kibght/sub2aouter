import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import AnnouncementBell from '../AnnouncementBell.vue'
import { useAnnouncementStore } from '@/stores/announcements'

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => key,
    }),
  }
})

const announcements = [
  {
    id: 1,
    title: 'First announcement',
    content: 'First content',
    notify_mode: 'normal' as const,
    read_at: '2026-08-01T00:00:00Z',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  },
  {
    id: 2,
    title: 'Unread announcement',
    content: '## Detail heading\n\nDetail content',
    notify_mode: 'normal' as const,
    created_at: '2026-08-02T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
  },
]

describe('AnnouncementBell', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ''
    document.body.style.overflow = ''
  })

  it('keeps the announcement list and detail inside one master-detail dialog', async () => {
    const store = useAnnouncementStore()
    store.announcements = structuredClone(announcements)
    vi.spyOn(store, 'markAsRead').mockResolvedValue()

    const wrapper = mount(AnnouncementBell)
    await wrapper.get('button').trigger('click')

    const dialog = document.body.querySelector('[data-testid="announcement-master-detail"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.querySelector('[data-testid="announcement-list"]')).not.toBeNull()
    expect(dialog?.querySelector('[data-testid="announcement-detail"]')).not.toBeNull()
    expect(document.body.querySelectorAll('[data-testid="announcement-master-detail"]')).toHaveLength(1)

    const unreadItem = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="announcement-item-2"]',
    )
    unreadItem?.click()
    await wrapper.vm.$nextTick()

    const detail = dialog?.querySelector('[data-testid="announcement-detail"]')
    expect(detail?.textContent).toContain('Unread announcement')
    expect(detail?.textContent).toContain('Detail heading')
    expect(store.markAsRead).toHaveBeenCalledWith(2)
    expect(document.body.querySelectorAll('[data-testid="announcement-master-detail"]')).toHaveLength(1)

    wrapper.unmount()
  })

  it('uses the Apophis announcement shell instead of the legacy gradient modal', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/apophis/ApophisAnnouncementBell.vue'), 'utf8')

    expect(source).toContain('announcement-master-detail')
    expect(source).toContain('--announcement-accent: #ff3d71')
    expect(source).not.toContain('from-blue-500')
    expect(source).not.toContain('from-indigo-600')
    expect(source).not.toContain('rounded-3xl')
  })

  it('ships both announcement components through the permanent theme overlay', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), '../theme/apophis/manifest.json'), 'utf8'),
    ) as {
      additions: Array<{ target: string }>
      patches: Array<{ target: string; operation?: string }>
    }
    const additions = manifest.additions.map((entry) => entry.target)
    const mounts = manifest.patches
      .filter((entry) => entry.operation === 'mount-component')
      .map((entry) => entry.target)

    expect(additions).toContain('frontend/src/components/apophis/ApophisAnnouncementBell.vue')
    expect(additions).toContain('frontend/src/components/apophis/ApophisAnnouncementPopup.vue')
    expect(additions).toContain('frontend/src/components/common/__tests__/AnnouncementBell.apophis.spec.ts')
    expect(additions).toContain('frontend/src/components/common/__tests__/AnnouncementPopup.apophis.spec.ts')
    expect(mounts).toContain('frontend/src/components/common/AnnouncementBell.vue')
    expect(mounts).toContain('frontend/src/components/common/AnnouncementPopup.vue')
  })
})
