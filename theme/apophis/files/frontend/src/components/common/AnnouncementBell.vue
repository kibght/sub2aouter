<template>
  <div>
    <button
      class="announcement-trigger"
      :class="{ 'announcement-trigger-unread': unreadCount > 0 }"
      :aria-label="t('announcements.title')"
      @click="openModal"
    >
      <Icon name="bell" size="md" />
      <span v-if="unreadCount > 0" class="announcement-trigger-dot" aria-hidden="true"></span>
    </button>

    <Teleport to="body">
      <Transition name="announcement-fade">
        <div v-if="isModalOpen" class="announcement-overlay" @click.self="closeModal">
          <section
            class="announcement-master-detail"
            data-testid="announcement-master-detail"
            role="dialog"
            aria-modal="true"
            :aria-label="t('announcements.title')"
          >
            <header class="announcement-header">
              <h2>{{ t('announcements.title') }}</h2>
              <span class="announcement-count">{{ announcements.length }}</span>
              <div class="announcement-header-actions">
                <button
                  v-if="unreadCount > 0"
                  class="announcement-secondary-button"
                  :disabled="loading"
                  @click="markAllAsRead"
                >
                  {{ t('announcements.markAllRead') }}
                </button>
                <button
                  class="announcement-icon-button"
                  :aria-label="t('common.close')"
                  @click="closeModal"
                >
                  <Icon name="x" size="sm" />
                </button>
              </div>
            </header>

            <div
              class="announcement-layout"
              :class="{ 'announcement-layout-selected': selectedAnnouncement }"
            >
              <aside class="announcement-list-panel" data-testid="announcement-list">
                <div class="announcement-list-heading">
                  <span>{{ t('announcements.title') }}</span>
                  <span>{{ t('announcements.read') }}</span>
                </div>

                <div v-if="loading" class="announcement-loading" role="status">
                  <span class="announcement-spinner"></span>
                </div>

                <div v-else-if="announcements.length > 0" class="announcement-list-scroll">
                  <button
                    v-for="item in announcements"
                    :key="item.id"
                    class="announcement-list-item"
                    :class="{
                      'announcement-list-item-selected': selectedAnnouncement?.id === item.id,
                    }"
                    :data-testid="`announcement-item-${item.id}`"
                    @click="openDetail(item)"
                  >
                    <span class="announcement-status-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
                        <circle cx="12" cy="12" r="8" />
                        <path d="m8.8 12 2 2 4.5-5" />
                      </svg>
                    </span>
                    <span class="announcement-list-copy">
                      <strong>{{ item.title }}</strong>
                      <time>{{ formatRelativeTime(item.created_at) }}</time>
                    </span>
                    <span v-if="!item.read_at" class="announcement-unread-dot" aria-hidden="true"></span>
                    <svg
                      class="announcement-chevron"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      aria-hidden="true"
                    >
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </button>
                </div>

                <div v-else class="announcement-empty-list">
                  <Icon name="bell" size="lg" />
                  <strong>{{ t('announcements.empty') }}</strong>
                  <span>{{ t('announcements.emptyDescription') }}</span>
                </div>
              </aside>

              <main class="announcement-detail-panel" data-testid="announcement-detail">
                <template v-if="selectedAnnouncement">
                  <div class="announcement-detail-content">
                    <button
                      class="announcement-back-button"
                      type="button"
                      @click="selectedAnnouncement = null"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                        <path d="m15 18-6-6 6-6" />
                      </svg>
                      {{ t('announcements.title') }}
                    </button>

                    <div class="announcement-detail-label">
                      <span></span>
                      {{ t('announcements.title') }}
                    </div>
                    <h3>{{ selectedAnnouncement.title }}</h3>
                    <div class="announcement-meta">
                      <span>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                          <circle cx="12" cy="12" r="9" />
                          <path d="M12 7v5l3 2" />
                        </svg>
                        <time>{{ formatRelativeWithDateTime(selectedAnnouncement.created_at) }}</time>
                      </span>
                      <span>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                          <circle cx="12" cy="12" r="2.5" />
                        </svg>
                        {{ selectedAnnouncement.read_at ? t('announcements.read') : t('announcements.unread') }}
                      </span>
                    </div>
                    <div class="announcement-copy-card">
                      <div
                        class="markdown-body prose prose-sm max-w-none dark:prose-invert"
                        v-html="renderMarkdown(selectedAnnouncement.content)"
                      ></div>
                    </div>
                  </div>

                  <footer class="announcement-detail-footer">
                    <div class="announcement-read-state">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                        <circle cx="12" cy="12" r="9" />
                        <path d="m8 12 2.5 2.5L16 9" />
                      </svg>
                      <span>
                        {{ selectedAnnouncement.read_at ? t('announcements.readStatus') : t('announcements.markReadHint') }}
                      </span>
                    </div>
                    <button class="announcement-secondary-button" @click="closeModal">
                      {{ t('common.close') }}
                    </button>
                    <button
                      v-if="!selectedAnnouncement.read_at"
                      class="announcement-primary-button"
                      @click="markSelectedAsRead"
                    >
                      {{ t('announcements.markRead') }}
                    </button>
                  </footer>
                </template>

                <div v-else class="announcement-empty-detail">
                  <span class="announcement-empty-icon">
                    <Icon name="bell" size="lg" />
                  </span>
                  <strong>{{ t('announcements.empty') }}</strong>
                  <span>{{ t('announcements.description') }}</span>
                </div>
              </main>
            </div>
          </section>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useAppStore } from '@/stores/app'
