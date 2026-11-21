import { defineConfig } from 'vite'
import baseConfig from './vite.config'
import { homePreviewApi } from './dev/home-preview'

export default defineConfig(async env => {
  const base = typeof baseConfig === 'function' ? await baseConfig(env) : await baseConfig
  return {
    ...base,
    plugins: [
      ...(base.plugins ?? []).filter(plugin => !plugin || typeof plugin !== 'object'
        || !('name' in plugin) || plugin.name !== 'inject-public-settings'),
      homePreviewApi(),
    ],
    server: { ...base.server, host: '127.0.0.1', port: 3000, strictPort: true },
  }
})
