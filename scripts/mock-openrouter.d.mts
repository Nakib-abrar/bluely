export interface MockRequestRecord {
  method: string
  path: string
  query: Record<string, string>
  headers: { referer: string | null; title: string | null; authorization: string | null }
  body: unknown
  at: number
}

export interface MockOpenRouter {
  baseUrl: string
  port: number
  requests: MockRequestRecord[]
  close(): Promise<void>
}

export function startMockOpenRouter(opts?: {
  port?: number
  host?: string
  ttftMs?: number
  tokenMs?: number
  sttMs?: number
  quiet?: boolean
}): Promise<MockOpenRouter>
