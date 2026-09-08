// 探查智云课堂课程列表与课程目录的字段结构，确定"上过"的判定依据
import fs from 'node:fs'
import path from 'node:path'
import { CLASSROOM, ZJUAM } from 'login-zju'

const envPath = path.resolve(import.meta.dirname, '../../.env')
for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^"(.*)"$/, '$1')
}

const classroom = new CLASSROOM(new ZJUAM(process.env.ZJU_USERNAME, process.env.ZJU_PASSWORD))

const coursesRes = await classroom.fetch(
  'https://education.cmc.zju.edu.cn/personal/courseapi/vlabpassportapi/v1/account-profile/course?nowpage=1&per-page=100&force_mycourse=1'
).then((r) => r.json())
const courses = coursesRes.params.result.data
console.log('course keys:', Object.keys(courses[0]).join(', '))
console.log('course[0]:', JSON.stringify(courses[0], null, 1).slice(0, 600))

// 并发拉取所有课程目录，统计 status 分布
async function mapLimit(items, limit, fn) {
  const results = []
  for (let i = 0; i < items.length; i += limit) {
    results.push(...await Promise.all(items.slice(i, i + limit).map(fn)))
  }
  return results
}

const now = Math.floor(Date.now() / 1000)
const stats = await mapLimit(courses, 5, async (c) => {
  try {
    const cat = await classroom.fetch(
      'https://yjapi.cmc.zju.edu.cn/courseapi/v2/course/catalogue?course_id=' + c.Id
    ).then((r) => r.json())
    const sessions = cat.result?.data || []
    return {
      title: c.Title,
      total: sessions.length,
      past: sessions.filter((v) => Number(v.start_at) <= now).length,
      finished6: sessions.filter((v) => v.status === '6').length,
    }
  } catch (e) {
    return { title: c.Title, total: -1, past: -1, finished6: -1 }
  }
})

console.log('\n课程 | 总场次 | 已开始 | status=6')
for (const s of stats) console.log(`${s.title} | ${s.total} | ${s.past} | ${s.finished6}`)
