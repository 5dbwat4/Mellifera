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
import { downloadTo, fetchCourseSessions, fetchCourseSessionsRaw, fetchSessionPpt } from './classroom.js'

const WORKDIR = process.env.TRANSCRIPT_WORKDIR || '/opt/test2/mellifera'
const CONDA_PYTHON = process.env.CONDA_PYTHON || '/opt/conda/envs/qwen38/bin/python'
// fireredasr2s 是该目录下的本地包，python 子进程需以其为工作目录才能导入
const FIRERED_ROOT = process.env.FIRERED_ROOT || '/opt/FireRedASR2S'
const PIPELINE_PY = path.resolve(import.meta.dirname, '../../pipeline/asr_stage.py')
const SGLANG_BASE = process.env.SGLANG_BASE || 'http://127.0.0.1:8000'
const SGLANG_MODEL = process.env.SGLANG_MODEL || 'Qwen3.8-27B-Uncensored-FP8'
const PPT_MAX = Number(process.env.PPT_SELECT_MAX || 64) // 单个分段送入 LLM 的课件上限
const LLM_CHUNK_SEC = Number(process.env.LLM_CHUNK_SEC || 1800) // 逐字稿分段生成的目标段长
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
  if (task.status === 'paused') {
    // 重启后从 detail 辨识自动恢复类暂停（等待 sglang / 等待 GPU），重新挂上探测
    task.waitSglang = (task.detail || '').startsWith('等待 sglang')
    task.waitGpu = (task.detail || '').startsWith('等待 GPU')
    if (task.waitSglang || task.waitGpu) armSglangWatcher()
  }
  if (task.status !== 'error') tasksById.set(task.taskId, task)
  return task
}

