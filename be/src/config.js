export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT) || 9000,
  corsOrigins: ['http://localhost:5180', 'http://127.0.0.1:5180'],
}
