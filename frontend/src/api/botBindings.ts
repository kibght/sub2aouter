/**
 * Bot binding API endpoints
 * Handles website-side bot binding codes and bound bot accounts
 */

import { apiClient } from './client'

/**
 * One-time binding code used in a chat group command
 */
export interface BotBindingCode {
  code: string
  expires_at: string
  expires_in_seconds: number
}

/**
 * A bot account bound to the current user
 */
export interface BotBinding {
  id: number
  platform: string
  external_id: string
  token_prefix: string
  bound_at: string
  last_used_at: string | null
  created_at: string
}

/**
 * Response payload of the bot binding list endpoint
 */
export interface BotBindingListResponse {
  items: BotBinding[]
}

/**
 * Generate a one-time bot binding code
 * @returns Binding code with its expiration information
 */
export async function createCode(): Promise<BotBindingCode> {
  const { data } = await apiClient.post<BotBindingCode>('/user/bot-bindings/code')
  return data
}

/**
 * List bot accounts bound to the current user
 * @returns Bindings wrapper payload
 */
export async function list(): Promise<BotBindingListResponse> {
  const { data } = await apiClient.get<BotBindingListResponse>('/user/bot-bindings')
  return data
}

/**
 * Revoke a bot binding
 * @param id - Binding identifier
 * @returns Whether the binding was revoked
 */
export async function revoke(id: number): Promise<{ revoked: boolean }> {
  const { data } = await apiClient.delete<{ revoked: boolean }>(`/user/bot-bindings/${id}`)
  return data
}

export const botBindingsAPI = {
  createCode,
  list,
  revoke,
}

export default botBindingsAPI
