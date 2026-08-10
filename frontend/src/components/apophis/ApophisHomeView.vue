<template>
  <div class="apophis-home relative min-h-screen overflow-x-clip bg-background text-foreground">
    <div class="pointer-events-none absolute inset-0">
      <div
        class="absolute inset-0 bg-[radial-gradient(circle_at_15%_10%,hsl(var(--primary)/0.16),transparent_28%),radial-gradient(circle_at_85%_20%,hsl(var(--accent)/0.32),transparent_30%),linear-gradient(hsl(var(--border)/0.35)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--border)/0.35)_1px,transparent_1px)] bg-[size:auto,auto,72px_72px,72px_72px]"
      ></div>
    </div>

    <header
      data-test="home-nav"
      :data-state="isScrolled ? 'compact' : 'expanded'"
      class="sticky top-0 z-30 px-4 transition-all duration-500 ease-out"
      :class="isScrolled ? 'py-2' : 'py-4'"
    >
      <nav
        class="mx-auto flex items-center justify-between gap-4 border transition-all duration-500 ease-out"
        :class="isScrolled
          ? 'max-w-6xl rounded-2xl border-border/80 bg-background/85 px-4 py-2 shadow-lg backdrop-blur-xl'
          : 'max-w-7xl rounded-[1.75rem] border-transparent bg-transparent px-0 py-0 shadow-none'"
      >
        <RouterLink to="/" class="flex items-center gap-3">
          <span
            class="flex overflow-hidden border border-border bg-card shadow-sm transition-all duration-500"
            :class="isScrolled ? 'h-9 w-9 rounded-xl' : 'h-10 w-10 rounded-2xl'"
          >
            <img :src="siteLogo || '/logo.svg'" alt="Logo" class="h-full w-full object-contain" />
          </span>
          <span class="hidden text-sm font-semibold sm:block">{{ siteName }}</span>
        </RouterLink>

        <div class="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <a href="#models" class="hover:text-foreground">模型生态</a>
          <a href="#features" class="hover:text-foreground">核心能力</a>
          <a href="#workflow" class="hover:text-foreground">接入流程</a>
          <a v-if="docUrl" :href="docUrl" target="_blank" rel="noopener" class="hover:text-foreground">文档</a>
        </div>

        <div class="flex items-center gap-2">
          <LocaleSwitcher />
          <button
            data-test="theme-toggle"
            class="rounded-xl p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            :title="isDark ? '切换到浅色模式' : '切换到深色模式'"
            @click="toggleTheme"
          >
            <Icon :name="isDark ? 'sun' : 'moon'" size="md" />
          </button>
          <RouterLink :to="isAuthenticated ? dashboardPath : '/login'" class="home-primary-button btn-sm">
            {{ isAuthenticated ? '控制台' : '登录' }}
          </RouterLink>
        </div>
      </nav>
    </header>

    <main class="relative z-10">
      <section
        class="mx-auto grid max-w-7xl gap-12 px-5 pb-16 pt-14 lg:grid-cols-[1.06fr_0.94fr] lg:pb-24 lg:pt-20"
      >
        <div class="flex flex-col justify-center">
          <div
            class="mb-5 inline-flex w-fit items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm"
          >
            <span class="h-2 w-2 rounded-full bg-primary"></span>
            企业级 AI API 网关 · 多账号池 · 统一计费
          </div>
          <h1 class="max-w-4xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
            一站接入全球 AI 能力，像调用 OpenAI 一样调用所有模型
          </h1>
          <p class="mt-6 max-w-2xl text-base leading-8 text-muted-foreground sm:text-lg">
            {{ siteSubtitle }}
          </p>
          <div class="mt-8 flex flex-col gap-3 sm:flex-row">
            <RouterLink :to="isAuthenticated ? dashboardPath : '/login'" class="home-primary-button px-6 py-3 text-sm">
              {{ isAuthenticated ? '进入控制台' : '获取 API Key' }}
              <Icon name="arrowRight" size="sm" class="ml-2" />
            </RouterLink>
            <a
              v-if="communityUrl"
              :href="communityUrl"
              target="_blank"
              rel="noopener"
              class="home-primary-button group relative overflow-hidden px-6 py-3 text-sm shadow-2xl shadow-primary/30 ring-2 ring-primary/40 transition hover:-translate-y-0.5 hover:shadow-primary/40"
            >
              <span class="absolute inset-0 bg-gradient-to-r from-primary via-primary to-accent opacity-95"></span>
              <span class="relative flex items-center gap-2 text-primary-foreground">
                <span class="h-2 w-2 rounded-full bg-primary-foreground shadow-[0_0_14px_hsl(var(--primary-foreground))]"></span>
                交流群
              </span>
            </a>
          </div>

          <div data-test="hero-stats" class="mt-10 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
            <div v-for="stat in heroStats" :key="stat.label" class="rounded-2xl border border-border bg-card/70 p-4 shadow-sm">
              <div class="text-2xl font-semibold">{{ stat.value }}</div>
              <div class="mt-1 text-xs text-muted-foreground">{{ stat.label }}</div>
            </div>
          </div>
        </div>

        <div data-test="endpoint-card" class="relative min-w-0">
          <div
            class="absolute -inset-1 rounded-[2.25rem] bg-[linear-gradient(135deg,hsl(var(--primary)/0.55),hsl(var(--accent)/0.28),hsl(var(--border)/0.95))] opacity-80 blur-sm"
          ></div>
          <div
            class="relative min-w-0 overflow-hidden rounded-[2rem] border border-primary/30 bg-card/95 p-px shadow-[0_28px_90px_hsl(var(--primary)/0.22)] backdrop-blur"
          >
            <div class="min-w-0 overflow-hidden rounded-[1.95rem] border border-border/80 bg-background/95 p-4">
              <div class="min-w-0 overflow-hidden rounded-[1.5rem] border border-primary/20 bg-card/70 p-5 shadow-inner shadow-primary/5">
                <div class="mb-4 flex min-w-0 items-center justify-between gap-3">
                  <div class="min-w-0">
                    <p class="text-xs uppercase tracking-[0.3em] text-muted-foreground">Base URL</p>
                    <h2 class="mt-1 break-words text-lg font-semibold">复制 Base URL，立即切换</h2>
                  </div>
                  <span class="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">Online</span>
                </div>

                <div class="mb-4 grid min-w-0 grid-cols-2 gap-2 overflow-hidden rounded-2xl border border-border bg-muted/40 p-1">
                  <button
                    type="button"
                    data-test="endpoint-tab-openai"
                    class="min-w-0 rounded-xl px-3 py-2 text-left transition"
                    :class="activeEndpoint === 'openai' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                    @click="activeEndpoint = 'openai'"
                  >
                    <span class="block text-sm font-semibold">OpenAI</span>
                    <span class="mt-0.5 block text-[11px]">Base URL 带 /v1</span>
                  </button>
                  <button
                    type="button"
                    data-test="endpoint-tab-claude"
                    class="min-w-0 rounded-xl px-3 py-2 text-left transition"
                    :class="activeEndpoint === 'claude' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                    @click="activeEndpoint = 'claude'"
                  >
                    <span class="block text-sm font-semibold">Claude</span>
                    <span class="mt-0.5 block text-[11px]">无 /v1 后缀</span>
                  </button>
                </div>

                <div class="flex items-center gap-2 rounded-2xl border border-border bg-muted/40 p-3">
                  <code data-test="endpoint-url" class="min-w-0 flex-1 truncate text-sm text-foreground">{{ endpointUrl }}</code>
                  <button
                    data-test="copy-endpoint"
                    class="rounded-xl bg-card p-2 text-muted-foreground hover:text-foreground"
                    :title="copied ? '已复制' : '复制 Base URL'"
                    @click="copyEndpoint"
                  >
                    <Icon :name="copied ? 'check' : 'copy'" size="sm" />
                  </button>
                </div>
                <p data-test="endpoint-note" class="mt-2 break-words text-xs leading-5 text-muted-foreground">
                  {{ endpointNote }}
                </p>

                <div class="mt-5 grid min-w-0 gap-3 sm:grid-cols-2">
                  <div v-for="feature in endpointFeatures" :key="feature.title" class="min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-4">
                    <p class="break-words text-sm font-semibold">{{ feature.title }}</p>
                    <p class="mt-2 break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{{ feature.description }}</p>
                  </div>
                </div>

                <div data-test="endpoint-examples" class="mt-5 min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-4 font-mono text-xs leading-6 text-muted-foreground">
                  <p v-for="example in endpointExamples" :key="example.path" class="break-all">
                    <span class="text-primary">{{ example.method }}</span> {{ example.path }}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="models" class="border-y border-border bg-card/40 px-5 py-10">
        <div class="mx-auto max-w-7xl">
          <div class="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <p class="text-sm font-medium text-primary">模型生态</p>
              <h2 class="mt-2 text-3xl font-semibold">一个入口，覆盖主流大模型平台</h2>
            </div>
            <p class="max-w-xl text-sm leading-6 text-muted-foreground">保留熟悉的 OpenAI 调用方式，同时接入多个上游平台与账号池。</p>
          </div>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            <div v-for="model in modelEcosystem" :key="model" class="rounded-2xl border border-border bg-background px-4 py-4 text-center text-sm font-medium shadow-sm">
              {{ model }}
            </div>
          </div>
        </div>
      </section>

      <section id="features" class="mx-auto max-w-7xl px-5 py-16 lg:py-24">
        <div class="mb-10 max-w-2xl">
          <p class="text-sm font-medium text-primary">为什么选择 Sub2API</p>
          <h2 class="mt-2 text-3xl font-semibold">从接入、调度到运营的一体化网关</h2>
        </div>
        <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <article v-for="feature in coreFeatures" :key="feature.title" class="rounded-3xl border border-border bg-card p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-lg">
            <div class="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Icon :name="feature.icon" size="md" />
            </div>
            <h3 class="text-lg font-semibold">{{ feature.title }}</h3>
            <p class="mt-3 text-sm leading-6 text-muted-foreground">{{ feature.description }}</p>
          </article>
        </div>
      </section>

      <section id="workflow" class="mx-auto max-w-7xl px-5 pb-16">
        <div class="rounded-[2rem] border border-border bg-card p-6 shadow-sm lg:p-10">
          <div class="grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
            <div>
              <p class="text-sm font-medium text-primary">快速上线</p>
              <h2 class="mt-2 text-3xl font-semibold">三步完成从订阅到 API 服务化</h2>
              <p class="mt-4 text-sm leading-6 text-muted-foreground">从账号接入到稳定运营，所有关键动作都在控制台完成。</p>
            </div>
            <div class="grid gap-4 md:grid-cols-3">
              <div v-for="(step, index) in workflowSteps" :key="step.title" class="rounded-2xl border border-border bg-background p-5">
                <span class="text-xs font-semibold text-primary">{{ String(index + 1).padStart(2, '0') }}</span>
                <h3 class="mt-4 font-semibold">{{ step.title }}</h3>
                <p class="mt-2 text-sm leading-6 text-muted-foreground">{{ step.description }}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="mx-auto max-w-7xl px-5 pb-6" aria-labelledby="privacy-card-title">
        <div data-test="privacy-card" class="relative overflow-hidden rounded-[2rem] border border-primary/20 bg-card px-6 py-8 shadow-sm lg:px-10 lg:py-10">
          <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_10%_15%,hsl(var(--primary)/0.12),transparent_34%),radial-gradient(circle_at_92%_90%,hsl(var(--accent)/0.22),transparent_30%)]"></div>
          <div class="relative grid gap-6 lg:grid-cols-[0.75fr_1.25fr] lg:items-center">
            <div class="flex items-start gap-4">
              <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary" aria-hidden="true">
                <Icon name="shield" size="md" />
              </div>
              <div>
                <p class="text-sm font-medium text-primary">隐私承诺</p>
                <h2 id="privacy-card-title" class="mt-2 text-2xl font-semibold sm:text-3xl">您的请求，只用于提供服务</h2>
              </div>
            </div>
            <p class="text-sm leading-7 text-muted-foreground sm:text-base">我们不记录任何 API 请求内容，不向第三方出售用户数据，也不会将用户数据用于广告投放或模型训练。系统仅在提供服务所必需的范围内，对相关数据进行临时处理。</p>
          </div>
        </div>
      </section>

      <section class="mx-auto max-w-7xl px-5 pb-20">
        <div data-test="home-cta" class="rounded-[2rem] border border-primary/20 bg-primary px-6 py-10 text-center text-primary-foreground shadow-2xl shadow-primary/20">
          <h2 class="text-3xl font-semibold">准备把 AI 能力交付给团队了吗？</h2>
          <p class="mx-auto mt-3 max-w-2xl text-sm leading-6 text-primary-foreground/80">用统一网关管理模型、账号、成本与安全策略，今天就开始。</p>
          <RouterLink :to="isAuthenticated ? dashboardPath : '/login'" class="mt-6 inline-flex rounded-2xl bg-primary-foreground px-6 py-3 text-sm font-semibold text-primary hover:bg-primary-foreground/90">
            进入控制台
          </RouterLink>
        </div>
      </section>
    </main>

    <footer class="relative z-10 border-t border-border px-5 py-8">
      <div class="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 text-sm text-muted-foreground sm:flex-row">
        <p>© {{ currentYear }} {{ siteName }}. {{ t('home.footer.allRightsReserved') }}</p>
        <div class="flex gap-4">
          <a v-if="docUrl" :href="docUrl" target="_blank" rel="noopener" class="hover:text-foreground">文档</a>
          <a v-if="communityUrl" :href="communityUrl" target="_blank" rel="noopener" class="hover:text-foreground">交流群</a>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore, useAppStore } from '@/stores'
