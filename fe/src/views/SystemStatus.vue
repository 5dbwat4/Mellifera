<script setup lang="ts">
import BeeIcon from '../assets/icons/bee.svg?component'
</script>

<template>
  <section>
    <div class="mb-6">
      <h1 class="text-2xl font-bold tracking-tight text-gray-900">系统情况</h1>
      <p class="mt-1 text-sm text-gray-500">查看系统运行状态与基础信息。</p>
    </div>

    <div
      class="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-300 bg-white py-20 text-center"
    >
      <BeeIcon class="h-12 w-12 text-gray-300" />
      <p class="mt-4 font-medium text-gray-700">系统监控建设中</p>
      <p class="mt-1 text-sm text-gray-400">后端状态与系统信息就绪后，将展示在这里。</p>
    </div>
  </section>
</template>
