import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  getCachedSessionRow,
  getLatestTaskRowBySub,
  getTaskRow,
  listTaskRows,
  saveTask,
} from '../db.js'
import { downloadTo, fetchCourseSessions, fetchSessionPpt } from './classroom.js'

const WORKDIR = process.env.TRANSCRIPT_WORKDIR || '/opt/test2/mellifera'
const CONDA_PYTHON = process.env.CONDA_PYTHON || '/opt/conda/envs/qwen38/bin/python'
// fireredasr2s 是该目录下的本地包，python 子进程需以其为工作目录才能导入
const FIRERED_ROOT = process.env.FIRERED_ROOT || '/opt/FireRedASR2S'
const PIPELINE_PY = path.resolve(import.meta.dirname, '../../pipeline/asr_stage.py')
const SGLANG_BASE = process.env.SGLANG_BASE || 'http://127.0.0.1:8000'
const SGLANG_MODEL = process.env.SGLANG_MODEL || 'Qwen3.8-27B-Uncensored-FP8'
const PPT_MAX = Number(process.env.PPT_SELECT_MAX || 16)
const ASR_MAX_SEGMENTS = Number(process.env.ASR_MAX_SEGMENTS || 0)
const LOGS_MAX = 8000 // 日志尾巴上限，防止长任务把 DB 行撑爆

// GPU 任务串行
const queue = []
let running = false

// 存活任务的内存对象（运行态）；SSE 订阅者按 taskId 登记
const tasksById = new Map()
const subscribers = new Map()

function httpErr(status, message) {
  return Object.assign(new Error(message), { status })
}

const mmss = (sec) => {
  const s = Math.max(0, Math.floor(sec))
  return `[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]`
}

function jobDir(task) {
  return path.join(WORKDIR, `${task.courseId}_${task.subId}`)
}

function appendLog(task, line) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  task.logs = `${task.logs}[${ts}] ${line}\n`.slice(-LOGS_MAX)
}

function notify(task) {
  const snapshot = publicTask(task, task.status === 'done')
  for (const fn of subscribers.get(task.taskId) || []) {
    try {
      fn(snapshot)
    } catch {}
  }
}

function update(task, patch) {
  Object.assign(task, patch)
  if (patch.detail !== undefined) appendLog(task, patch.detail)
  try {
    saveTask(task)
  } catch (e) {
    console.warn('[DB] 任务持久化失败:', e.message)
  }
  notify(task)
}

/** 对外 JSON 形态；withResult=true 时读取产物文件（仅 done 任务有意义） */
function publicTask(task, withResult = false) {
  const pub = {
    taskId: task.taskId,
    subId: task.subId,
    courseId: task.courseId,
    title: task.title,
    videoUrl: task.videoUrl,
    status: task.status,
    stepId: task.stepId,
    detail: task.detail,
    progress: task.progress,
    error: task.error,
    logs: task.logs,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    result: null,
  }
  if (withResult && task.status === 'done') pub.result = computeResult(task)
  return pub
}

// done 任务的结果从磁盘产物拼出（transcript_final.md + blocks.json + ppt/ 目录）
function computeResult(task) {
  const dir = jobDir(task)
  let markdown = ''
  try {
    markdown = fs.readFileSync(path.join(dir, 'transcript_final.md'), 'utf-8')
  } catch {}
  let blocksCount = 0
  try {
    blocksCount = JSON.parse(fs.readFileSync(path.join(dir, 'blocks.json'), 'utf-8')).length
  } catch {}
  let pptCount = 0
  try {
    pptCount = fs
      .readdirSync(path.join(dir, 'ppt'))
      .filter((f) => f.endsWith('.jpg')).length
  } catch {}
  return { markdown, blocksCount, pptCount }
}

