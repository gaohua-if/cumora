import { AsyncLocalStorage } from 'node:async_hooks'

export interface ThreadScope { threadId: string; round: number; agentId: string; companyId: string }
export const threadScope = new AsyncLocalStorage<ThreadScope>()
