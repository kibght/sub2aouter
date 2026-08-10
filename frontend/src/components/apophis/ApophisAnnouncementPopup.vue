<template>
  <Teleport to="body">
    <Transition name="announcement-popup-fade">
      <div v-if="displayedAnnouncement" class="announcement-popup-overlay">
        <section
          class="announcement-popup-shell"
          role="dialog"
          aria-modal="true"
          :aria-label="displayedAnnouncement.title"
          @click.stop
        >
          <header class="announcement-popup-header">
            <h2>{{ t('announcements.title') }}</h2>
            <button
              class="announcement-popup-icon-button"
              :aria-label="t('common.close')"
              data-testid="announcement-popup-close"
              @click="handleDismiss"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </header>

          <main class="announcement-popup-body">
            <div class="announcement-popup-label">
              <span></span>
              {{ t('announcements.title') }}
            </div>
            <h3>{{ displayedAnnouncement.title }}</h3>
            <div class="announcement-popup-meta">
              <span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
                <time>{{ formatRelativeWithDateTime(displayedAnnouncement.created_at) }}</time>
              </span>
              <span v-if="!preview">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                  <circle cx="12" cy="12" r="2.5" />
                </svg>
                {{ t('announcements.unread') }}
              </span>
            </div>
            <div class="announcement-popup-copy">
              <div
                class="markdown-body prose prose-sm max-w-none dark:prose-invert"
                v-html="renderedContent"
              ></div>
            </div>
          </main>

          <footer class="announcement-popup-footer">
            <div class="announcement-popup-state">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="12" cy="12" r="9" />
                <path d="m8 12 2.5 2.5L16 9" />
              </svg>
              <span>{{ preview ? t('announcements.description') : t('announcements.markReadHint') }}</span>
            </div>
            <button
              class="announcement-popup-primary-button"
              data-testid="announcement-popup-dismiss"
              @click="handleDismiss"
            >
              {{ preview ? t('common.close') : t('announcements.markRead') }}
            </button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useAnnouncementStore } from '@/stores/announcements'
import { formatRelativeWithDateTime } from '@/utils/format'
import type { Announcement, UserAnnouncement } from '@/types'
import '@/styles/announcement-markdown.css'

type PreviewAnnouncement = Pick<Announcement | UserAnnouncement, 'title' | 'content' | 'created_at'>

const props = withDefaults(defineProps<{
  announcement?: PreviewAnnouncement | null
  preview?: boolean
}>(), {
  announcement: null,
  preview: false,
})

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const announcementStore = useAnnouncementStore()
const displayedAnnouncement = computed(() => (
  props.preview ? props.announcement : announcementStore.currentPopup
))

marked.setOptions({
  breaks: true,
  gfm: true,
})

const renderedContent = computed(() => {
  const content = displayedAnnouncement.value?.content
  if (!content) return ''
  const html = marked.parse(content) as string
  return DOMPurify.sanitize(html)
})

function handleDismiss() {
  if (props.preview) {
    emit('close')
    return
  }
  announcementStore.dismissPopup()
}

watch(
  displayedAnnouncement,
  (popup) => {
    if (popup) {
      document.body.style.overflow = 'hidden'
    } else if (props.preview) {
      document.body.style.overflow = ''
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (props.preview) {
    document.body.style.overflow = ''
  }
})
</script>

<style scoped>
.announcement-popup-shell {
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

.announcement-popup-overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  overflow-y: auto;
  background: rgb(9 9 11 / 46%);
  backdrop-filter: blur(4px);
}

.announcement-popup-shell {
  display: grid;
  width: min(38.75rem, calc(100vw - 2rem));
  max-height: min(42rem, calc(100vh - 2rem));
  grid-template-rows: 4rem minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--announcement-border-strong);
  border-radius: 0.625rem;
  background: var(--announcement-surface);
  color: var(--announcement-text);
  box-shadow: 0 24px 70px rgb(0 0 0 / 24%);
}

.announcement-popup-header {
  display: flex;
  align-items: center;
  padding: 0 1.25rem 0 1.5rem;
  border-bottom: 1px solid var(--announcement-border);
}

