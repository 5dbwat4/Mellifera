import { Router } from 'express'

const router = Router()

// 内存存储，进程重启即清空；接入数据库后替换
const items = new Map()
let nextId = 1

router.get('/', (req, res) => {
  res.json([...items.values()])
})

router.post('/', (req, res) => {
  const { name, description = '' } = req.body ?? {}
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    res.status(400).json({ detail: 'name 必须为 1-100 个字符的字符串' })
    return
  }
  const item = { id: nextId++, name: name.trim(), description: String(description) }
  items.set(item.id, item)
  res.status(201).json(item)
})

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || !items.has(id)) {
    res.status(404).json({ detail: 'Item not found' })
    return
  }
  items.delete(id)
  res.status(204).end()
})

export default router
