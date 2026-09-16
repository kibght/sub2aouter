import { describe, expect, it } from 'vitest'
import {
  CANVAS_CONFIGURED_MESSAGE,
  CANVAS_INIT_MESSAGE,
  CANVAS_READY_MESSAGE,
  buildCanvasEntryUrl,
  buildCanvasInitMessage,
  buildGatewayBaseUrl,
  isTrustedCanvasConfiguredMessage,
  isTrustedCanvasReadyMessage,
  normalizeCanvasAppPath,
} from '../bridge'

describe('infinite canvas bridge', () => {
  it('normalizes the embedded application path without leaking credentials', () => {
    expect(normalizeCanvasAppPath()).toBe('/canvas-app/')
    expect(normalizeCanvasAppPath('/canvas-app')).toBe('/canvas-app/')
    expect(normalizeCanvasAppPath('https://canvas.example.com/root')).toBe(
      'https://canvas.example.com/root/'
    )
  })

  it('builds self-hosted Canvas and OpenAI-compatible gateway URLs', () => {
    expect(buildCanvasEntryUrl('https://sub.example.com/')).toBe(
      'https://sub.example.com/canvas-app/canvas?mode=new'
    )
    expect(buildCanvasEntryUrl('https://sub.example.com/', '/custom-canvas')).toBe(
      'https://sub.example.com/custom-canvas/canvas?mode=new'
    )
    expect(buildGatewayBaseUrl('https://gateway.example.com/')).toBe(
      'https://gateway.example.com/v1'
    )
    expect(buildGatewayBaseUrl('https://gateway.example.com/v1/')).toBe(
      'https://gateway.example.com/v1'
    )
  })

  it('creates a versioned init message', () => {
    expect(
      buildCanvasInitMessage({
        baseUrl: 'https://sub.example.com/v1',
        apiKey: 'sk-test',
        theme: 'dark',
        locale: 'zh-CN',
      })
    ).toEqual({
      type: CANVAS_INIT_MESSAGE,
      version: 1,
      payload: {
        baseUrl: 'https://sub.example.com/v1',
        apiKey: 'sk-test',
        theme: 'dark',
        locale: 'zh-CN',
      },
    })
  })

  it('accepts lifecycle messages only from the expected iframe and origin', () => {
    const source = {} as Window
    const event = {
      origin: 'https://sub.example.com',
      source,
      data: { type: CANVAS_READY_MESSAGE, version: 1 },
    } as MessageEvent

    expect(isTrustedCanvasReadyMessage(event, source, 'https://sub.example.com')).toBe(true)
    expect(isTrustedCanvasReadyMessage(event, {} as Window, 'https://sub.example.com')).toBe(false)
    expect(isTrustedCanvasReadyMessage(event, source, 'https://evil.example.com')).toBe(false)

    const configuredEvent = {
      ...event,
      data: { type: CANVAS_CONFIGURED_MESSAGE, version: 1 },
    } as MessageEvent
    expect(
      isTrustedCanvasConfiguredMessage(configuredEvent, source, 'https://sub.example.com')
    ).toBe(true)
  })
})