import LocaleSwitcher from '@/components/common/LocaleSwitcher.vue'
import Icon from '@/components/icons/Icon.vue'
import { sanitizeUrl } from '@/utils/url'

const { t } = useI18n()
const authStore = useAuthStore()
const appStore = useAppStore()

const siteName = computed(() => appStore.cachedPublicSettings?.site_name || appStore.siteName || 'Sub2API')
const siteLogo = computed(() => sanitizeUrl(appStore.cachedPublicSettings?.site_logo || appStore.siteLogo || '', { allowRelative: true, allowDataUrl: true }))
const siteSubtitle = computed(() => appStore.cachedPublicSettings?.site_subtitle || 'AI API Gateway Platform')
const docUrl = computed(() => sanitizeUrl(appStore.cachedPublicSettings?.doc_url || appStore.docUrl || ''))
const apiBaseUrl = computed(() => {
  const configured = appStore.cachedPublicSettings?.api_base_url || window.location.origin
  return configured.replace(/\/+$/, '')
})
const communityUrl = computed(() => {
  const item = appStore.cachedPublicSettings?.custom_menu_items?.find((entry) => entry.visibility === 'user' && entry.url)
  return item ? sanitizeUrl(item.url) : ''
})

const isDark = ref(document.documentElement.classList.contains('dark'))
const isScrolled = ref(false)
const activeEndpoint = ref<'openai' | 'claude'>('openai')
const copied = ref(false)
let copiedTimer: number | undefined

