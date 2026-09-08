import cors from 'cors'
import express from 'express'

import { config } from './config.js'
import coursesRouter from './routes/courses.js'
import healthRouter from './routes/health.js'
import itemsRouter from './routes/items.js'
import tasksRouter from './routes/tasks.js'

export function createApp() {
  const app = express()

  app.use(cors({ origin: config.corsOrigins, credentials: true }))
  app.use(express.json())

  app.use('/api/health', healthRouter)
  app.use('/api/items', itemsRouter)
  app.use('/api/courses', coursesRouter)
  app.use('/api/tasks', tasksRouter)

  app.use((req, res) => {
    res.status(404).json({ detail: `Not Found: ${req.method} ${req.originalUrl}` })
  })

  app.use((err, req, res, next) => {
    console.error(err)
    if (res.headersSent) {
      next(err)
      return
    }
    res.status(err.status || 500).json({ detail: err.message || 'Internal Server Error' })
  })

  return app
}