// 从 DB 行重建任务对象（后端重启后的恢复路径）
function restoreTask(row) {
  const task = {
    taskId: row.task_id,
    subId: row.sub_id,
    courseId: row.course_id,
    title: row.title,
    videoUrl: row.video_url,
    logs: row.logs,
    stepId: row.step_id,
    status: row.status,
    progress: row.progress ? JSON.parse(row.progress) : null,
    detail: row.detail,
    error: row.error,
    resultFile: row.result_file,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    result: null,
  }
  if (task.status !== 'error') tasksById.set(task.taskId, task)
  return task
}

// ---------- SSE 订阅 ----------

export function subscribe(taskId, fn) {
  if (!subscribers.has(taskId)) subscribers.set(taskId, new Set())
  subscribers.get(taskId).add(fn)
}

export function unsubscribe(taskId, fn) {
  subscribers.get(taskId)?.delete(fn)
}

// ---------- 下载 / PPT / LLM 辅助 ----------

// 下载回放视频，期间轮询文件大小更新 detail
function downloadVideo(url, dest, task) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['-fSL', '--retry', '5', '--retry-all-errors', '-o', dest, url])
    let errTail = ''
    child.stderr.on('data', (d) => {
      errTail = (errTail + d).slice(-2000)
    })
    const timer = setInterval(() => {
      try {
        const mb = fs.statSync(dest).size / 1e6
        update(task, { detail: `已下载 ${mb.toFixed(0)} MB` })
      } catch {}
    }, 3000)
    child.on('error', (e) => {
      clearInterval(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearInterval(timer)
      if (code === 0) resolve()
      else reject(httpErr(500, `视频下载失败（curl 退出码 ${code}）\n${errTail.slice(-800)}`))
    })
  })
}

// PPT "适当选择"：相邻重复页去重；超过上限时按时间均匀采样
function selectPpt(list, max) {
  const dedup = []
  for (const p of list) {
    if (!dedup.length || dedup[dedup.length - 1].url !== p.url) dedup.push(p)
  }
  if (dedup.length <= max) return dedup
  const picked = [dedup[0]]
  for (let i = 1; i < max - 1; i++) {
    const idx = Math.round((i * (dedup.length - 1)) / (max - 1))
    if (picked[picked.length - 1] !== dedup[idx]) picked.push(dedup[idx])
  }
  const last = dedup[dedup.length - 1]
  if (picked[picked.length - 1] !== last) picked.push(last)
  return picked
}

const SYSTEM_PROMPT = `你是课程逐字稿编辑。给你一段课程录音的 ASR 转写（每行前有 [mm:ss] 时间戳），以及按时间顺序选取的该课件截图（截图与文末列出的 PPT 编号一一对应）。请：
1. 结合课件截图上的文字，修正转写中同音/近音误听的术语和人名（截图内容是权威依据），如"蘑菇模型->魔搭模型"这类错误；
2. 按课件换页把全文分成若干章节，每章以一行 "## [mm:ss] 章节标题" 开头，标题从对应截图内容概括，时间戳取该章第一句的时间；
3. 章节内逐句保留转写内容及其 [mm:ss] 时间戳，只做语气词清理和错别字修正，不要改写原意、不要删减或概括实质内容；
4. 直接输出 Markdown 逐字稿正文，不要任何解释或前言。`