import { useAnnouncementStore } from '@/stores/announcements'
import { formatRelativeTime, formatRelativeWithDateTime } from '@/utils/format'
import type { UserAnnouncement } from '@/types'
import Icon from '@/components/icons/Icon.vue'
import '@/styles/announcement-markdown.css'

const { t } = useI18n()
const appStore = useAppStore()
const announcementStore = useAnnouncementStore()

marked.setOptions({
  breaks: true,
  gfm: true,
})

const { announcements, loading } = storeToRefs(announcementStore)
const unreadCount = computed(() => announcementStore.unreadCount)
const isModalOpen = ref(false)
const selectedAnnouncement = ref<UserAnnouncement | null>(null)

function renderMarkdown(content: string): string {
  if (!content) return ''
  const html = marked.parse(content) as string
  return DOMPurify.sanitize(html)
}

function openModal() {
  selectedAnnouncement.value = null
  isModalOpen.value = true
}

function closeModal() {
  isModalOpen.value = false
  selectedAnnouncement.value = null
}

async function openDetail(announcement: UserAnnouncement) {
  selectedAnnouncement.value = announcement
  if (!announcement.read_at) {
    await markAsRead(announcement.id)
  }
}

async function markAsRead(id: number) {
  try {
    await announcementStore.markAsRead(id)
  } catch (err: any) {
    appStore.showError(err?.message || t('common.unknownError'))
  }
}

async function markSelectedAsRead() {
  if (!selectedAnnouncement.value) return
  await markAsRead(selectedAnnouncement.value.id)
  appStore.showSuccess(t('announcements.markedAsRead'))
}

async function markAllAsRead() {
  try {
    await announcementStore.markAllAsRead()
    appStore.showSuccess(t('announcements.allMarkedAsRead'))
  } catch (err: any) {
    appStore.showError(err?.message || t('common.unknownError'))
  }
}

function handleEscape(e: KeyboardEvent) {
  if (e.key === 'Escape' && isModalOpen.value) {
    closeModal()
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleEscape)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleEscape)
  document.body.style.overflow = ''
})

watch(
  [isModalOpen, () => announcementStore.currentPopup],
  ([modal, popup]) => {
    document.body.style.overflow = (modal || popup) ? 'hidden' : ''
  },
)
</script>

<style scoped>
.announcement-master-detail {
  --announcement-accent: #ff3d71;
  --announcement-background: #fafafa;
  --announcement-surface: #ffffff;
  --announcement-surface-muted: #f4f4f5;
  --announcement-border: #e4e4e7;
  --announcement-border-strong: #d4d4d8;
  --announcement-text: #18181b;
  --announcement-muted: #71717a;
  --announcement-subtle: #a1a1aa;
}