// 启动清扫：重启后 DB 里遗留的 running/queued 行已无对应运行态，转为 paused 防僵尸
// （restoreTask 会把它们登记进内存，resumeById 可直接恢复）
for (const row of listTaskRows()) {
  if (row.status === 'running' || row.status === 'queued') {
    const task = restoreTask(row)
    update(task, { status: 'paused', detail: '后端重启，任务已中断，可手动继续' })
  }
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
    // 同样先写 .part：暂停/中断留下的半截视频不会被复用检查误判为已下载
    const child = spawn('curl', ['-fSL', '--retry', '5', '--retry-all-errors', '-o', `${dest}.part`, url])
    task.child = child
    let errTail = ''
    child.stderr.on('data', (d) => {
      errTail = (errTail + d).slice(-2000)
    })
    const timer = setInterval(() => {
      try {
        const mb = fs.statSync(`${dest}.part`).size / 1e6
        update(task, { detail: `已下载 ${mb.toFixed(0)} MB` })
      } catch {}
    }, 3000)
    const finish = () => {
      clearInterval(timer)
      task.child = undefined
    }
    child.on('error', (e) => {
      finish()
      reject(e)
    })
    child.on('close', (code) => {
      finish()
      if (code === 0) {
        fs.renameSync(`${dest}.part`, dest)
        resolve()
      } else {
        reject(httpErr(500, `视频下载失败（curl 退出码 ${code}）\n${errTail.slice(-800)}`))
      }
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

const SYSTEM_PROMPT = `你是课程逐字稿编辑。整节课的 ASR 转写按时间范围切成若干大段分别整理，现在给你其中一段的转写（每行前有 [mm:ss] 时间戳），以及按时间顺序选取的该段课件截图（截图与文末列出的 PPT 编号一一对应）。请：
1. 结合课件截图上的文字，修正转写中同音/近音误听的术语和人名（截图内容是权威依据），如"蘑菇模型->魔搭模型"这类错误；
2. 按课件换页把这段分成若干章节，每章以一行 "## [mm:ss] 章节标题" 开头，标题从对应截图内容概括，时间戳取该章第一句的时间；
3. 章节内逐句保留转写内容及其 [mm:ss] 时间戳，只做语气词清理和错别字修正，不要改写原意、不要删减或概括实质内容；
4. 直接输出 Markdown 逐字稿正文，不要任何解释或前言；只处理给出的时间范围，不要编造范围之外的内容。`

// 单个 chat 调用：流式 + 超时/暂停中止，返回拼接后的正文
async function chat(messages, signal, maxTokens = 32768) {
  const res = await fetch(`${SGLANG_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SGLANG_MODEL,
      messages,
      temperature: 0.1,
      max_tokens: maxTokens,
      stream: true, // SSE 流式：响应头立即可得，规避 undici 默认 5 分钟 headers 超时
      chat_template_kwargs: { enable_thinking: false },
    }),
    // 超时与暂停中止任一触发即断开
    signal: AbortSignal.any(
      [AbortSignal.timeout(20 * 60 * 1000), ...(signal ? [signal] : [])]
    ),
  })
  if (!res.ok) {
    throw httpErr(502, `SGLang 请求失败 ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const text = await readSseContent(res)
  if (!text) throw httpErr(502, 'SGLang 返回了空内容')
  return text
}

// 第一步：全文规划——整课概括 + 按主题切 ~30 分钟的大段，切分点对齐转写时间戳
async function planSegments(blocks, ppts, signal) {
  const transcriptText = blocks.map((b) => `${mmss(b.start)} ${b.text}`).join('\n')
  const pptIndex = ppts.map((p, i) => `PPT ${i + 1} ${mmss(p.sec)}`).join('\n')
  const prompt = `你是课程逐字稿的编辑策划。下面是一节课的 ASR 转写（每行前有 [mm:ss] 时间戳，格式为 分:秒，分钟可能超过 60）和课件换页时间索引。请：
1. 用一段话概括整节课的内容；
2. 按讲课主题把全文切成若干大段，每段约 ${Math.round(LLM_CHUNK_SEC / 60)} 分钟（可上下浮动 10 分钟）：切分点必须落在某个转写行的时间戳上，并尽量对齐主题转换或课件换页的位置；
3. 为每段起一个 15 字以内的标题。
严格只输出如下 JSON（不要 markdown 代码块，不要任何解释）：
{"summary":"整节课概括","segments":[{"start":"mm:ss","end":"mm:ss","title":"段标题"}]}
首段的 start 用第一个时间戳，末段的 end 覆盖到最后一行，segments 按时间升序。

ASR 转写片段：
${transcriptText}

课件换页时间索引：
${pptIndex}`
  const text = await chat([{ role: 'user', content: prompt }], signal, 4096)
  const m = text.match(/\{[\s\S]*\}/)
  const plan = JSON.parse(m[0])
  if (!Array.isArray(plan.segments) || !plan.segments.length) {
    throw new Error('规划结果没有 segments')
  }
  return plan
}

const parseMmss = (s) => {
  const m = /^(\d+):(\d{1,2})$/.exec(String(s).trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

// 把规划结果规整为可执行的分段：切分点吸附到最近的文本块起点，保证无重叠、无遗漏；
// 规划失败时回退为固定 ${LLM_CHUNK_SEC} 秒切分
function normalizePlan(plan, blocks) {
  const starts = blocks.map((b) => b.start)
  const snap = (t) => starts.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a))
  const cuts = new Set([starts[0]])
  const titles = new Map()
  if (plan) {
    for (const seg of plan.segments) {
      const s = parseMmss(seg.start)
      if (Number.isNaN(s)) continue
      const snapped = snap(s)
      cuts.add(snapped)
      if (!titles.has(snapped)) titles.set(snapped, String(seg.title || '').slice(0, 40))
    }
  } else {
    const lastEnd = blocks[blocks.length - 1].end
    for (let t = LLM_CHUNK_SEC; t < lastEnd; t += LLM_CHUNK_SEC) cuts.add(snap(t))
  }
  const ordered = [...cuts].sort((a, b) => a - b)
  const segments = []
  for (let i = 0; i < ordered.length; i++) {
    const start = ordered[i]
    const end = i + 1 < ordered.length ? ordered[i + 1] : blocks[blocks.length - 1].end
    if (end - start < 60 && segments.length) {
      segments[segments.length - 1].end = end // 过薄的段并入前段
      continue
    }
    segments.push({ start, end, title: titles.get(start) || `第 ${segments.length + 1} 部分` })
  }
  return segments
}

// 第二步：逐段生成（该段时间戳范围内的全部文本块 + 全部课件），每段产物落盘可断点续跑；
// 第三步：顺序拼合（各段输出已是统一的 "## [mm:ss] 章节" 格式）
async function generateTranscript(task, blocks, ppts, signal) {
  const dir = jobDir(task)

  // 分段计划必须跨重启/恢复保持一致，否则已生成的段缓存会对不上号，故落盘复用
  const planFile = path.join(dir, 'llm_plan.json')
  let summary = ''
  let segments
  if (fs.existsSync(planFile)) {
    ;({ summary, segments } = JSON.parse(fs.readFileSync(planFile, 'utf-8')))
    appendLog(task, `复用已有分段计划（${segments.length} 段）`)
  } else {
    let plan = null
    try {
      plan = await planSegments(blocks, ppts, signal)
    } catch (e) {
      appendLog(task, `LLM 分段规划失败，改用固定 ${LLM_CHUNK_SEC / 60} 分钟切分: ${e.message}`)
    }
    segments = normalizePlan(plan, blocks)
    summary = plan?.summary ? String(plan.summary).slice(0, 2000) : ''
    fs.writeFileSync(planFile, JSON.stringify({ summary, segments }))
    appendLog(task, summary ? `整课概括：${summary}` : '未获得整课概括')
    appendLog(task, `切分为 ${segments.length} 段：${segments.map((s) => `${mmss(s.start)} ${s.title}`).join('、')}`)
  }

  const parts = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const cacheFile = path.join(dir, `llm_seg_${String(i + 1).padStart(2, '0')}.md`)
    if (fs.existsSync(cacheFile)) {
      parts.push(fs.readFileSync(cacheFile, 'utf-8'))
      update(task, { progress: { done: i + 1, total: segments.length }, detail: `第 ${i + 1}/${segments.length} 段已有产物，直接复用` })
      continue
    }
    update(task, { progress: { done: i, total: segments.length }, detail: `生成第 ${i + 1}/${segments.length} 段：${seg.title}（${mmss(seg.start)} 起）` })

    const segBlocks = blocks.filter((b) => b.start >= seg.start && b.start < seg.end)
    let segPpts = ppts.filter((p) => p.sec >= seg.start - 10 && p.sec < seg.end)
    if (segPpts.length > PPT_MAX) {
      appendLog(task, `第 ${i + 1} 段课件 ${segPpts.length} 张超过单段上限 ${PPT_MAX}，均匀采样`)
      segPpts = selectPpt(segPpts, PPT_MAX)
    }
    if (!segBlocks.length) throw httpErr(500, `第 ${i + 1} 段没有文本块，分段异常`)
    appendLog(task, `第 ${i + 1}/${segments.length} 段：${segBlocks.length} 个文本块 + ${segPpts.length} 张课件`)

    const transcriptText = segBlocks.map((b) => `${mmss(b.start)} ${b.text}`).join('\n')
    const pptIndex = segPpts.map((p, i) => `PPT ${i + 1} ${mmss(p.sec)}`).join('\n')
    const content = [
      {
        type: 'text',
        text: `整节课概括：${summary || '（无）'}\n本段标题：${seg.title}（时间范围 ${mmss(seg.start)} - ${mmss(seg.end)}）\n\n以下是本段的 ASR 转写片段：\n\n${transcriptText}\n\n以下是本段选取的课件截图时间索引：\n${pptIndex}`,
      },
      ...segPpts.map((p) => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(p.file).toString('base64')}` },
      })),
    ]
    const markdown = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
      signal
    )
    fs.writeFileSync(cacheFile, markdown)
    parts.push(markdown)
  }
  return parts.join('\n\n')
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

// ---------- sglang 在线探测与暂停/恢复 ----------

async function sglangUp() {
  try {
    const res = await fetch(`${SGLANG_BASE}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

// 有暂停任务时每 15 秒探测 sglang：等 sglang 的任务在上线后恢复，
// 等 GPU 的任务在 sglang 停止后恢复；手动暂停的任务不自动恢复
let sglangWatchTimer
function armSglangWatcher() {
  if (sglangWatchTimer !== undefined) return
  sglangWatchTimer = setInterval(async () => {
    try {
      const paused = [...tasksById.values()].filter((t) => t.status === 'paused')
      const waiting = paused.filter((t) => t.waitSglang || t.waitGpu)
      if (!waiting.length) {
        clearInterval(sglangWatchTimer)
        sglangWatchTimer = undefined
        return
      }
      const up = await sglangUp()
      for (const t of waiting) {
        if (t.waitSglang && up) resumeById(t.taskId, '检测到 sglang 已上线，自动继续')
        else if (t.waitGpu && !up) resumeById(t.taskId, '检测到 sglang 已停止，GPU 空闲，自动继续')
      }
    } catch (e) {
      // 定时器内抛异常会成为 unhandled rejection 并可能带崩进程，必须兜住
      console.warn('[WATCHER] sglang 探测失败:', e.message)
    }
  }, 15000)
}

export function pauseById(taskId) {
  const task = tasksById.get(taskId)
  if (!task) throw httpErr(404, '任务不存在')
  if (task.status === 'queued') {
    const i = queue.indexOf(task)
    if (i >= 0) queue.splice(i, 1)
    update(task, { status: 'paused', detail: '已暂停（尚未开始执行）' })
    return publicTask(task, true)
  }
  if (task.status === 'running') {
    // 置位后终止当前子进程，runTask 的 catch 据此落为 paused 而非 error
    task.pauseRequested = true
    task.llmAbort?.abort()
    try {
      task.child?.kill('SIGTERM')
    } catch {}
    update(task, { detail: '暂停中：正在停止当前步骤…' })
    return publicTask(task, true)
  }
  throw httpErr(400, `任务状态为 ${task.status}，无法暂停`)
}

export function resumeById(taskId, why = '手动恢复') {
  const task = tasksById.get(taskId)
  if (!task) throw httpErr(404, '任务不存在')
  if (task.status !== 'paused') throw httpErr(400, `任务状态为 ${task.status}，无需恢复`)
  task.pauseRequested = false
  task.waitSglang = false
  task.waitGpu = false
  task.llmAbort = undefined
  update(task, { status: 'queued', detail: `${why}，重新排队` })
  queue.push(task)
  runNext()
  return publicTask(task, true)
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
    // 过程数据：classroom 课节目录原始响应落盘，供逐字稿页查看（已存在则不重复拉）
    const classroomFile = path.join(dir, 'classroom_sessions.json')
    if (!fs.existsSync(classroomFile) && task.courseId) {
      try {
        const raw = await fetchCourseSessionsRaw(task.courseId)
        fs.writeFileSync(classroomFile, JSON.stringify(raw))
        appendLog(task, '已保存 classroom 课节目录原始响应')
      } catch (e) {
        appendLog(task, `classroom 原始响应获取失败（不影响主流程）: ${e.message}`)
      }
    }

    // 2. 下载回放视频。音频/ASR 产物已就绪时视频无用，直接跳过
    setStep('download', '下载回放视频')
    const videoPath = path.join(dir, 'video.mp4')
    const audioPath = path.join(dir, 'audio.wav')
    const audioOk = fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1e6
    const blocksExist = fs.existsSync(path.join(dir, 'blocks.json'))
    if (!audioOk && !blocksExist) {
      if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 1e6) {
        update(task, { detail: `复用已下载的视频 (${(fs.statSync(videoPath).size / 1e6).toFixed(0)} MB)` })
      } else {
        await downloadVideo(task.videoUrl, videoPath, task)
      }

      // 3. 抽音频。写 .part 成功后改名：暂停杀掉 ffmpeg 不会留下半截文件被误复用
      setStep('audio', 'ffmpeg 抽取 16kHz 单声道音频')
      const tmpPath = `${audioPath}.part`
      // -f wav 必须显式指定：.part 临时名没有扩展名，ffmpeg 无法推断输出格式
      await run('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', tmpPath], task)
      fs.renameSync(tmpPath, audioPath)
    }

    // 转码完成后原视频不再被流水线使用：删除释放空间
    if (fs.existsSync(videoPath)) {
      const mb = (fs.statSync(videoPath).size / 1e6).toFixed(0)
      fs.rmSync(videoPath, { force: true })
      fs.rmSync(`${videoPath}.part`, { force: true })
      update(task, { detail: `已删除原视频，释放 ${mb} MB 空间` })
    }

    // 4. VAD + ASR + 后处理（python 子进程，轮询 progress.json）
    // blocks.json 已产出（标点完成）时整段跳过：暂停/恢复重入时不必再加载模型
    if (fs.existsSync(path.join(dir, 'blocks.json'))) {
      update(task, { detail: 'ASR 阶段已有产物（blocks.json），直接复用' })
    } else {
      // GPU 与 sglang 互斥：sglang 在线时显存不够加载 ASR 模型（~19GB），挂起等待
      if (task.pauseRequested) throw httpErr(499, '已请求暂停')
      if (await sglangUp()) {
        if (task.pauseRequested) throw httpErr(499, '已请求暂停')
        task.waitGpu = true
        armSglangWatcher()
        update(task, {
          status: 'paused',
          stepId: 'vad',
          detail: '等待 GPU：sglang 正在占用显卡。停止 sglang 后会自动继续，也可手动恢复',
        })
        return
      }
      setStep('vad', '加载模型，VAD 切段', { done: 0, total: 0 })
      const pyArgs = [PIPELINE_PY, '--workdir', dir]
      if (ASR_MAX_SEGMENTS > 0) pyArgs.push('--max-segments', String(ASR_MAX_SEGMENTS))
      await new Promise((resolve, reject) => {
        // fireredasr2s 在 FIRERED_ROOT 下，python 只把脚本目录放进 sys.path，需显式 PYTHONPATH
        const child = spawn(CONDA_PYTHON, pyArgs, {
          cwd: FIRERED_ROOT,
          env: { ...process.env, PYTHONPATH: FIRERED_ROOT },
        })
        task.child = child
        let errTail = ''
        child.stderr.on('data', (d) => {
          errTail = (errTail + d).slice(-4000)
        })
        // python 的 stdout（[vad] 打点、段数统计等）逐行进任务日志
        let outBuf = ''
        child.stdout.on('data', (d) => {
          outBuf += d
          const lines = outBuf.split('\n')
          outBuf = lines.pop()
          for (const line of lines) {
            if (line.trim()) appendLog(task, line.trim())
          }
        })
        const timer = setInterval(() => {
          try {
            const p = JSON.parse(fs.readFileSync(path.join(dir, 'progress.json'), 'utf-8'))
            if (p.step === 'vad' || p.step === 'asr' || p.step === 'punc') {
              const patch = { stepId: p.step, progress: { done: p.done, total: p.total } }
              if (p.detail) patch.detail = p.detail
              update(task, patch)
            }
          } catch {}
        }, 3000)
        child.on('error', (e) => {
          clearInterval(timer)
          task.child = undefined
          reject(e)
        })
        child.on('close', (code) => {
          clearInterval(timer)
          task.child = undefined
          if (outBuf.trim()) appendLog(task, outBuf.trim())
          if (code === 0) resolve()
          else reject(httpErr(500, `ASR 阶段失败（退出码 ${code}）\n${errTail.slice(-1200)}`))
        })
      })
    }

    // 5. PPT 列表 + 适当选择 + 下载
    if (task.pauseRequested) throw httpErr(499, '已请求暂停')
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

    // 6. LLM 生成逐字稿（GPU 与 ASR 互斥：sglang 未在线则挂起任务等待）
    if (task.pauseRequested) throw httpErr(499, '已请求暂停')
    if (!(await sglangUp())) {
      // 探测期间用户可能点了暂停：手动暂停优先于「等待 sglang」
      if (task.pauseRequested) throw httpErr(499, '已请求暂停')
      task.waitSglang = true
      armSglangWatcher()
      update(task, {
        status: 'paused',
        stepId: 'llm',
        detail: '等待 sglang：服务未在线。启动 sglang 后会自动继续，也可手动恢复',
      })
      return
    }
    setStep('llm', '分段生成逐字稿（先规划分段，再逐段整理）', { done: 0, total: 0 })
    const blocks = JSON.parse(fs.readFileSync(path.join(dir, 'blocks.json'), 'utf-8'))
    task.llmAbort = new AbortController()
    const markdown = await generateTranscript(task, blocks, selected, task.llmAbort.signal)
    task.llmAbort = undefined
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
    if (task.pauseRequested) {
      update(task, { status: 'paused', detail: '已暂停，恢复后从断点继续' })
    } else {
      update(task, {
        status: 'error',
        error: e.message?.slice(0, 2000) || String(e),
        finishedAt: Date.now(),
      })
    }
  } finally {
    task.pauseRequested = false
    task.child = undefined
    running = false
    runNext()
  }
}

// Promise 化的子进程调用，失败时带 stderr 尾部；task 用于暂停时终止子进程
function run(cmd, args, task) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    if (task) task.child = child
    let errTail = ''
    child.stderr.on('data', (d) => {
      errTail = (errTail + d).slice(-4000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (task) task.child = undefined
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

// ---------- 过程性数据（按需读取，不塞进任务对象/SSE） ----------

const ARTIFACTS = {
  asr_raw: { file: 'asr_all.jsonl', label: 'ASR 原始分段' },
  blocks: { file: 'blocks.json', label: 'ASR 文本块（滤碎合并+标点后）' },
  classroom: { file: 'classroom_sessions.json', label: 'classroom 课节目录原始响应' },
}

export async function getTaskArtifact(taskId, name) {
  const spec = ARTIFACTS[name]
  if (!spec) throw httpErr(404, `未知的过程数据: ${name}`)
  const task = tasksById.get(taskId) || (getTaskRow(taskId) ? restoreTask(getTaskRow(taskId)) : null)
  if (!task) throw httpErr(404, '任务不存在')
  const file = path.join(jobDir(task), spec.file)
  if (!fs.existsSync(file)) {
    // 旧任务没落盘过 classroom 原始响应：现场补拉一次并留档，其余产物只能等对应阶段跑过
    if (name === 'classroom' && task.courseId) {
      try {
        const raw = await fetchCourseSessionsRaw(task.courseId)
        fs.writeFileSync(file, JSON.stringify(raw))
      } catch (e) {
        throw httpErr(502, `classroom 原始响应获取失败: ${e.message}`)
      }
    } else {
      throw httpErr(404, `${spec.label}尚未生成`)
    }
  }
  return {
    name,
    kind: spec.file.endsWith('.jsonl') ? 'jsonl' : 'json',
    content: fs.readFileSync(file, 'utf-8'),
  }
}