.announcement-popup-header h2 {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.announcement-popup-icon-button {
  display: grid;
  width: 2.125rem;
  height: 2.125rem;
  place-items: center;
  margin-left: auto;
  border: 0;
  border-radius: 0.5rem;
  background: transparent;
  color: var(--announcement-subtle);
  cursor: pointer;
}

.announcement-popup-icon-button:hover {
  background: var(--announcement-surface-muted);
  color: var(--announcement-text);
}

.announcement-popup-icon-button svg {
  width: 1.125rem;
  height: 1.125rem;
}

.announcement-popup-body {
  padding: 1.75rem 1.5rem 1.875rem;
  overflow-y: auto;
}

.announcement-popup-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--announcement-muted);
  font-size: 0.75rem;
  font-weight: 620;
}

.announcement-popup-label span {
  width: 1.125rem;
  height: 2px;
  background: var(--announcement-accent);
}

.announcement-popup-body h3 {
  margin: 1rem 0 0.6875rem;
  color: var(--announcement-text);
  font-size: 1.75rem;
  font-weight: 760;
  letter-spacing: -0.03em;
  line-height: 1.2;
}

.announcement-popup-meta,
.announcement-popup-meta span {
  display: flex;
  align-items: center;
}

.announcement-popup-meta {
  gap: 1.125rem;
  padding-bottom: 1.375rem;
  border-bottom: 1px solid var(--announcement-border);
  color: #8b8b95;
  font-size: 0.75rem;
}

.announcement-popup-meta span {
  gap: 0.375rem;
}

.announcement-popup-meta svg,
.announcement-popup-state svg {
  width: 0.9375rem;
  height: 0.9375rem;
  flex: 0 0 auto;
}

.announcement-popup-copy {
  position: relative;
  margin-top: 1.5rem;
  padding: 1.25rem 1.375rem;
  overflow: hidden;
  border: 1px solid var(--announcement-border);
  border-radius: 0.5rem;
  background: var(--announcement-background);
}

.announcement-popup-copy::before {
  position: absolute;
  top: 1rem;
  bottom: 1rem;
  left: -1px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: #27272a;
  content: '';
}

.announcement-popup-footer {
  display: flex;
  min-height: 4rem;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1.5rem;
  border-top: 1px solid var(--announcement-border);
  background: var(--announcement-surface);
}

.announcement-popup-state {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.4375rem;
  margin-right: auto;
  color: #8b8b95;
  font-size: 0.75rem;
}

.announcement-popup-state span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.announcement-popup-primary-button {
  display: inline-flex;
  height: 2.375rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  padding: 0 1rem;
  border: 1px solid #18181b;
  border-radius: 0.5rem;
  background: #18181b;
  color: #ffffff;
  font-size: 0.8125rem;
  font-weight: 650;
  box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
  cursor: pointer;
}

.announcement-popup-primary-button:hover {
  background: #27272a;
}

.announcement-popup-fade-enter-active,
.announcement-popup-fade-leave-active {
  transition: opacity 180ms ease;
}

.announcement-popup-fade-enter-from,
.announcement-popup-fade-leave-to {
  opacity: 0;
}

.announcement-popup-fade-enter-active .announcement-popup-shell,
.announcement-popup-fade-leave-active .announcement-popup-shell {
  transition: transform 180ms ease, opacity 180ms ease;
}

.announcement-popup-fade-enter-from .announcement-popup-shell,
.announcement-popup-fade-leave-to .announcement-popup-shell {
  opacity: 0;
  transform: translateY(-0.5rem) scale(0.985);
}

.announcement-popup-body::-webkit-scrollbar {
  width: 6px;
}

.announcement-popup-body::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: #d4d4d8;
}

@media (max-width: 639px) {
  .announcement-popup-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .announcement-popup-shell {
    width: 100%;
    max-height: 88vh;
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: 0.75rem 0.75rem 0 0;
  }

  .announcement-popup-body {
    padding: 1.25rem 1rem;
  }

  .announcement-popup-body h3 {
    font-size: 1.5rem;
  }

  .announcement-popup-meta {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .announcement-popup-footer {
    padding: 0.75rem 1rem;
  }
}

:global(.dark) .announcement-popup-shell {
  --announcement-background: #09090b;
  --announcement-surface: #111113;
  --announcement-surface-muted: #18181b;
  --announcement-border: #27272a;
  --announcement-border-strong: #3f3f46;
  --announcement-text: #fafafa;
  --announcement-muted: #a1a1aa;
  --announcement-subtle: #71717a;
}

:global(.dark) .announcement-popup-copy::before {
  background: #fafafa;
}

:global(.dark) .announcement-popup-primary-button {
  border-color: #fafafa;
  background: #fafafa;
  color: #09090b;
}
</style>
