import { Router } from 'express'

import {
  fetchCourseSessions,
  fetchCourses,
  fetchSession,
  fetchSessionPpt,
  fetchSessionSubtitle,
} from '../services/classroom.js'

const router = Router()

function parseIds(req) {
  const courseId = Number(req.params.courseId)
  const subId = Number(req.params.subId)
  if (!Number.isInteger(courseId) || courseId <= 0) {
    return { error: 'courseId 必须为正整数' }
  }
  if (!Number.isInteger(subId) || subId <= 0) {
    return { error: 'subId 必须为正整数' }
  }
  return { courseId, subId }
}

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

// 单个课节详情（详情页头部：标题、开课时间、回放地址）
router.get('/:courseId/sessions/:subId', async (req, res) => {
  const ids = parseIds(req)
  if (ids.error) {
    res.status(400).json({ detail: ids.error })
    return
  }
  res.json(await fetchSession(ids.courseId, ids.subId))
})

// 课节 PPT 截图列表（按出现时间升序）
router.get('/:courseId/sessions/:subId/ppt', async (req, res) => {
  const ids = parseIds(req)
  if (ids.error) {
    res.status(400).json({ detail: ids.error })
    return
  }
  const items = await fetchSessionPpt(ids.courseId, ids.subId)
  res.json({ courseId: ids.courseId, subId: ids.subId, total: items.length, items })
})

// 课节官方字幕规模（条数 + 归一化字数）
router.get('/:courseId/sessions/:subId/subtitle', async (req, res) => {
  const ids = parseIds(req)
  if (ids.error) {
    res.status(400).json({ detail: ids.error })
    return
  }
  res.json(await fetchSessionSubtitle(ids.subId))
})

export default router
