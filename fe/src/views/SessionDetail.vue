<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, describeApiError, type PptItem, type SessionDetail, type SubtitleInfo } from '../api'

const route = useRoute()
const router = useRouter()

const courseId = Number(route.params.courseId)
const subId = Number(route.params.subId)
const courseTitle = (history.state?.courseTitle as string) || `课程 ${courseId}`
const stateSessionTitle = (history.state?.sessionTitle as string) || ''

const session = ref<SessionDetail | null>(null)
const sessionError = ref('')
const loading = ref(true)

const ppts = ref<PptItem[]>([])
const pptLoading = ref(true)
const pptError = ref('')

const subtitle = ref<SubtitleInfo | null>(null)
const subtitleLoading = ref(true)
const subtitleError = ref('')

// 回放视频体积大，点击后才创建 video 元素发起请求
const videoLoaded = ref(false)

const sessionTitle = computed(() => session.value?.title || stateSessionTitle || '课时详情')
const playbackUrl = computed(() => session.value?.playbackUrl || null)

const formatTime = (sec: number) =>
  sec > 0 ? new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false }) : '未知'

const mmss = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function enterTask() {
  router.push({
    path: `/courses/${courseId}/sessions/${subId}/task`,
    state: { courseTitle, sessionTitle: sessionTitle.value },
  })
}

onMounted(() => {
  api
    .getSession(courseId, subId)
    .then((res) => (session.value = res))
    .catch((e) => (sessionError.value = describeApiError(e, '加载课时信息失败')))
    .finally(() => (loading.value = false))

  api
    .getSessionPpt(courseId, subId)
    .then((res) => (ppts.value = res.items))
    .catch((e) => (pptError.value = describeApiError(e, '加载 PPT 列表失败')))
    .finally(() => (pptLoading.value = false))

  api
    .getSessionSubtitle(courseId, subId)
    .then((res) => (subtitle.value = res))
    .catch((e) => (subtitleError.value = describeApiError(e, '加载官方字幕信息失败')))
    .finally(() => (subtitleLoading.value = false))
})
</script>

<template>
  <section>
    <div class="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h1 class="text-2xl font-bold tracking-tight text-gray-900">{{ sessionTitle }}</h1>
        <p class="mt-1 text-sm text-gray-500">
          {{ courseTitle }} · 课时编号 {{ subId
          }}<template v-if="session"> · {{ formatTime(session.startAt) }}</template>
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <RouterLink
          :to="{ path: `/courses/${courseId}`, state: { courseTitle } }"
          class="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition hover:bg-gray-50"
        >
          ← 返回课节列表
        </RouterLink>
        <button
          class="rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="loading || !playbackUrl"
          :title="!loading && !playbackUrl ? '该课节没有回放视频，无法生成逐字稿' : ''"
          @click="enterTask"
        >
          进入任务 →
        </button>
      </div>
    </div>

    <p v-if="loading" class="py-20 text-center text-gray-400">加载中…</p>

    <p
      v-else-if="sessionError"
      class="rounded-2xl border border-red-100 bg-red-50 py-10 text-center text-sm text-red-600"
    >
      {{ sessionError }}
    </p>

    <template v-else>
      <div class="grid gap-4 sm:grid-cols-2">
        <!-- 回放视频 -->
        <div class="rounded-2xl border border-gray-200 bg-white p-5">
          <p class="text-sm font-medium text-gray-700">回放视频</p>
          <template v-if="playbackUrl">
            <div v-if="videoLoaded" class="mt-3">
              <video
                :src="playbackUrl"
                controls
                autoplay
                class="aspect-video w-full rounded-lg bg-black"
              />
            </div>
            <div
              v-else
              class="mt-3 flex aspect-video w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 text-center"
            >
              <p class="text-sm text-gray-500">视频文件较大，点击后才加载</p>
              <button
                class="mt-3 rounded-lg bg-indigo-500 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-600"
                @click="videoLoaded = true"
              >
                加载回放视频
              </button>
            </div>
            <a
              :href="playbackUrl"
              target="_blank"
              rel="noopener"
              class="mt-2 inline-block text-xs text-indigo-600 hover:underline"
            >
              在新窗口打开 ↗
            </a>
          </template>
          <p v-else class="mt-3 py-8 text-center text-sm text-gray-400">该课节暂无回放视频</p>
        </div>

        <!-- 官方生成字数 -->
        <div class="rounded-2xl border border-gray-200 bg-white p-5">
          <p class="text-sm font-medium text-gray-700">官方生成字数</p>
          <p v-if="subtitleLoading" class="mt-3 py-8 text-center text-sm text-gray-400">
            加载中…
          </p>
          <p v-else-if="subtitleError" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
            {{ subtitleError }}
          </p>
          <template v-else-if="subtitle">
            <p class="mt-2 text-4xl font-bold tracking-tight text-gray-900">
              {{ subtitle.charCount.toLocaleString('zh-CN') }}
              <span class="text-lg font-medium text-gray-400">字</span>
            </p>
            <p class="mt-1 text-xs text-gray-400">智云课堂官方字幕 · 共 {{ subtitle.total }} 条</p>
          </template>
        </div>
      </div>

      <!-- PPT 列表 -->
      <div class="mt-4 rounded-2xl border border-gray-200 bg-white p-5">
        <div class="flex items-center justify-between">
          <p class="text-sm font-medium text-gray-700">PPT 列表</p>
          <span v-if="!pptLoading && !pptError" class="text-xs text-gray-400">共 {{ ppts.length }} 张</span>
        </div>

        <p v-if="pptLoading" class="py-10 text-center text-sm text-gray-400">加载中…</p>
        <p v-else-if="pptError" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
          {{ pptError }}
        </p>
        <div
          v-else-if="ppts.length"
          class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
        >
          <a
            v-for="(p, i) in ppts"
            :key="i"
            :href="p.url"
            target="_blank"
            rel="noopener"
            class="group block overflow-hidden rounded-lg border border-gray-200 bg-gray-50 transition hover:border-indigo-300"
          >
            <img
              :src="p.url"
              loading="lazy"
              alt="PPT"
              class="aspect-video w-full object-cover transition group-hover:opacity-90"
            />
            <p class="flex items-center justify-between px-2 py-1 text-xs text-gray-400">
              <span>第 {{ i + 1 }} 张</span>
              <span>{{ mmss(p.sec) }}</span>
            </p>
          </a>
        </div>
        <p v-else class="py-10 text-center text-sm text-gray-400">该课节暂无 PPT 记录</p>
      </div>
    </template>
  </section>
</template>
