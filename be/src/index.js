import { createApp } from './app.js'
import { config } from './config.js'

const app = createApp()

app.listen(config.port, config.host, () => {
  console.log(`Mellifera backend listening at http://${config.host}:${config.port}`)
  console.log(`API docs: http://${config.host}:${config.port}/api/health`)
})
