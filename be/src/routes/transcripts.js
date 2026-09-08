import { Router } from 'express'

import { createTranscriptJob, getTranscriptJob } from '../services/transcript.js'

const router = Router()

// 创建/获取逐字稿任务（同一课时幂等；force=true 强制重跑）
router.post('/', (req, res) => {
  const courseId = Number(req.body?.courseId)
  const subId = Number(req.body?.subId)
  if (!Number.isInteger(courseId) || courseId <= 0 || !Number.isInteger(subId) || subId <= 0) {
    res.status(400).json({ detail: 'courseId 和 subId 必须为正整数' })
    return
  }
  const job = createTranscriptJob(courseId, subId, req.body?.force === true)
  res.status(201).json(job)
})

router.get('/:jobId', (req, res) => {
  const job = getTranscriptJob(req.params.jobId)
  if (!job) {
    res.status(404).json({ detail: '任务不存在' })
    return
  }
  res.json(job)
})

export default router
