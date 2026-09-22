<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api, describeApiError, taskEventsUrl, type Task } from '../api'
import { stepText as formatStep } from '../taskSteps'

const route = useRoute()

const courseId = Number(route.params.courseId)
const subId = Number(route.params.subId)
const courseTitle = (history.state?.courseTitle as string) || `课程 ${courseId}`
const sessionTitle = (history.state?.sessionTitle as string) || ''

const job = ref<Task | null>(null)
const error = ref('')
// SSE 断线中：EventSource 自动重连，连上后清除；不做快照兜底
const connectionLost = ref(false)
let es: EventSource | null = null

const running = computed(() => job.value?.status === 'queued' || job.value?.status === 'running')

const stepText = computed(() => {
  if (!job.value) return ''
  return formatStep(job.value.stepId, job.value.progress)
})

const percent = computed(() => {
  const p = job.value?.progress
  if (!p || !p.total) return null
  return Math.min(100, Math.round((p.done / p.total) * 100))
})

// 极简 Markdown 渲染：##/### 标题、- 列表、其余按段落
const mdLines = computed(() => (job.value?.result?.markdown || '').split('\n'))

function closeSse() {
  if (es) {
    es.close()
    es = null
  }
}

// 订阅任务的 SSE 事件流：连上即收当前状态，此后每次变化推一条，
// 任务进入终态后服务端会主动关闭流。断线时 EventSource 自动重连，
// 重连后服务端会先推一次当前状态，等于自动续上。
function listen() {
  closeSse()
  es = new EventSource(taskEventsUrl(job.value!.taskId))
  es.onopen = () => {
    connectionLost.value = false
  }
  es.onmessage = (ev) => {
    try {
      job.value = JSON.parse(ev.data) as Task
    } catch {
      return
    }
    if (job.value.status === 'done' || job.value.status === 'error') closeSse()
  }
  es.onerror = () => {
    connectionLost.value = true
  }
}

async function start(force = false) {
  error.value = ''
  closeSse()
  try {
    job.value = await api.createTask(subId, courseId, force)
    if (running.value) listen()
  } catch (e) {
    error.value = describeApiError(e, '创建逐字稿任务失败')
  }
}

async function pause() {
  if (!job.value) return
  try {
    job.value = await api.pauseTask(job.value.taskId)
  } catch (e) {
    error.value = describeApiError(e, '暂停任务失败')
  }
}

async function resume() {
  error.value = ''
  try {
    job.value = await api.resumeTask(job.value!.taskId)
    if (running.value) listen()
  } catch (e) {
    error.value = describeApiError(e, '恢复任务失败')
  }
}

// ---------- 过程数据（懒加载，展开时才请求） ----------
type ArtifactState = { loading: boolean; error: string; content: string | null }
const ARTIFACT_LIST = [
  { name: 'asr_raw', label: 'ASR 原始分段（asr_all.jsonl）' },
  { name: 'blocks', label: 'ASR 文本块（滤碎合并+标点后）' },
  { name: 'classroom', label: 'classroom 课节目录原始响应' },
]
const artifacts = ref<Record<string, ArtifactState>>({})
const openArtifact = ref<string | null>(null)

const mmss2 = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// blocks 渲染成可读的时间戳行，classroom 原始 JSON 格式化缩进，asr_raw 保持原样
function fmtArtifact(name: string, content: string): string {
  if (name === 'blocks') {
    try {
      return (JSON.parse(content) as { start: number; end: number; text: string }[])
        .map((b) => `[${mmss2(b.start)} - ${mmss2(b.end)}] ${b.text}`)
        .join('\n')
    } catch {
      return content
    }
  }
  if (name === 'classroom') {
    try {
      return JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      return content
    }
  }
  return content
}

async function toggleArtifact(name: string) {
  if (openArtifact.value === name) {
    openArtifact.value = null
    return
  }
  openArtifact.value = name
  const st = artifacts.value[name]
  if (st && (st.content !== null || st.loading)) return
  artifacts.value[name] = { loading: true, error: '', content: null }
  try {
    const a = await api.getTaskArtifact(job.value!.taskId, name)
    artifacts.value[name] = { loading: false, error: '', content: fmtArtifact(name, a.content) }
  } catch (e) {
    artifacts.value[name] = { loading: false, error: describeApiError(e, '加载失败'), content: null }
  }
}

start()

onUnmounted(closeSse)
</script>

