import { Router } from 'express'

import { fetchCourseSessions, fetchCourses } from '../services/classroom.js'

const router = Router()

// 分页查询"我的课程"（课程列表选择用）
router.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10))
  res.json(await fetchCourses({ page, pageSize }))
})

// 课节列表：任意智云课堂 courseId（手输跳转用）
router.get('/:courseId/sessions', async (req, res) => {
  const id = Number(req.params.courseId)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ detail: 'courseId 必须为正整数' })
    return
  }
  res.json(await fetchCourseSessions(id))
})

export default router
