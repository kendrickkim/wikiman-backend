import './loadEnv.js'
import { assertJwtSecret } from './jwt.js'

try {
  assertJwtSecret()
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const { createApp } = await import('./app.js')
const { mountFrontend, createHostApp } = await import('./static.js')

const apiPort = Number(process.env.API_PORT || process.env.PORT || 85)
const hostPort = Number(process.env.HOST_PORT || 80)

const app = createApp()

app.listen(apiPort, () => {
  console.log(`Wikiman API on http://localhost:${apiPort}`)
})

// 호스팅 포트: 정적 프론트 + /api 를 API 포트로 프록시
if (Number.isFinite(hostPort) && hostPort > 0 && hostPort !== apiPort) {
  const hostApp = createHostApp({ apiPort })
  const frontendDir = mountFrontend(hostApp)
  hostApp.listen(hostPort, () => {
    console.log(`Wikiman host on http://localhost:${hostPort}`)
    if (frontendDir) {
      console.log(`Frontend hosted from ${frontendDir}`)
    } else {
      console.log('Frontend build not found. Copy frontend dist/spa into public/')
    }
  })
} else if (hostPort === apiPort) {
  const frontendDir = mountFrontend(app)
  if (frontendDir) {
    console.log(`Frontend hosted from ${frontendDir} (same port as API)`)
  }
}
