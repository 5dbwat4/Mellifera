<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api, describeApiError, type Task } from '../api'
import { stepText } from '../taskSteps'
import ClipboardListIcon from '../assets/icons/clipboard-list.svg?component'

const router = useRouter()

const tasks = ref<Task[]>([])
const loading = ref(false)
const error = ref('')
let timer: number | undefined

const hasActive = computed(() =>
  tasks.value.some(
    (t) => t.status === 'queued' || t.status === 'running' || t.status === 'paused'
  )
)

const notice = ref('')

async function load() {
  error.value = ''
  try {
    tasks.value = await api.listTasks()
  } catch (e) {
    error.value = describeApiError(e, '加载任务列表失败')
  }
}

async function refresh() {
  loading.value = true
  await load()
  loading.value = false
}

// 有进行中的任务时每 4 秒轮询，全部结束则停表
function syncPolling() {
  if (hasActive.value && timer === undefined) {
    timer = window.setInterval(load, 4000)
  } else if (!hasActive.value && timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}
watch(hasActive, syncPolling)

function open(t: Task) {
  if (!t.courseId) return
  router.push({
    path: `/courses/${t.courseId}/sessions/${t.subId}/task`,
    state: { courseTitle: `课程 ${t.courseId}`, sessionTitle: t.title },
  })
}

const fmtTime = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : ''

function statusBadge(t: Task) {
  switch (t.status) {
    case 'done':
      return { text: '已完成', class: 'bg-emerald-50 text-emerald-700' }
    case 'error':
      return { text: '失败', class: 'bg-red-50 text-red-600' }
    case 'running':
      return { text: '进行中', class: 'bg-indigo-50 text-indigo-600' }
    case 'paused':
      return { text: '已暂停', class: 'bg-amber-50 text-amber-700' }
    default:
      return { text: '排队中', class: 'bg-gray-100 text-gray-500' }
  }
}

function rowSubtitle(t: Task): string {
  if (t.status === 'error') return (t.error || '').split('\n')[0] || '任务失败'
  if (t.status === 'paused') return t.detail || '已暂停'
  if (t.status === 'done') return `完成于 ${fmtTime(t.finishedAt)}`
  const text = stepText(t.stepId, t.progress)
  return t.detail ? `${text} · ${t.detail}` : text
}

// 暂停/继续：用接口返回的任务快照原地替换，避免等下一轮轮询
async function toggle(t: Task) {
  notice.value = ''
  try {
    const updated = t.status === 'paused' ? await api.resumeTask(t.taskId) : await api.pauseTask(t.taskId)
    tasks.value = tasks.value.map((x) => (x.taskId === updated.taskId ? updated : x))
  } catch (e) {
    notice.value = describeApiError(e, '操作失败')
  }
}

function percent(t: Task): number | null {
  const p = t.progress
  if (!p || !p.total) return null
  return Math.min(100, Math.round((p.done / p.total) * 100))
}

onMounted(async () => {
  await load()
  syncPolling()
})
onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer)
})
</script>

<template>
  <section>
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-gray-900">我的任务</h1>
        <p class="mt-1 text-sm text-gray-500">逐字稿生成任务与实时状态。</p>
      </div>
      <button
        class="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition hover:bg-gray-50 disabled:opacity-50"
        :disabled="loading"
        @click="refresh"
      >
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <p v-if="notice" class="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{{ notice }}</p>

    <p v-if="!tasks.length && !error" class="py-20 text-center text-gray-400">加载中…</p>

    <p
      v-else-if="error && !tasks.length"
      class="rounded-2xl border border-red-100 bg-red-50 py-10 text-center text-sm text-red-600"
    >
      {{ error }}
    </p>

    <ul v-else-if="tasks.length" class="flex flex-col gap-2">
      <li
        v-for="t in tasks"
        :key="t.taskId"
        class="flex cursor-pointer flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 transition hover:bg-gray-50"
        @click="open(t)"
      >
        <div class="min-w-0 flex-1">
          <p class="truncate font-medium text-gray-900">{{ t.title }}</p>
          <p class="mt-0.5 text-xs text-gray-400">
            课程 {{ t.courseId ?? '—' }} · 课节 {{ t.subId }} · 创建于 {{ fmtTime(t.createdAt) }}
          </p>
          <p
            class="mt-0.5 truncate text-xs"
            :class="t.status === 'error' ? 'text-red-500' : 'text-gray-500'"
          >
            {{ rowSubtitle(t) }}
          </p>
          <div
            v-if="t.status === 'running' && percent(t) !== null"
            class="mt-2 h-1 w-full max-w-xs rounded-full bg-gray-100"
          >
            <div
              class="h-1 rounded-full bg-indigo-500 transition-all"
              :style="{ width: percent(t) + '%' }"
            />
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <span
            class="rounded-full px-2.5 py-0.5 text-xs font-medium"
            :class="statusBadge(t).class"
          >
            {{ statusBadge(t).text }}
          </span>
          <button
            v-if="t.status === 'paused'"
            class="rounded-lg px-3 py-1 text-xs font-medium text-emerald-600 ring-1 ring-emerald-200 transition hover:bg-emerald-50"
            @click.stop="toggle(t)"
          >
            继续
          </button>
          <button
            v-else-if="t.status === 'running' || t.status === 'queued'"
            class="rounded-lg px-3 py-1 text-xs font-medium text-gray-600 ring-1 ring-gray-200 transition hover:bg-gray-50"
            @click.stop="toggle(t)"
          >
            暂停
          </button>
        </div>
      </li>
    </ul>

    <div
      v-else
      class="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-300 bg-white py-20 text-center"
    >
      <ClipboardListIcon class="h-12 w-12 text-gray-300" />
      <p class="mt-4 font-medium text-gray-700">还没有任务</p>
      <p class="mt-1 text-sm text-gray-400">去课程列表选择课节，点「生成逐字稿」创建任务。</p>
    </div>
  </section>
</template>
