import { Router } from 'express'

import { createTask, getTask, listTasks, subscribe, unsubscribe } from '../services/transcript.js'

const router = Router()

// 创建/复用逐字稿任务：只带 subId（courseId 可选，缓存未命中时用于补拉课节）；
// 同一课时幂等；force=true 强制新开任务。返回任务 JSON，其中 SSE 流地址固定为
// /api/tasks/{taskId}/events
router.post('/', async (req, res, next) => {
  try {
    const subId = Number(req.body?.subId)
    if (!Number.isInteger(subId) || subId <= 0) {
      res.status(400).json({ detail: 'subId 必须为正整数' })
      return
    }
    const courseNum = Number(req.body?.courseId)
    const courseId = Number.isInteger(courseNum) && courseNum > 0 ? courseNum : null
    const task = await createTask({ subId, courseId, force: req.body?.force === true })
    res.status(201).json(task)
  } catch (e) {
    next(e)
  }
})

// 任务列表（最近的在前，最多 200 条，不含逐字稿正文）
router.get('/', (req, res) => {
  res.json(listTasks())
})

// 任务快照（SSE 的非流式兜底）
router.get('/:taskId', (req, res) => {
  const task = getTask(req.params.taskId)
  if (!task) {
    res.status(404).json({ detail: '任务不存在' })
    return
  }
  res.json(task)
})

// SSE 实时事件流：连上先推当前状态，之后每次状态变化推一条；
// 任务进入 done/error 后推送终态并关闭流
router.get('/:taskId/events', (req, res) => {
  const task = getTask(req.params.taskId)
  if (!task) {
    res.status(404).json({ detail: '任务不存在' })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  let closed = false
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n')
  }, 20000)

  const send = (snapshot) => {
    if (closed) return
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
    if (snapshot.status === 'done' || snapshot.status === 'error') {
      closed = true
      clearInterval(heartbeat)
      unsubscribe(task.taskId, send)
      res.end()
    }
  }
  subscribe(task.taskId, send)
  send(task)

  req.on('close', () => {
    closed = true
    clearInterval(heartbeat)
    unsubscribe(task.taskId, send)
  })
})

export default router
