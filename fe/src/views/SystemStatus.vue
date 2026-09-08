<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api'

const online = ref<boolean | null>(null)
const checking = ref(false)

async function check() {
  checking.value = true
  try {
    online.value = (await api.health()).status === 'ok'
  } catch {
    online.value = false
  } finally {
    checking.value = false
  }
}

onMounted(check)
</script>

<template>
  <section>
    <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-gray-900">系统情况</h1>
        <p class="mt-1 text-sm text-gray-500">后端服务连接状态与基础信息。</p>
      </div>
      <button
        class="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 transition hover:bg-gray-50 disabled:opacity-50"
        :disabled="checking"
        @click="check"
      >
        {{ checking ? '检测中…' : '重新检测' }}
      </button>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <div class="rounded-2xl border border-gray-200 bg-white p-5">
        <p class="text-sm text-gray-500">后端服务（127.0.0.1:9000）</p>
        <p class="mt-3 flex items-center gap-2 font-semibold text-gray-900">
          <span
            class="h-2.5 w-2.5 rounded-full"
            :class="online === null ? 'bg-gray-300' : online ? 'bg-emerald-500' : 'bg-red-500'"
          />
          <template v-if="online === null">检测中…</template>
          <template v-else-if="online">运行中，/api/health 响应正常</template>
          <template v-else>无法连接，请确认后端已启动</template>
        </p>
      </div>

      <div class="rounded-2xl border border-gray-200 bg-white p-5">
        <p class="text-sm text-gray-500">服务信息</p>
        <p class="mt-3 font-semibold text-gray-900">Node.js + Express</p>
        <p class="mt-1 text-sm text-gray-500">接口统一前缀 /api，数据返回 JSON</p>
      </div>
    </div>
  </section>
</template>
