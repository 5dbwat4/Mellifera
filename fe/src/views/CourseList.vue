<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, describeApiError, type Course } from '../api'

const router = useRouter()

const PAGE_SIZE = 9

const courses = ref<Course[]>([])
const total = ref(0)
const page = ref(1)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const loading = ref(false)
const error = ref('')

async function loadPage(p: number) {
  loading.value = true
  error.value = ''
  try {
    const res = await api.listCourses(p, PAGE_SIZE)
    courses.value = res.items
    total.value = res.total
    page.value = res.page
  } catch (e) {
    error.value = describeApiError(e, '加载课程失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => loadPage(1))

// 课程编号跳转：任意智云课堂课程，不限于自己的
const jumpId = ref('')
const jumpError = ref('')

function jump() {
  const num = Number(jumpId.value.trim())
  if (!Number.isInteger(num) || num <= 0) {
    jumpError.value = '请输入正整数课程编号'
    return
  }
  jumpError.value = ''
  router.push(`/courses/${num}`)
}
</script>

<template>
  <section>
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-gray-900">课程列表</h1>
        <p class="mt-1 text-sm text-gray-500">我的智云课堂课程，共 {{ total }} 门。也可以直接输入课程编号进入。</p>
      </div>
      <form class="flex items-center gap-2" @submit.prevent="jump">
        <input
          v-model="jumpId"
          placeholder="输入课程编号"
          aria-label="课程编号"
          class="w-40 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        />
        <button
          type="submit"
          class="rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-600"
        >
          跳转
        </button>
        <span v-if="jumpError" class="text-xs text-red-500">{{ jumpError }}</span>
      </form>
    </div>

    <p v-if="loading" class="py-20 text-center text-gray-400">加载中…</p>

    <p
      v-else-if="error"
      class="rounded-2xl border border-amber-100 bg-amber-50 py-10 text-center text-sm text-amber-700"
    >
      {{ error }}
    </p>

    <div v-else-if="courses.length" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <RouterLink
        v-for="course in courses"
        :key="course.courseId"
        :to="{ path: `/courses/${course.courseId}`, state: { courseTitle: course.title } }"
        class="group overflow-hidden rounded-2xl border border-gray-200 bg-white transition hover:-translate-y-0.5 hover:shadow-md"
      >
        <div class="aspect-video bg-gray-100">
          <img
            v-if="course.cover"
            :src="course.cover"
            :alt="course.title"
            class="h-full w-full object-cover"
            referrerpolicy="no-referrer"
            @error="($event.target as HTMLImageElement).style.display = 'none'"
          />
        </div>
        <div class="p-4">
          <h2
            class="truncate font-semibold text-gray-900 group-hover:text-indigo-600"
            :title="course.title"
          >
            {{ course.title }}
          </h2>
          <p class="mt-1 truncate text-sm text-gray-500">
            {{ course.teacher }}<span v-if="course.term"> · {{ course.term }}</span>
          </p>
        </div>
      </RouterLink>
    </div>

    <div
      v-else
      class="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-300 bg-white py-20 text-center"
    >
      <p class="font-medium text-gray-700">没有查到课程</p>
      <p class="mt-1 text-sm text-gray-400">你的智云课堂账号下暂无课程记录，或可通过上方输入框直接输入课程编号。</p>
    </div>

    <!-- 分页 -->
    <div
      v-if="!loading && !error && total > 0"
      class="mt-6 flex items-center justify-center gap-4"
    >
      <button
        class="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="page <= 1"
        @click="loadPage(page - 1)"
      >
        上一页
      </button>
      <span class="text-sm text-gray-500">第 {{ page }} / {{ totalPages }} 页</span>
      <button
        class="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="page >= totalPages"
        @click="loadPage(page + 1)"
      >
        下一页
      </button>
    </div>
  </section>
</template>
