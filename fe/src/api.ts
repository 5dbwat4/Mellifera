export interface Item {
  id: number
  name: string
  description: string
}

export interface Course {
  courseId: number
  title: string
  teacher: string
  term: string
  college: string
  cover: string
}

export interface CourseSession {
  subId: number
  title: string
  /** Unix 秒 */
  startAt: number
  status: string
  playbackUrl: string | null
}

export interface TranscriptJob {
  jobId: string
  courseId: number
  subId: number
  title: string
  status: 'queued' | 'running' | 'done' | 'error'
  step: string
  progress: { done: number; total: number } | null
  detail: string
  error: string | null
  createdAt: number
  finishedAt: number | null
  result: { markdown: string; blocksCount: number; pptCount: number } | null
}

export interface Paged<T> {
  total: number
  page: number
  pageSize: number
  items: T[]
}

/** 后端不可达时 status 为 0；其余为 HTTP 状态码，detail 为后端返回的错误说明 */
export class ApiError extends Error {
  status: number
  detail?: string

  constructor(status: number, detail?: string) {
    super(detail || `HTTP ${status}`)
    this.status = status
    this.detail = detail
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${import.meta.env.BASE_URL}api${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch {
    throw new ApiError(0, '无法连接后端服务')
  }
  if (!res.ok) {
    let detail: string | undefined
    try {
      detail = ((await res.json()) as { detail?: string }).detail
    } catch {
      // 非 JSON 响应体，忽略
    }
    throw new ApiError(res.status, detail)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  health: () => request<{ status: string }>('/health'),
  listItems: () => request<Item[]>('/items'),
  createItem: (name: string, description: string) =>
    request<Item>('/items', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  deleteItem: (id: number) => request<void>(`/items/${id}`, { method: 'DELETE' }),
  listCourses: (page: number, pageSize: number) =>
    request<Paged<Course>>(`/courses?page=${page}&pageSize=${pageSize}`),
  getCourseSessions: (courseId: number) =>
    request<{ courseId: number; total: number; items: CourseSession[] }>(
      `/courses/${courseId}/sessions`
    ),
  createTranscript: (courseId: number, subId: number, force = false) =>
    request<TranscriptJob>('/transcripts', {
      method: 'POST',
      body: JSON.stringify({ courseId, subId, force }),
    }),
  getTranscript: (jobId: string) => request<TranscriptJob>(`/transcripts/${jobId}`),
}

/** 把 ApiError 翻译成用户能看懂的提示 */
export function describeApiError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return '无法连接后端服务，请确认后端已启动（127.0.0.1:9000）'
    return e.detail || fallback
  }
  return fallback
}