.announcement-trigger {
  position: relative;
  display: flex;
  width: 2.25rem;
  height: 2.25rem;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem;
  color: #52525b;
  transition: background-color 150ms ease, color 150ms ease;
}

.announcement-trigger:hover {
  background: #f4f4f5;
  color: #18181b;
}

.announcement-trigger-unread {
  color: #18181b;
}

.announcement-trigger-dot,
.announcement-unread-dot {
  border-radius: 999px;
  background: #ff3d71;
}

.announcement-trigger-dot {
  position: absolute;
  top: 0.35rem;
  right: 0.35rem;
  width: 0.4rem;
  height: 0.4rem;
  box-shadow: 0 0 0 2px #ffffff;
}

.announcement-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  overflow-y: auto;
  background: rgb(9 9 11 / 46%);
  backdrop-filter: blur(4px);
}

.announcement-master-detail {
  display: grid;
  width: min(68rem, calc(100vw - 2rem));
  height: min(42.5rem, calc(100vh - 3rem));
  grid-template-rows: 4rem minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--announcement-border-strong);
  border-radius: 0.625rem;
  background: var(--announcement-surface);
  color: var(--announcement-text);
  box-shadow: 0 24px 70px rgb(0 0 0 / 24%);
}

.announcement-header {
  display: flex;
  align-items: center;
  padding: 0 1.25rem 0 1.5rem;
  border-bottom: 1px solid var(--announcement-border);
}

.announcement-header h2 {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.announcement-count {
  display: inline-flex;
  min-width: 1.5rem;
  height: 1.375rem;
  align-items: center;
  justify-content: center;
  margin-left: 0.55rem;
  padding: 0 0.45rem;
  border-radius: 0.375rem;
  background: var(--announcement-surface-muted);
  color: var(--announcement-muted);
  font-size: 0.6875rem;
  font-weight: 700;
}

.announcement-header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: auto;
}

.announcement-icon-button,
.announcement-secondary-button,
.announcement-primary-button,
.announcement-back-button,
.announcement-list-item {
  border: 0;
  font: inherit;
  cursor: pointer;
}

.announcement-icon-button {
  display: grid;
  width: 2.125rem;
  height: 2.125rem;
  place-items: center;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--announcement-subtle);
}

.announcement-icon-button:hover {
  background: var(--announcement-surface-muted);
  color: var(--announcement-text);
}

.announcement-primary-button,
.announcement-secondary-button {
  display: inline-flex;
  height: 2.375rem;
  align-items: center;
  justify-content: center;
  padding: 0 1rem;
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  font-weight: 650;
}

.announcement-primary-button {
  border: 1px solid #18181b;
  background: #18181b;
  color: #ffffff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
}

.announcement-primary-button:hover {
  background: #27272a;
}

.announcement-secondary-button {
  border: 1px solid var(--announcement-border-strong);
  background: var(--announcement-surface);
  color: var(--announcement-text);
}

.announcement-secondary-button:hover {
  background: var(--announcement-surface-muted);
}

.announcement-secondary-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.announcement-layout {
  display: grid;
  min-height: 0;
  grid-template-columns: 21rem minmax(0, 1fr);
}

.announcement-list-panel {
  display: flex;
  min-height: 0;
  flex-direction: column;
  border-right: 1px solid var(--announcement-border);
  background: var(--announcement-background);
}

.announcement-list-heading {
  display: flex;
  height: 3rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  padding: 0 1.125rem;
  border-bottom: 1px solid var(--announcement-border);
  color: var(--announcement-muted);
  font-size: 0.75rem;
}

.announcement-list-heading span:last-child {
  color: var(--announcement-text);
  font-weight: 600;
}

.announcement-list-scroll {
  min-height: 0;
  padding: 0.5rem;
  overflow-y: auto;
}

