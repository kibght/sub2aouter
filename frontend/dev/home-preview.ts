import type { Plugin } from 'vite'

// This plugin is used only by vite.home-preview.config.ts, never by production.
const publicSettings = {
  site_name: 'Sub2API',
  site_logo: '/logo.svg',
  site_subtitle: '守护隐私，官方保真。',
  home_hero_image: '',
  home_content: '',
  compact_home_enabled: false,
  api_base_url: 'https://api.example.com',
  doc_url: '',
  custom_menu_items: [],
  custom_endpoints: [],
  model_plaza_enabled: true,
  model_plaza_require_auth: false,
  backend_mode_enabled: false,
  registration_enabled: true,
  registration_email_suffix_whitelist: [],
  table_page_size_options: [10, 20, 50, 100],
  table_default_page_size: 20,
}

const tokenModel = (name: string, platform: string, input: number, output: number) => ({
  name,
  platform,
  pricing: {
    billing_mode: 'token',
    input_price: input / 1_000_000,
    output_price: output / 1_000_000,
    cache_write_price: null,
    cache_read_price: null,
    intervals: [],
  },
  official_pricing: null,
})
const group = (id: number, name: string, platform: string, rate: number, models: ReturnType<typeof tokenModel>[]) => ({
  id, name, platform, rate_multiplier: rate, models,
  description: '', subscription_type: 'standard', peak_rate_enabled: false,
  peak_start: '', peak_end: '', peak_rate_multiplier: 1, is_exclusive: false,
  image_rate_independent: false, image_rate_multiplier: 1,
  video_rate_independent: false, video_rate_multiplier: 1,
  long_context_pricing_enabled: false,
})

const modelPlaza = {
  description: 'Preview fixture data. Not a production quote.',
  groups: [
    group(1, 'OpenAI', 'openai', 0.5, [
      tokenModel('gpt-4.1', 'openai', 2, 8),
      tokenModel('gpt-4.1-mini', 'openai', 0.4, 1.6),
    ]),
    group(2, 'Claude', 'anthropic', 0.8, [
      tokenModel('claude-sonnet-4-5', 'anthropic', 3, 15),
      tokenModel('claude-opus-4-1', 'anthropic', 15, 75),
    ]),
    group(3, 'Gemini', 'gemini', 0.5, [
      tokenModel('gemini-2.5-pro', 'gemini', 1.25, 10),
      tokenModel('gemini-2.5-flash', 'gemini', 0.3, 2.5),
    ]),
    group(4, 'Grok', 'grok', 0.5, [
      tokenModel('grok-4', 'grok', 3, 15),
      tokenModel('grok-3-mini', 'grok', 0.3, 0.5),
    ]),
  ],
}

export function homePreviewApi(): Plugin {
  return {
    name: 'home-preview-api',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace('</head>', `<script>window.__APP_CONFIG__=${JSON.stringify(publicSettings)};</script></head>`)
      },
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0]
        const data = path === '/setup/status' ? { needs_setup: false, step: 'complete' }
          : path === '/api/v1/model-plaza' ? modelPlaza
          : path === '/api/v1/settings/public' ? publicSettings : undefined
        if (!data || request.method !== 'GET') return next()
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        response.end(JSON.stringify({ code: 0, data }))
      })
    },
  }
}