async function generateTranscript(blocks, ppts) {
  const transcriptText = blocks.map((b) => `${mmss(b.start)} ${b.text}`).join('\n')
  const pptIndex = ppts.map((p, i) => `PPT ${i + 1} ${mmss(p.sec)}`).join('\n')
  const content = [
    {
      type: 'text',
      text: `以下是 ASR 转写片段：\n\n${transcriptText}\n\n以下是选取的课件截图时间索引：\n${pptIndex}`,
    },
    ...ppts.map((p) => ({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(p.file).toString('base64')}` },
    })),
  ]
  const res = await fetch(`${SGLANG_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SGLANG_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
      temperature: 0.1,
      max_tokens: 32768,
      stream: true, // SSE 流式：响应头立即可得，规避 undici 默认 5 分钟 headers 超时
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(20 * 60 * 1000),
  })
  if (!res.ok) {
    throw httpErr(502, `SGLang 请求失败 ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const text = await readSseContent(res)
  if (!text) throw httpErr(502, 'SGLang 返回了空内容')
  return text
}

// 读取 OpenAI 兼容的 SSE 流，拼接出完整正文
async function readSseContent(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content
        if (delta) text += delta
      } catch {}
    }
  }
  return text.trim()
}

// ---------- 流水线 ----------

async function runTask(task) {
  const dir = jobDir(task)
  fs.mkdirSync(dir, { recursive: true })
  const setStep = (stepId, detail, progress = null) =>
    update(task, { status: 'running', stepId, detail, progress })

  try {
    // 1. 校验课时（videoUrl 已在创建时从缓存解析）
    setStep('meta', `解析课时信息（课程 ${task.courseId}）`)

    // 2. 下载回放视频（已存在则跳过，支持断点续跑）
    setStep('download', '下载回放视频')
    const videoPath = path.join(dir, 'video.mp4')
    if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 1e6) {
      update(task, { detail: `复用已下载的视频 (${(fs.statSync(videoPath).size / 1e6).toFixed(0)} MB)` })
    } else {
      await downloadVideo(task.videoUrl, videoPath, task)
    }

    // 3. 抽音频（已存在则跳过）
    setStep('audio', 'ffmpeg 抽取 16kHz 单声道音频')
    const audioPath = path.join(dir, 'audio.wav')
    if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1e6) {
      await run('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', audioPath])
    }

    // 4. VAD + ASR + 后处理（python 子进程，轮询 progress.json）
    setStep('asr', '加载模型，VAD 切段', { done: 0, total: 0 })
    const pyArgs = [PIPELINE_PY, '--workdir', dir]
    if (ASR_MAX_SEGMENTS > 0) pyArgs.push('--max-segments', String(ASR_MAX_SEGMENTS))
    await new Promise((resolve, reject) => {
      // fireredasr2s 在 FIRERED_ROOT 下，python 只把脚本目录放进 sys.path，需显式 PYTHONPATH
      const child = spawn(CONDA_PYTHON, pyArgs, {
        cwd: FIRERED_ROOT,
        env: { ...process.env, PYTHONPATH: FIRERED_ROOT },
      })
      let errTail = ''
      child.stderr.on('data', (d) => {
        errTail = (errTail + d).slice(-4000)
      })
      const timer = setInterval(() => {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(dir, 'progress.json'), 'utf-8'))
          if (p.step === 'asr' || p.step === 'punc') {
            update(task, { stepId: p.step, progress: { done: p.done, total: p.total }, detail: p.detail })
          }
        } catch {}
      }, 3000)
      child.on('error', (e) => {
        clearInterval(timer)
        reject(e)
      })
      child.on('close', (code) => {
        clearInterval(timer)
        if (code === 0) resolve()
        else reject(httpErr(500, `ASR 阶段失败（退出码 ${code}）\n${errTail.slice(-1200)}`))
      })
    })

    // 5. PPT 列表 + 适当选择 + 下载
    setStep('ppt', `获取 PPT 列表并筛选（上限 ${PPT_MAX} 张）`)
    const pptList = await fetchSessionPpt(task.courseId, task.subId)
    const selected = selectPpt(pptList, PPT_MAX)
    const pptDir = path.join(dir, 'ppt')
    fs.mkdirSync(pptDir, { recursive: true })
    for (let i = 0; i < selected.length; i++) {
      const file = path.join(pptDir, `ppt_${String(i + 1).padStart(2, '0')}.jpg`)
      await downloadTo(selected[i].url, file)
      selected[i].file = file
      update(task, { detail: `下载 PPT ${i + 1}/${selected.length}` })
    }

    // 6. LLM 生成逐字稿（文本片段 + PPT 图进上下文）
    setStep('llm', `SGLang 生成逐字稿（${selected.length} 张 PPT 进上下文）`)
    const blocks = JSON.parse(fs.readFileSync(path.join(dir, 'blocks.json'), 'utf-8'))
    const markdown = await generateTranscript(blocks, selected)
    const resultFile = path.join(dir, 'transcript_final.md')
    fs.writeFileSync(resultFile, markdown)

    update(task, {
      status: 'done',
      stepId: 'done',
      detail: '完成',
      resultFile,
      finishedAt: Date.now(),
    })
  } catch (e) {
    update(task, {
      status: 'error',
      error: e.message?.slice(0, 2000) || String(e),
      finishedAt: Date.now(),
    })
  } finally {
    running = false
    runNext()
  }
}

// Promise 化的子进程调用，失败时带 stderr 尾部
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    let errTail = ''
    child.stderr.on('data', (d) => {
      errTail = (errTail + d).slice(-4000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(httpErr(500, `${cmd} 退出码 ${code}\n${errTail.slice(-1200)}`))
    })
  })
}

function runNext() {
  if (running || queue.length === 0) return
  const task = queue.shift()
  running = true
  runTask(task)
}

// ---------- 对外 API ----------

/**
 * 创建（或复用）逐字稿任务。
 * videoUrl 只从课节缓存解析：缓存未命中且调用方给了 courseId 时先拉一次课节列表落缓存。
 */
export async function createTask({ subId, courseId = null, force = false }) {
  const latestRow = getLatestTaskRowBySub(subId)
  if (!force && latestRow && latestRow.status !== 'error') {
    const task = tasksById.get(latestRow.task_id) || restoreTask(latestRow)
    appendLog(task, '复用已有任务（同一课时幂等）')
    return publicTask(task, true)
  }

  let row = getCachedSessionRow(subId)
  if (!row && courseId) {
    await fetchCourseSessions(courseId)
    row = getCachedSessionRow(subId)
  }
  if (!row) {
    throw httpErr(
      404,
      `课节 ${subId} 不在本地缓存：请先在课程课节列表页访问一次，或在请求中携带 courseId`
    )
  }
  if (!row.playback_url) throw httpErr(400, '该课节没有回放视频，无法生成逐字稿')

  // 磁盘上已有该课时的成品（历史运行产物）→ 登记为 done 任务直接返回，不重跑
  const existingMd = path.join(WORKDIR, `${row.course_id}_${subId}`, 'transcript_final.md')
  if (!force && fs.existsSync(existingMd)) {
    const task = {
      taskId: crypto.randomBytes(8).toString('hex'),
      subId,
      courseId: row.course_id,
      title: row.title,
      videoUrl: row.playback_url,
      logs: '',
      stepId: 'done',
      status: 'done',
      progress: null,
      detail: '完成（复用已有产物）',
      error: null,
      resultFile: existingMd,
      createdAt: Date.now(),
      finishedAt: Date.now(),
      result: null,
    }
    tasksById.set(task.taskId, task)
    saveTask(task, true)
    appendLog(task, '发现已有逐字稿产物，直接返回')
    return publicTask(task, true)
  }

  const task = {
    taskId: crypto.randomBytes(8).toString('hex'),
    subId,
    courseId: row.course_id,
    title: row.title,
    videoUrl: row.playback_url,
    logs: '',
    stepId: '',
    status: 'queued',
    progress: null,
    detail: '排队等待中（GPU 任务串行）',
    error: null,
    resultFile: null,
    createdAt: Date.now(),
    finishedAt: null,
    result: null,
  }
  tasksById.set(task.taskId, task)
  saveTask(task, true)
  appendLog(task, `创建任务：课程 ${row.course_id} 课节 ${subId}`)
  queue.push(task)
  runNext()
  return publicTask(task, true)
}

export function getTask(taskId) {
  const task = tasksById.get(taskId) || (getTaskRow(taskId) ? restoreTask(getTaskRow(taskId)) : null)
  return task ? publicTask(task, true) : null
}

export function listTasks() {
  return listTaskRows().map((row) => publicTask(restoreTask(row), false))
}
