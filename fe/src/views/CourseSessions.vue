<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, describeApiError, type CourseSession } from '../api'

const route = useRoute()
const router = useRouter()

const sessions = ref<CourseSession[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')

// 从列表页点卡片进来时带上课名，刷新/手输时退回显示编号
const courseTitle = history.state?.courseTitle as string | null

function openTranscript(s: CourseSession) {
  router.push({
    path: `/courses/${route.params.courseId}/sessions/${s.subId}`,
    state: { courseTitle: courseTitle || `课程 ${route.params.courseId}`, sessionTitle: s.title },
  })
}

const courseId = computed(() => {
  const num = Number(route.params.courseId)
  return Number.isInteger(num) && num > 0 ? num : null
})

const formatTime = (sec: number) =>
  sec > 0 ? new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false }) : '未知'

function statusLabel(s: CourseSession) {
  if (s.playbackUrl) return { text: '可回放', class: 'bg-emerald-50 text-emerald-700' }
  if (s.status === '6') return { text: '已结束', class: 'bg-gray-100 text-gray-500' }
  return { text: `状态 ${s.status}`, class: 'bg-indigo-50 text-indigo-600' }
}

async function load(id: number) {
  loading.value = true
  error.value = ''
  try {
    const res = await api.getCourseSessions(id)
    sessions.value = res.items
    total.value = res.total
  } catch (e) {
    error.value = describeApiError(e, `加载课程 ${id} 的课节失败`)
  } finally {
    loading.value = false
  }
}

watch(
  courseId,
  (id) => {
    if (id !== null) load(id)
  },
  { immediate: true }
)

onMounted(() => {
  if (courseId.value === null) error.value = '课程编号不合法'
})
</script>

<template>
  <section>
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-gray-900">
          {{ courseTitle || `课程 ${courseId}` }}
        </h1>
        <p class="mt-1 text-sm text-gray-500">
          共 {{ total }} 个课节<span v-if="courseTitle">（课程编号 {{ courseId }}）</span>
        </p>
      </div>
      <RouterLink
        to="/courses"
        class="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition hover:bg-gray-50"
      >
        ← 返回课程列表
      </RouterLink>
    </div>

    <p v-if="loading" class="py-20 text-center text-gray-400">加载中…</p>

    <p
      v-else-if="error"
      class="rounded-2xl border border-red-100 bg-red-50 py-10 text-center text-sm text-red-600"
    >
      {{ error }}
    </p>

    <ul v-else-if="sessions.length" class="flex flex-col gap-2">
      <li
        v-for="s in sessions"
        :key="s.subId"
        class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3"
      >
        <div class="min-w-0">
          <p class="truncate font-medium text-gray-900">{{ s.title }}</p>
          <p class="mt-0.5 text-xs text-gray-400">{{ formatTime(s.startAt) }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <span
            class="rounded-full px-2.5 py-0.5 text-xs font-medium"
            :class="statusLabel(s).class"
          >
            {{ statusLabel(s).text }}
          </span>
          <a
            v-if="s.playbackUrl"
            :href="s.playbackUrl"
            target="_blank"
            rel="noopener"
            class="rounded-lg px-3 py-1 text-xs font-medium text-indigo-600 ring-1 ring-indigo-200 transition hover:bg-indigo-50"
          >
            观看回放
          </a>
          <button
            v-if="s.playbackUrl"
            class="rounded-lg px-3 py-1 text-xs font-medium text-white transition hover:bg-emerald-600 bg-emerald-500"
            @click="openTranscript(s)"
          >
            生成逐字稿
          </button>
        </div>
      </li>
    </ul>

    <div
      v-else
      class="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-300 bg-white py-20 text-center"
    >
      <p class="font-medium text-gray-700">没有查到课节</p>
      <p class="mt-1 text-sm text-gray-400">该课程编号在智云课堂可能不存在，或没有任何课节记录。</p>
    </div>
  </section>
</template>
