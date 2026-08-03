export const CANVAS_READY_MESSAGE = 'INFINITE_CANVAS_READY' as const
export const CANVAS_INIT_MESSAGE = 'SUB2_CANVAS_INIT' as const
export const CANVAS_CONFIGURED_MESSAGE = 'INFINITE_CANVAS_CONFIGURED' as const
export const CANVAS_BRIDGE_VERSION = 1 as const

export type CanvasTheme = 'light' | 'dark'

export interface CanvasInitPayload {
  baseUrl: string
  apiKey: string
  theme: CanvasTheme
  locale: string
}

export interface CanvasInitMessage {
  type: typeof CANVAS_INIT_MESSAGE
  version: typeof CANVAS_BRIDGE_VERSION
  payload: CanvasInitPayload
}

export function normalizeCanvasAppPath(value = '/canvas-app/'): string {
  const trimmed = value.trim() || '/canvas-app/'
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

export function buildGatewayBaseUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/v1`
}

export function buildCanvasInitMessage(payload: CanvasInitPayload): CanvasInitMessage {
  return {
    type: CANVAS_INIT_MESSAGE,
    version: CANVAS_BRIDGE_VERSION,
    payload,
  }
}

function isTrustedCanvasLifecycleMessage(
  event: MessageEvent,
  expectedSource: Window | null,
  expectedOrigin: string,
  expectedType: typeof CANVAS_READY_MESSAGE | typeof CANVAS_CONFIGURED_MESSAGE
): boolean {
  if (!expectedSource || event.source !== expectedSource || event.origin !== expectedOrigin) {
    return false
  }

  const data = event.data as { type?: unknown; version?: unknown } | null
  return data?.type === expectedType && data.version === CANVAS_BRIDGE_VERSION
}

export function isTrustedCanvasReadyMessage(
  event: MessageEvent,
  expectedSource: Window | null,
  expectedOrigin: string
): boolean {
  return isTrustedCanvasLifecycleMessage(
    event,
    expectedSource,
    expectedOrigin,
    CANVAS_READY_MESSAGE
  )
}

export function isTrustedCanvasConfiguredMessage(
  event: MessageEvent,
  expectedSource: Window | null,
  expectedOrigin: string
): boolean {
  return isTrustedCanvasLifecycleMessage(
    event,
    expectedSource,
    expectedOrigin,
    CANVAS_CONFIGURED_MESSAGE
  )
}