<template>
  <section>
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-gray-900">
          {{ sessionTitle || '课时逐字稿' }}
        </h1>
        <p class="mt-1 text-sm text-gray-500">{{ courseTitle }} · 课时编号 {{ subId }}</p>
      </div>
      <RouterLink
        :to="{ path: `/courses/${courseId}/sessions/${subId}`, state: { courseTitle, sessionTitle } }"
        class="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition hover:bg-gray-50"
      >
        ← 返回课时详情
      </RouterLink>
    </div>

    <p v-if="error" class="rounded-2xl border border-red-100 bg-red-50 py-10 text-center text-sm text-red-600">
      {{ error }}
    </p>

    <template v-else-if="job">
      <!-- 运行中 -->
      <div
        v-if="running"
        class="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-8 text-center"
      >
        <div
          class="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-indigo-200 border-t-indigo-600"
        />
        <p class="font-medium text-indigo-900">
          <span v-if="connectionLost" class="text-indigo-400">&lt;connection interrupted&gt;</span>
          <template v-else>{{ stepText }}</template>
        </p>
        <p class="mt-1 text-sm text-indigo-500">{{ job.detail }}</p>
        <div v-if="percent !== null" class="mx-auto mt-4 h-2 max-w-md overflow-hidden rounded-full bg-indigo-100">
          <div class="h-full rounded-full bg-indigo-500 transition-all" :style="{ width: percent + '%' }" />
        </div>
        <pre
          v-if="job.logs"
          class="mx-auto mt-4 max-h-44 w-full max-w-2xl overflow-auto whitespace-pre-wrap rounded-lg bg-white/80 p-3 text-left text-xs leading-relaxed text-gray-600"
          >{{ job.logs }}</pre
        >
        <p class="mt-4 text-xs text-indigo-400">
          整段流程约需 20 分钟（视频下载与逐段识别耗时最长），页面可停留等待，也可以稍后回来。
        </p>
        <button
          class="mt-3 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-gray-600 ring-1 ring-indigo-200 transition hover:bg-indigo-50"
          @click="pause"
        >
          暂停任务
        </button>
      </div>

      <!-- 已暂停（等待 sglang 或手动暂停） -->
      <div
        v-else-if="job.status === 'paused'"
        class="rounded-2xl border border-amber-100 bg-amber-50 p-8 text-center"
      >
        <p class="font-medium text-amber-900">任务已暂停</p>
        <p class="mt-1 text-sm text-amber-600">{{ job.detail }}</p>
        <pre
          v-if="job.logs"
          class="mx-auto mt-4 max-h-44 w-full max-w-2xl overflow-auto whitespace-pre-wrap rounded-lg bg-white/80 p-3 text-left text-xs leading-relaxed text-gray-600"
          >{{ job.logs }}</pre
        >
        <button
          class="mt-4 rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-amber-600"
          @click="resume"
        >
          继续
        </button>
      </div>

      <!-- 失败 -->
      <div v-else-if="job.status === 'error'" class="rounded-2xl border border-red-100 bg-red-50 p-6">
        <p class="font-medium text-red-700">逐字稿生成失败</p>
        <pre class="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-xs text-red-500">{{ job.error }}</pre>
        <button
          class="mt-4 rounded-lg bg-red-500 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-red-600"
          @click="start(true)"
        >
          重试
        </button>
      </div>

      <!-- 完成 -->
      <template v-else-if="job.result">
        <div class="mb-4 flex items-center gap-3 text-sm text-gray-500">
          <span class="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">完成</span>
          <span>{{ job.result.blocksCount }} 个语句块 · {{ job.result.pptCount }} 张 PPT 进入上下文</span>
          <button
            class="ml-auto rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-gray-700 ring-1 ring-gray-200 transition hover:bg-gray-50"
            @click="start(true)"
          >
            重新生成
          </button>
        </div>
        <article class="rounded-2xl border border-gray-200 bg-white p-8">
          <template v-for="(line, i) in mdLines" :key="i">
            <h2 v-if="line.startsWith('## ')" class="mt-6 mb-2 text-lg font-semibold text-gray-900 first:mt-0">
              {{ line.slice(3) }}
            </h2>
            <h3 v-else-if="line.startsWith('### ')" class="mt-4 mb-2 font-semibold text-gray-800">
              {{ line.slice(4) }}
            </h3>
            <p
              v-else-if="line.trim()"
              class="mb-2 whitespace-pre-wrap leading-relaxed text-gray-700"
            >
              {{ line }}
            </p>
          </template>
        </article>
      </template>

      <!-- 过程数据 -->
      <div class="mt-4 rounded-2xl border border-gray-200 bg-white">
        <p class="border-b border-gray-100 px-4 py-3 text-sm font-medium text-gray-700">过程数据</p>
        <div v-for="a in ARTIFACT_LIST" :key="a.name" class="border-b border-gray-100 last:border-0">
          <button
            class="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm text-gray-600 transition hover:bg-gray-50"
            @click="toggleArtifact(a.name)"
          >
            <span>{{ a.label }}</span>
            <span class="text-xs text-gray-400">{{ openArtifact === a.name ? '收起 ▲' : '展开 ▼' }}</span>
          </button>
          <div v-if="openArtifact === a.name" class="px-4 pb-3">
            <p v-if="artifacts[a.name]?.loading" class="py-4 text-center text-xs text-gray-400">加载中…</p>
            <p
              v-else-if="artifacts[a.name]?.error"
              class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600"
            >
              {{ artifacts[a.name].error }}
            </p>
            <pre
              v-else
              class="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-700"
              >{{ artifacts[a.name]?.content }}</pre
            >
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
