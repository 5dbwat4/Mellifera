<script setup lang="ts">
import BeeIcon from '../assets/icons/bee.svg?component'

const navItems = [
  { to: '/courses', label: '课程列表' },
  { to: '/tasks', label: '我的任务' },
  { to: '/system', label: '系统情况' },
]
</script>

<template>
  <header class="sticky top-0 z-10 border-b border-gray-200 bg-white/90 backdrop-blur">
    <div class="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
      <RouterLink to="/" class="flex shrink-0 items-center gap-2">
        <span
          class="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-400 shadow-sm"
        >
          <BeeIcon class="h-5 w-5 text-white" />
        </span>
        <span class="text-lg font-semibold tracking-tight text-gray-900">Mellifera</span>
      </RouterLink>

      <nav class="flex items-center gap-1">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
          active-class="bg-indigo-50 !text-indigo-700 hover:bg-indigo-50 hover:text-indigo-700"
        >
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="ml-auto flex items-center">
        <span
          class="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700"
          title="当前用户"
        >
          M
        </span>
      </div>
    </div>
  </header>
</template>
