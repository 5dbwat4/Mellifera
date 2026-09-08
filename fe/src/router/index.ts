import { createRouter, createWebHistory } from 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    title?: string
  }
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/courses' },
    {
      path: '/courses',
      name: 'courses',
      component: () => import('../views/CourseList.vue'),
      meta: { title: '课程列表' },
    },
    {
      path: '/courses/:courseId',
      name: 'course-sessions',
      component: () => import('../views/CourseSessions.vue'),
      meta: { title: '课节列表' },
    },
    {
      path: '/courses/:courseId/sessions/:subId',
      name: 'session-transcript',
      component: () => import('../views/TranscriptView.vue'),
      meta: { title: '逐字稿' },
    },
    {
      path: '/tasks',
      name: 'tasks',
      component: () => import('../views/MyTasks.vue'),
      meta: { title: '我的任务' },
    },
    {
      path: '/system',
      name: 'system',
      component: () => import('../views/SystemStatus.vue'),
      meta: { title: '系统情况' },
    },
  ],
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · Mellifera` : 'Mellifera'
})

export default router
