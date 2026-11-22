import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import HomeHeroScene from '../HomeHeroScene.vue'

const scene = vi.hoisted(() => ({
  mountHeroScene: vi.fn(),
  dispose: vi.fn(),
  loadScene: vi.fn(),
}))

enableAutoUnmount(afterEach)

beforeEach(() => {
  scene.loadScene.mockReset().mockResolvedValue({ mountHeroScene: scene.mountHeroScene })
  scene.mountHeroScene.mockReset()
  scene.dispose.mockReset()
  scene.mountHeroScene.mockImplementation((host: HTMLElement, onReady: (ready: boolean) => void) => {
    const canvas = document.createElement('canvas')
    host.appendChild(canvas)
    onReady(true)
    return () => {
      scene.dispose()
      canvas.remove()
    }
  })
})

function mountHero(props: { imageUrl?: string } = {}) {
  return mount(HomeHeroScene, {
    props,
    global: { provide: { homeHeroSceneLoader: scene.loadScene } },
  })
}

describe('HomeHeroScene image lifecycle', () => {
  it.each([undefined, ''])('shows the built-in scene when imageUrl is %s', (imageUrl) => {
    const wrapper = mountHero({ imageUrl })

    expect(wrapper.find('.hero-scene-canvas').exists()).toBe(true)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.code-window').exists()).toBe(true)
  })

  it('replaces the built-in scene with the configured image', async () => {
    const wrapper = mountHero({ imageUrl: '/custom-hero.webp' })
    await flushPromises()

    expect(wrapper.get('img').attributes('src')).toBe('/custom-hero.webp')
    expect(wrapper.find('.hero-scene-canvas').exists()).toBe(false)
    expect(wrapper.find('.code-window').exists()).toBe(false)
    expect(scene.mountHeroScene).not.toHaveBeenCalled()
  })

  it('restores the built-in scene when the configured image fails to load', async () => {
    const wrapper = mountHero({ imageUrl: '/missing-hero.webp' })

    await wrapper.get('img').trigger('error')
    await flushPromises()

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.hero-scene-canvas').exists()).toBe(true)
    expect(scene.mountHeroScene).toHaveBeenCalledTimes(1)
  })

  it('tries a new image after a previous image failed to load', async () => {
    const wrapper = mountHero({ imageUrl: '/missing-hero.webp' })
    await wrapper.get('img').trigger('error')
    await flushPromises()

    await wrapper.setProps({ imageUrl: '/replacement-hero.webp' })

    expect(wrapper.get('img').attributes('src')).toBe('/replacement-hero.webp')
    expect(wrapper.find('.hero-scene-canvas').exists()).toBe(false)
    expect(scene.dispose).toHaveBeenCalledTimes(1)
  })

  it('restores the built-in scene when the image configuration is cleared', async () => {
    const wrapper = mountHero({ imageUrl: '/custom-hero.webp' })

    await wrapper.setProps({ imageUrl: '' })
    await flushPromises()

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.hero-scene-canvas').exists()).toBe(true)
    expect(scene.mountHeroScene).toHaveBeenCalledTimes(1)
  })
})

describe('HomeHeroScene canvas lifecycle', () => {
  it('reveals the original scene when its renderer is ready and disposes it on unmount', async () => {
    const wrapper = mountHero()
    await flushPromises()

    expect(scene.mountHeroScene).toHaveBeenCalledTimes(1)
    expect(wrapper.classes()).toContain('is-ready')
    expect(wrapper.find('canvas').exists()).toBe(true)

    wrapper.unmount()

    expect(scene.dispose).toHaveBeenCalledTimes(1)
  })

  it('keeps the terminal visible when the renderer cannot initialize', async () => {
    scene.mountHeroScene.mockReturnValue(undefined)
    const wrapper = mountHero()
    await flushPromises()

    expect(wrapper.find('.code-window').exists()).toBe(true)
    expect(wrapper.classes()).not.toContain('is-ready')
  })

  it('does not mount a pending scene after the component has unmounted', async () => {
    let resolveModule!: (value: { mountHeroScene: typeof scene.mountHeroScene }) => void
    scene.loadScene.mockReturnValue(new Promise((resolve) => { resolveModule = resolve }))
    const wrapper = mountHero()
    await nextTick()
    expect(scene.loadScene).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    resolveModule({ mountHeroScene: scene.mountHeroScene })
    await flushPromises()

    expect(scene.mountHeroScene).not.toHaveBeenCalled()
  })

  it('keeps the terminal visible when the scene asset cannot load', async () => {
    scene.loadScene.mockRejectedValue(new Error('Scene asset unavailable'))
    const wrapper = mountHero()
    await flushPromises()

    expect(wrapper.find('.code-window').exists()).toBe(true)
    expect(wrapper.classes()).not.toContain('is-ready')
  })
})
