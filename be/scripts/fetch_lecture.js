// 抓取一节课（最近一节有回放的课）的完整信息：PPT 列表、回放链接、原始字幕
// 用法: node scripts/fetch_lecture.js  （在 be/ 目录下运行）
// 输出: tmp/lecture_<courseId>_<subId>.txt
import fs from 'node:fs'
import path from 'node:path'
import { CLASSROOM, ZJUAM } from 'login-zju'

// 手动加载项目根目录的 .env（不引入 dotenv 依赖）
const envPath = path.resolve(import.meta.dirname, '../../.env')
for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^"(.*)"$/, '$1')
}

const pad = (n) => n.toString().padStart(2, '0')
const mmss = (sec) => `[${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}]`

const classroom = new CLASSROOM(new ZJUAM(process.env.ZJU_USERNAME, process.env.ZJU_PASSWORD))

// 1. 我的课程列表
const coursesRes = await classroom.fetch(
  'https://education.cmc.zju.edu.cn/personal/courseapi/vlabpassportapi/v1/account-profile/course?nowpage=1&per-page=100&force_mycourse=1'
).then((r) => r.json())
const courses = coursesRes.params.result.data
console.log(`共 ${courses.length} 门课程`)

// 2. 依次尝试，找到第一节"有回放(status=6)"的课
let course = null
let video = null
for (const c of courses) {
  const cat = await classroom.fetch(
    'https://yjapi.cmc.zju.edu.cn/courseapi/v2/course/catalogue?course_id=' + c.Id
  ).then((r) => r.json())
  const finished = (cat.result?.data || [])
    .filter((v) => v.status === '6')
    .sort((a, b) => Number(b.start_at) - Number(a.start_at))
  if (finished.length > 0) {
    course = c
    video = finished[0] // 最近一节有回放的课
    break
  }
}
if (!video) {
  console.error('所有课程都没有已结束的回放')
  process.exit(1)
}
console.log(`选中: ${course.Title} - ${course.Teacher} | 课节: ${video.title}`)

const playback = JSON.parse(video.content).playback.url

// 3. PPT 列表（仅 url + 时间戳）
const pptRes = await classroom.fetch(
  `https://classroom.zju.edu.cn/pptnote/v1/schedule/search-ppt?course_id=${video.course_id}&sub_id=${video.sub_id}`
).then((r) => r.json())
const ppts = []
for (const item of pptRes.list || []) {
  let content = {}
  try {
    content = typeof item.content === 'string' ? JSON.parse(item.content) : item.content
  } catch {}
  if (content.pptimgurl) ppts.push({ url: content.pptimgurl, sec: Number(item.created_sec || 0) })
}
console.log(`PPT: ${ppts.length} 张`)

// 4. 原始字幕
const transRes = await classroom.fetch(
  `https://yjapi.cmc.zju.edu.cn/courseapi/v3/web-socket/search-trans-result?sub_id=${video.sub_id}&format=json`
).then((r) => r.json())
const subtitles = []
for (const item of transRes.list || []) {
  for (const c of item.all_content || []) {
    subtitles.push({ sec: Number(c.BeginSec || 0), text: c.Text || '' })
  }
}
console.log(`字幕: ${subtitles.length} 条`)

// 5. 生成 txt
const lines = []
lines.push(`课程: ${course.Title} - ${course.Teacher}`)
lines.push(`课节: ${video.title}`)
lines.push(`开始时间: ${new Date(Number(video.start_at) * 1000).toLocaleString('zh-CN')}`)
lines.push(`视频回放地址: ${playback}`)
lines.push(`PPT 数量: ${ppts.length}`)
lines.push(`字幕条数: ${subtitles.length}`)
lines.push('')
lines.push('==================== PPT 列表 ====================')
ppts.forEach((p, i) => {
  lines.push(`${(i + 1).toString().padStart(3, '0')} ${mmss(p.sec)} ${p.url}`)
})
lines.push('')
lines.push('==================== 原始字幕 ====================')
for (const s of subtitles) {
  lines.push(`${mmss(s.sec)} ${s.text}`)
}

const outDir = path.resolve(import.meta.dirname, '../tmp')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, `lecture_${video.course_id}_${video.sub_id}.txt`)
fs.writeFileSync(outFile, lines.join('\n'), 'utf-8')
console.log('已写入:', outFile)