const isAuthenticated = computed(() => authStore.isAuthenticated)
const dashboardPath = computed(() => authStore.isAdmin ? '/admin/dashboard' : '/dashboard')
const currentYear = computed(() => new Date().getFullYear())
const endpointUrl = computed(() => activeEndpoint.value === 'openai' ? `${apiBaseUrl.value}/v1` : apiBaseUrl.value)
const endpointNote = computed(() => activeEndpoint.value === 'openai'
  ? 'OpenAI 兼容接口需要使用带 /v1 的 Base URL。'
  : 'Claude Messages 接口使用站点根地址作为 Base URL，无 /v1 后缀。')
const endpointExamples = computed(() => activeEndpoint.value === 'openai'
  ? [{ method: 'POST', path: '/chat/completions' }, { method: 'GET', path: '/models' }]
  : [{ method: 'POST', path: '/v1/messages' }, { method: 'GET', path: '/v1/models' }])

const heroStats = [
  { value: '30+', label: '模型与端点' },
  { value: '99.9%', label: '可用性目标' },
  { value: '68ms', label: '平均路由延迟' },
  { value: '1 URL', label: '统一入口' },
]

const endpointFeatures = [
  { title: '智能账号调度', description: '按状态、倍率、并发和分组自动分流。' },
  { title: '全链路可观测', description: '请求、费用、模型、分组和账号状态集中查看。' },
  { title: '安全限流', description: 'API Key、分组、模型白名单和预算策略统一管理。' },
  { title: 'OpenAI 兼容', description: '兼容 /v1/chat/completions、/v1/messages 与 /v1/models。' },
]

