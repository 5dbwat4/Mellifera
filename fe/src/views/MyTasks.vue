<script setup lang="ts">
import ClipboardListIcon from '../assets/icons/clipboard-list.svg?component'
</script>

<template>
  <section>
    <div class="mb-6">
      <h1 class="text-2xl font-bold tracking-tight text-gray-900">我的任务</h1>
      <p class="mt-1 text-sm text-gray-500">查看待办任务与学习进度。</p>
    </div>

    <div
      class="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-300 bg-white py-20 text-center"
    >
      <ClipboardListIcon class="h-12 w-12 text-gray-300" />
      <p class="mt-4 font-medium text-gray-700">任务功能建设中</p>
      <p class="mt-1 text-sm text-gray-400">任务数据接口就绪后，任务列表将展示在这里。</p>
    </div>
  </section>
</template>
