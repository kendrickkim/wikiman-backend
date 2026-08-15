import express from 'express'
import cors from 'cors'
import { optionalAuth } from './middleware/auth.js'
import { isMaintenance } from './maintenance.js'
import authRoutes from './routes/auth.js'
import categoryRoutes from './routes/categories.js'
import postRoutes from './routes/posts.js'
import quickPostRoutes from './routes/quickPosts.js'
import uploadRoutes from './routes/uploads.js'
import fileRoutes from './routes/files.js'
import plantumlRoutes from './routes/plantuml.js'
import settingsRoutes from './routes/settings.js'
import backupRoutes from './routes/backup.js'
import linkPreviewRoutes from './routes/linkPreview.js'

export function createApp() {
  const app = express()

  app.use(cors())
  app.use(express.json({ limit: '4mb' }))

  app.use((req, res, next) => {
    if (
      isMaintenance()
      && req.path.startsWith('/api')
      && !req.path.startsWith('/api/backup')
      && req.path !== '/api/health'
    ) {
      return res.status(503).json({ error: '지금은 데이터를 복구하는 중입니다.' })
    }
    next()
  })

  app.use('/api', optionalAuth)
  app.use('/api/auth', authRoutes)
  app.use('/api/categories', categoryRoutes)
  app.use('/api/posts', postRoutes)
  app.use('/api/quick-posts', quickPostRoutes)
  app.use('/api/uploads', uploadRoutes)
  app.use('/api/files', fileRoutes)
  app.use('/api/plantuml', plantumlRoutes)
  app.use('/api/link-preview', linkPreviewRoutes)
  app.use('/api/settings', settingsRoutes)
  app.use('/api/backup', backupRoutes)

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API를 찾을 수 없습니다.' })
  })

  app.use((err, _req, res, _next) => {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  })

  return app
}
