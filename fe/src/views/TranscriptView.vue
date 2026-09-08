<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api, describeApiError, taskEventsUrl, type Task } from '../api'

const route = useRoute()

const courseId = Number(route.params.courseId)
const subId = Number(route.params.subId)
const courseTitle = (history.state?.courseTitle as string) || `课程 ${courseId}`
const sessionTitle = (history.state?.sessionTitle as string) || ''

const STEP_LABELS: Record<string, string> = {
  meta: '解析课时信息',
  download: '下载回放视频',
  audio: '抽取音频',
  asr: '语音识别（VAD 切段 + 逐段转写）',
  punc: '合并分句 + 标点恢复',
  ppt: '获取并筛选 PPT',
  llm: '大模型生成逐字稿',
  done: '完成',
}

const job = ref<Task | null>(null)
const error = ref('')
let es: EventSource | null = null

const running = computed(() => job.value?.status === 'queued' || job.value?.status === 'running')

const stepText = computed(() => {
  if (!job.value) return ''
  const label = STEP_LABELS[job.value.stepId] || job.value.stepId
  if (job.value.progress && job.value.progress.total > 0) {
    return `${label}：${job.value.progress.done} / ${job.value.progress.total}`
  }
  return label
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
// 任务进入终态后服务端会主动关闭流
function listen() {
  closeSse()
  es = new EventSource(taskEventsUrl(job.value!.taskId))
  let failures = 0
  es.onopen = () => {
    failures = 0
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
    // 后端重启/网络抖动时 EventSource 会自动重连；连续失败则拉快照兜底
    failures++
    if (failures >= 3) {
      closeSse()
      api
        .getTask(job.value!.taskId)
        .then((t) => {
          job.value = t
        })
        .catch(() => {
          error.value = '与任务的实时连接已中断，请刷新页面重试'
        })
    }
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
        :to="{ path: `/courses/${courseId}`, state: { courseTitle } }"
        class="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition hover:bg-gray-50"
      >
        ← 返回课节列表
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
        <p class="font-medium text-indigo-900">{{ stepText }}</p>
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
    </template>
  </section>
</template>
