import fs from 'node:fs'

import { CLASSROOM, ZJUAM } from 'login-zju'

// 智云课堂接口（用法与 ZJU-live-better/classroom.zju 一致）
const COURSE_LIST_URL =
  'https://education.cmc.zju.edu.cn/personal/courseapi/vlabpassportapi/v1/account-profile/course'
const CATALOGUE_URL = 'https://yjapi.cmc.zju.edu.cn/courseapi/v2/course/catalogue'

let client = null

function getClient() {
  if (!client) {
    if (!process.env.ZJU_USERNAME || !process.env.ZJU_PASSWORD) {
      const err = new Error('缺少 ZJU_USERNAME / ZJU_PASSWORD 环境变量（.env）')
      err.status = 503
      throw err
    }
    client = new CLASSROOM(new ZJUAM(process.env.ZJU_USERNAME, process.env.ZJU_PASSWORD))
  }
  return client
}

// ZJU 会话过期时上游返回 200 + "invalid credentials" 消息；此时丢弃缓存的
// 登录客户端（CLIENT 重新登录），并重试一次
async function authedJson(url) {
  let json = await getClient().fetch(url).then((r) => r.json())
  if (json?.message && /invalid credentials/i.test(json.message)) {
    client = null
    json = await getClient().fetch(url).then((r) => r.json())
  }
  return json
}

function toCourse(c) {
  return {
    courseId: c.Id,
    title: c.Title,
    teacher: c.Teacher,
    term: c.TermName || '',
    college: c.KkxyName || '',
    cover: c.ExtractThumb || c.Thumb || '',
  }
}

// 分页查询"我的课程"（force_mycourse=1，用于列表选择）
export async function fetchCourses({ page = 1, pageSize = 10 } = {}) {
  const url = `${COURSE_LIST_URL}?nowpage=${page}&per-page=${pageSize}&force_mycourse=1`
  const res = await authedJson(url)
  const result = res.params?.result
  if (!result) {
    const err = new Error(res.message || '智云课堂课程接口返回异常')
    err.status = 502
    throw err
  }
  return {
    total: Number(result.total || 0),
    page: Number(result.page || page),
    pageSize: Number(result['per-page'] || pageSize),
    items: (result.data || []).map(toCourse),
  }
}

function toSession(v) {
  // 上游 playback.url 可能是字符串或单元素数组，subId 可能是数字或字符串，统一归一化
  let playbackUrl = null
  try {
    const url = JSON.parse(v.content)?.playback?.url
    playbackUrl = typeof url === 'string' ? url : Array.isArray(url) ? (url[0] ?? null) : null
  } catch {
    // content 为空或非 JSON 时无回放地址
  }
  return {
    subId: Number(v.sub_id),
    title: v.title,
    startAt: Number(v.start_at || 0),
    status: String(v.status ?? ''),
    playbackUrl,
  }
}

// 课节目录：不限于自己的课程，只要智云课堂存在该 courseId 即可
export async function fetchCourseSessions(courseId) {
  const res = await authedJson(`${CATALOGUE_URL}?course_id=${courseId}`)
  const sessions = res.result?.data
  if (!Array.isArray(sessions)) {
    const err = new Error(res.message || `智云课堂没有返回课程 ${courseId} 的课节数据`)
    err.status = 502
    throw err
  }
  const items = sessions.map(toSession).sort((a, b) => b.startAt - a.startAt)
  return { courseId, total: items.length, items }
}

// 课节的 PPT 截图列表（按出现时间升序）
export async function fetchSessionPpt(courseId, subId) {
  const url = `https://classroom.zju.edu.cn/pptnote/v1/schedule/search-ppt?course_id=${courseId}&sub_id=${subId}`
  const res = await authedJson(url)
  const list = []
  for (const item of res.list || []) {
    let content = {}
    try {
      content = typeof item.content === 'string' ? JSON.parse(item.content) : item.content
    } catch {}
    if (content.pptimgurl) list.push({ url: content.pptimgurl, sec: Number(item.created_sec || 0) })
  }
  return list.sort((a, b) => a.sec - b.sec)
}

// 走登录态下载资源（PPT 截图等需要 Cookie 的地址），返回字节数
export async function downloadTo(url, dest) {
  let res = await getClient().fetch(url)
  if (res.status === 401) {
    client = null
    res = await getClient().fetch(url)
  }
  if (!res.ok) {
    throw Object.assign(new Error(`下载失败 ${res.status}: ${url}`), { status: 502 })
  }
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dest, buf)
  return buf.length
}