.announcement-list-item {
  position: relative;
  display: grid;
  width: 100%;
  min-height: 4.5rem;
  grid-template-columns: 2rem minmax(0, 1fr) 0.5rem 1rem;
  align-items: center;
  gap: 0.6875rem;
  margin-bottom: 0.1875rem;
  padding: 0 0.75rem;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--announcement-text);
  text-align: left;
}

.announcement-list-item:hover {
  background: var(--announcement-surface-muted);
}

.announcement-list-item-selected {
  border-color: var(--announcement-border-strong);
  background: var(--announcement-surface);
  color: var(--announcement-text);
  box-shadow: 0 1px 2px rgb(0 0 0 / 2.5%);
}

.announcement-list-item-selected::before {
  position: absolute;
  top: 0.8125rem;
  bottom: 0.8125rem;
  left: -1px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--announcement-accent);
  content: '';
}

.announcement-status-icon {
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border: 1px solid var(--announcement-border);
  border-radius: 0.5rem;
  background: var(--announcement-surface);
  color: var(--announcement-subtle);
}

.announcement-status-icon svg {
  width: 1rem;
  height: 1rem;
}

.announcement-list-copy {
  min-width: 0;
}

.announcement-list-copy strong,
.announcement-list-copy time {
  display: block;
}

.announcement-list-copy strong {
  overflow: hidden;
  font-size: 0.8125rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.announcement-list-copy time {
  margin-top: 0.3rem;
  color: var(--announcement-subtle);
  font-size: 0.6875rem;
}

.announcement-unread-dot {
  width: 0.375rem;
  height: 0.375rem;
}

.announcement-chevron {
  width: 1rem;
  height: 1rem;
  color: #b4b4bd;
}

.announcement-loading,
.announcement-empty-list,
.announcement-empty-detail {
  display: flex;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
}

.announcement-loading {
  min-height: 12rem;
}

.announcement-spinner {
  width: 1.75rem;
  height: 1.75rem;
  border: 2px solid var(--announcement-border);
  border-top-color: var(--announcement-text);
  border-radius: 999px;
  animation: announcement-spin 800ms linear infinite;
}

.announcement-empty-list,
.announcement-empty-detail {
  flex-direction: column;
  gap: 0.5rem;
  padding: 2rem;
  color: var(--announcement-muted);
  text-align: center;
}

.announcement-empty-list strong,
.announcement-empty-detail strong {
  color: var(--announcement-text);
  font-size: 0.875rem;
}

.announcement-empty-list span,
.announcement-empty-detail > span:last-child {
  font-size: 0.75rem;
}

.announcement-detail-panel {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr) auto;
  background: var(--announcement-surface);
}

.announcement-detail-content {
  min-height: 0;
  padding: 2.125rem 2.375rem;
  overflow-y: auto;
}

.announcement-back-button {
  display: none;
  align-items: center;
  gap: 0.375rem;
  margin: 0 0 1rem;
  padding: 0;
  background: transparent;
  color: var(--announcement-muted);
  font-size: 0.75rem;
}

.announcement-back-button svg {
  width: 1rem;
  height: 1rem;
}

.announcement-detail-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--announcement-muted);
  font-size: 0.75rem;
  font-weight: 620;
}

.announcement-detail-label span {
  width: 1.125rem;
  height: 2px;
  background: var(--announcement-accent);
}

.announcement-detail-content h3 {
  margin: 1rem 0 0.6875rem;
  color: var(--announcement-text);
  font-size: 1.875rem;
  font-weight: 760;
  letter-spacing: -0.03em;
  line-height: 1.2;
}

.announcement-meta,
.announcement-meta span {
  display: flex;
  align-items: center;
}

.announcement-meta {
  gap: 1.125rem;
  padding-bottom: 1.5625rem;
  border-bottom: 1px solid var(--announcement-border);
  color: #8b8b95;
  font-size: 0.75rem;
}

.announcement-meta span {
  gap: 0.375rem;
}

.announcement-meta svg,
.announcement-read-state svg {
  width: 0.9375rem;
  height: 0.9375rem;
  flex: 0 0 auto;
}