const modelEcosystem = ['OpenAI', 'Claude', 'Gemini', 'DeepSeek', 'Qwen', 'Azure AI', 'Moonshot', 'Minimax']
const coreFeatures = [
  { icon: 'server', title: '统一 API 入口', description: '一套 Base URL 和 Key 连接多平台模型，降低迁移成本。' },
  { icon: 'sync', title: '账号池调度', description: '自动规避异常账号，按负载、分组和优先级调度。' },
  { icon: 'chartBar', title: '实时用量计费', description: '按用户、Key、分组、模型追踪用量与成本。' },
  { icon: 'shield', title: '权限与风控', description: '支持模型白名单、额度、限速和审计，适合团队协作。' },
] as const
const workflowSteps = [
  { title: '导入账号与代理', description: '批量接入 OpenAI、Claude、Gemini 等账号与代理。' },
  { title: '配置分组和策略', description: '设置分组倍率、模型白名单、并发和优先级。' },
  { title: '交付统一接口', description: '将 Base URL 与 Key 交付给应用或团队成员。' },
]

function toggleTheme() {
  isDark.value = !isDark.value
  document.documentElement.classList.toggle('dark', isDark.value)
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light')
}

function initTheme() {
  const savedTheme = localStorage.getItem('theme')
  if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    isDark.value = true
    document.documentElement.classList.add('dark')
  }
}

function updateScrollState() {
  isScrolled.value = window.scrollY > 24
}

async function copyEndpoint() {
  await navigator.clipboard.writeText(endpointUrl.value)
  copied.value = true
  window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copied.value = false
  }, 1800)
}

onMounted(() => {
  initTheme()
  updateScrollState()
  window.addEventListener('scroll', updateScrollState, { passive: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', updateScrollState)
  window.clearTimeout(copiedTimer)
})
</script>

<style scoped>
.apophis-home {
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}

.home-primary-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.75rem;
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  font-weight: 600;
  transition: transform 160ms ease, opacity 160ms ease, box-shadow 160ms ease;
}

.home-primary-button:hover {
  opacity: 0.9;
}

.home-primary-button:active {
  transform: scale(0.98);
}
</style>