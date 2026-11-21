<template>
  <div class="hero-scene home-hero-scene" :class="{ 'is-ready': sceneReady }" aria-hidden="true">
    <img
      v-if="imageUrl && !imageFailed"
      class="home-hero-image"
      :src="imageUrl"
      alt=""
      decoding="async"
      fetchpriority="high"
      @error="imageFailed = true"
    />
    <template v-else>
      <div ref="sceneHost" class="hero-scene-canvas"></div>
      <div class="hero-terminal">
        <div class="code-window">
          <div class="code-toolbar">
            <span class="terminal-language">cURL</span>
            <span class="terminal-label">API / STREAM</span>
          </div>
          <pre class="code-body"><code><span v-for="(line, index) in codeLines" :key="index" class="code-line"><span class="line-number">{{ index + 1 }}</span><span :class="line.syntax">{{ line.text }}</span></span></code></pre>
          <div class="code-footnote"><span>&gt;_</span><span>OpenAI compatible API</span></div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { inject, ref, watch } from 'vue'

const props = withDefaults(defineProps<{ imageUrl?: string }>(), { imageUrl: '' })
const imageFailed = ref(false)
const sceneReady = ref(false)
const sceneHost = ref<HTMLElement | null>(null)

interface HeroSceneModule {
  mountHeroScene: (host: HTMLElement, onReady: (ready: boolean) => void) => (() => void) | undefined
}

const loadScene = inject<() => Promise<HeroSceneModule>>('homeHeroSceneLoader', () => {
  const moduleUrl = `${import.meta.env.BASE_URL}homepage-assets/hero-canvas.js`
  return import(/* @vite-ignore */ moduleUrl)
})

const codeLines = [
  { text: '$ curl /v1/chat/completions', syntax: 'syntax-keyword' },
  { text: '  -H "Authorization: Bearer $API_KEY"', syntax: '' },
  { text: '  -d \'{"model":"your-model", ...}\'', syntax: 'syntax-string' },
  { text: '', syntax: '' },
  { text: 'HTTP/1.1 200 OK', syntax: 'syntax-keyword' },
  { text: 'data: {"delta": "Hello, AI."}', syntax: 'syntax-string' },
  { text: 'data: [DONE]', syntax: '' },
]

watch(() => props.imageUrl, () => { imageFailed.value = false })

watch(sceneHost, (host, _previous, onCleanup) => {
  sceneReady.value = false
  if (!host) return

  let cancelled = false
  let dispose: (() => void) | undefined
  onCleanup(() => {
    cancelled = true
    dispose?.()
  })

  loadScene()
    .then((scene: HeroSceneModule) => {
      if (cancelled) return
      dispose = scene.mountHeroScene(host, (ready) => {
        if (!cancelled) sceneReady.value = ready
      })
    })
    .catch(() => {
      // Keep the local terminal visible when WebGL or the scene module is unavailable.
    })
}, { flush: 'post' })
</script>

<style scoped>
/* Scene and code-window rules copied from the reference stylesheet. */
.hero-scene{position:absolute;top:0;right:0;bottom:0;left:0;pointer-events:none;overflow:hidden;z-index:0;background:#101214}
.hero-scene-canvas{position:absolute;top:0;right:0;bottom:0;left:0;width:100%;height:100%;opacity:0;transition:opacity .4s ease}
.hero-scene-canvas :deep(canvas){display:block;width:100%;height:100%}
.hero-scene.is-ready .hero-scene-canvas{opacity:1}
.code-window{border:1px solid #343c43;border-radius:6px;overflow:hidden;background:#14181c;color:#dce1e5;min-width:0;box-shadow:0 18px 48px #121a2014}
.code-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;height:55px;border-bottom:1px solid #323a41;padding:0 17px;background:#1c2227}
.code-body{margin:0;padding:28px 24px 28px 12px;min-height:356px;overflow-x:auto;font:11px/1.95 var(--mono,Consolas,monospace);-moz-tab-size:4;tab-size:4}
.code-line{display:flex;min-height:21px;white-space:pre}
.line-number{display:inline-block;text-align:right;min-width:30px;padding-right:19px;color:#7d8993;-webkit-user-select:none;user-select:none}
.code-footnote{display:flex;align-items:center;gap:8px;border-top:1px solid #323a41;padding:13px 18px;color:#929da6;font-size:8px}
.syntax-string{color:var(--cyan,#a8dedf)}
.syntax-keyword{color:#dce1e5}

.home-hero-image{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;object-position:center}
.hero-terminal{position:absolute;top:50%;left:60%;width:min(450px,35vw);transform:translateY(-54%)}
.hero-terminal .code-body{min-height:0;padding:27px 20px 27px 9px;font-size:13px}
.terminal-language{height:100%;display:flex;align-items:center;position:relative;font:11px var(--mono,Consolas,monospace);color:#e3e9ed}
.terminal-language::after{content:"";position:absolute;bottom:-1px;left:0;right:0;height:2px;background:var(--signal,#a8dedf)}
.terminal-label{font:9px var(--mono,Consolas,monospace);color:#929da6;letter-spacing:1px}

@media(max-width:1150px){
  .hero-terminal .code-body{font-size:11px}
}
@media(max-width:959px){
  .hero-terminal{top:auto;bottom:82px;left:auto;right:5%;width:330px;transform:none}
  .code-toolbar{height:49px;padding:0 12px}
  .hero-terminal .code-body{padding:20px 12px 20px 5px;font-size:10px}
  .line-number{min-width:25px;padding-right:13px}
  .code-footnote{font-size:8px;padding:12px;gap:6px}
}
@media(max-width:767px){
  .hero-terminal{display:none}
}
@media(prefers-reduced-motion:reduce){
  .hero-scene-canvas{transition:none}
}
</style>