.announcement-copy-card {
  position: relative;
  margin-top: 1.625rem;
  padding: 1.375rem 1.5rem;
  overflow: hidden;
  border: 1px solid var(--announcement-border);
  border-radius: 0.5rem;
  background: var(--announcement-background);
}

.announcement-copy-card::before {
  position: absolute;
  top: 1.125rem;
  bottom: 1.125rem;
  left: -1px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: #27272a;
  content: '';
}

.announcement-detail-footer {
  display: flex;
  min-height: 4rem;
  align-items: center;
  gap: 0.625rem;
  padding: 0.75rem 1.5rem;
  border-top: 1px solid var(--announcement-border);
  background: var(--announcement-surface);
}

.announcement-read-state {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.4375rem;
  margin-right: auto;
  color: #8b8b95;
  font-size: 0.75rem;
}

.announcement-read-state span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.announcement-empty-icon {
  display: grid;
  width: 3rem;
  height: 3rem;
  place-items: center;
  margin-bottom: 0.25rem;
  border: 1px solid var(--announcement-border);
  border-radius: 0.625rem;
  background: var(--announcement-background);
  color: var(--announcement-subtle);
}

.announcement-fade-enter-active,
.announcement-fade-leave-active {
  transition: opacity 180ms ease;
}

.announcement-fade-enter-from,
.announcement-fade-leave-to {
  opacity: 0;
}

.announcement-fade-enter-active .announcement-master-detail,
.announcement-fade-leave-active .announcement-master-detail {
  transition: transform 180ms ease, opacity 180ms ease;
}

.announcement-fade-enter-from .announcement-master-detail,
.announcement-fade-leave-to .announcement-master-detail {
  opacity: 0;
  transform: translateY(-0.5rem) scale(0.985);
}

.announcement-list-scroll::-webkit-scrollbar,
.announcement-detail-content::-webkit-scrollbar {
  width: 6px;
}

.announcement-list-scroll::-webkit-scrollbar-thumb,
.announcement-detail-content::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: #d4d4d8;
}

@keyframes announcement-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 767px) {
  .announcement-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .announcement-master-detail {
    width: 100%;
    height: min(88vh, 46rem);
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: 0.75rem 0.75rem 0 0;
  }

  .announcement-header {
    padding: 0 0.875rem 0 1rem;
  }

  .announcement-header .announcement-secondary-button {
    display: none;
  }

  .announcement-layout {
    display: block;
    min-height: 0;
    overflow: hidden;
  }

  .announcement-list-panel,
  .announcement-detail-panel {
    height: 100%;
  }

  .announcement-list-panel {
    border-right: 0;
  }

  .announcement-detail-panel {
    display: none;
  }

  .announcement-layout-selected .announcement-list-panel {
    display: none;
  }

  .announcement-layout-selected .announcement-detail-panel {
    display: grid;
  }

  .announcement-back-button {
    display: inline-flex;
  }

  .announcement-detail-content {
    padding: 1.25rem 1rem;
  }

  .announcement-detail-content h3 {
    font-size: 1.5rem;
  }

  .announcement-meta {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .announcement-detail-footer {
    flex-wrap: wrap;
    padding: 0.75rem 1rem;
  }

  .announcement-read-state {
    width: 100%;
    margin-right: 0;
  }
}

:global(.dark) .announcement-master-detail {
  --announcement-background: #09090b;
  --announcement-surface: #111113;
  --announcement-surface-muted: #18181b;
  --announcement-border: #27272a;
  --announcement-border-strong: #3f3f46;
  --announcement-text: #fafafa;
  --announcement-muted: #a1a1aa;
  --announcement-subtle: #71717a;
}

:global(.dark) .announcement-trigger {
  color: #b4b4bd;
}

:global(.dark) .announcement-trigger:hover {
  background: #18181b;
  color: #fafafa;
}

:global(.dark) .announcement-trigger-dot {
  box-shadow: 0 0 0 2px #09090b;
}

:global(.dark) .announcement-primary-button {
  border-color: #fafafa;
  background: #fafafa;
  color: #09090b;
}

:global(.dark) .announcement-copy-card::before {
  background: #fafafa;
}
</style>
