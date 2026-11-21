import { apiClient } from '../client'

export interface BotLotteryPrize {
  id: string
  name: string
  amount: number
  weight: number
}

export interface BotLotteryConfig {
  enabled: boolean
  prizes: BotLotteryPrize[]
}

export interface BotLotteryRecord {
  id: number
  action: 'grant' | 'draw' | string
  count: number
  remaining: number
  prize_name?: string
  reward?: number
  notes?: string
  created_at: string
}

export interface BotLotteryUserHistory {
  user_id: number
  remaining: number
  records: BotLotteryRecord[]
}

export interface BotLotteryGrantRequest {
  user_id?: number
  target?: 'all'
  count: number
  notes?: string
  request_id: string
}

export interface BotLotteryGrantBatchItem {
  user_id: number
  status: 'pending' | 'success' | 'failed' | 'skipped' | string
  error?: string
}

export interface BotLotteryGrantBatch {
  status: 'pending' | 'completed' | string
  batch_id: number
  count: number
  total: number
  success: number
  skipped: number
  failed: number
  pending: number
  replayed?: boolean
  created_at?: string
  items?: BotLotteryGrantBatchItem[]
}

export interface BotLotteryUserGrantResult {
  status: string
  user_id: number
  count: number
  remaining: number
  replayed: boolean
}

export const botLotteryAdminAPI = {
  getConfig() {
    return apiClient.get<BotLotteryConfig>('/admin/bot-lottery/config').then(response => response.data)
  },

  updateConfig(config: BotLotteryConfig) {
    return apiClient.put<BotLotteryConfig>('/admin/bot-lottery/config', config).then(response => response.data)
  },

  getUserHistory(userId: number) {
    return apiClient.get<BotLotteryUserHistory>(`/admin/users/${userId}/lottery`).then(response => response.data)
  },

  grant(request: BotLotteryGrantRequest) {
    return apiClient.post<BotLotteryUserGrantResult | BotLotteryGrantBatch>(
      '/admin/bot-lottery/grants',
      request
    ).then(response => response.data)
  },

  getGrantBatch(batchId: number) {
    return apiClient.get<BotLotteryGrantBatch>(`/admin/bot-lottery/grant-batches/${batchId}`).then(response => response.data)
  }
}

export default botLotteryAdminAPI
