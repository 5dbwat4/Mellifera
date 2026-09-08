import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

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

// 同一课时复用同一任务；GPU 任务串行
const jobsBySub = new Map()
const jobsById = new Map()
const queue = []
let running = false

function httpErr(status, message) {
  return Object.assign(new Error(message), { status })
}

const mmss = (sec) => {
  const s = Math.max(0, Math.floor(sec))
  return `[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]`
}

function jobDir(job) {
  return path.join(WORKDIR, `${job.courseId}_${job.subId}`)
}

function persist(job) {
  try {
    fs.mkdirSync(jobDir(job), { recursive: true })
    fs.writeFileSync(path.join(jobDir(job), 'job.json'), JSON.stringify(job, null, 2))
  } catch {}
}

function update(job, patch) {
  Object.assign(job, patch)
  persist(job)
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

// 下载回放视频，期间轮询文件大小更新 detail
function downloadVideo(url, dest, job) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['-fSL', '--retry', '5', '--retry-all-errors', '-o', dest, url])
    let errTail = ''
    child.stderr.on('data', (d) => {
      errTail = (errTail + d).slice(-2000)
    })
    const timer = setInterval(() => {
      try {
        const mb = fs.statSync(dest).size / 1e6
        update(job, { detail: `已下载 ${mb.toFixed(0)} MB` })
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

async function runJob(job) {
  const dir = jobDir(job)
  fs.mkdirSync(dir, { recursive: true })
  const setStep = (step, detail, progress = null) => update(job, { status: 'running', step, detail, progress })

  try {
    // 1. 解析课时
    setStep('meta', '解析课时信息')
    const { items } = await fetchCourseSessions(job.courseId)
    const session = items.find((s) => s.subId === job.subId)
    if (!session) throw httpErr(404, `课时 ${job.subId} 在课程 ${job.courseId} 中不存在`)
    if (!session.playbackUrl) throw httpErr(400, '该课节没有回放视频，无法生成逐字稿')
    update(job, { title: session.title })

    // 2. 下载回放视频（已存在则跳过，支持断点续跑）
    setStep('download', '下载回放视频')
    const videoPath = path.join(dir, 'video.mp4')
    if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 1e6) {
      update(job, { detail: `复用已下载的视频 (${(fs.statSync(videoPath).size / 1e6).toFixed(0)} MB)` })
    } else {
      await downloadVideo(session.playbackUrl, videoPath, job)
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
            update(job, { step: p.step, progress: { done: p.done, total: p.total }, detail: p.detail })
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
    const pptList = await fetchSessionPpt(job.courseId, job.subId)
    const selected = selectPpt(pptList, PPT_MAX)
    const pptDir = path.join(dir, 'ppt')
    fs.mkdirSync(pptDir, { recursive: true })
    for (let i = 0; i < selected.length; i++) {
      const file = path.join(pptDir, `ppt_${String(i + 1).padStart(2, '0')}.jpg`)
      await downloadTo(selected[i].url, file)
      selected[i].file = file
      update(job, { detail: `下载 PPT ${i + 1}/${selected.length}` })
    }

    // 6. LLM 生成逐字稿（文本片段 + PPT 图进上下文）
    setStep('llm', `SGLang 生成逐字稿（${selected.length} 张 PPT 进上下文）`)
    const blocks = JSON.parse(fs.readFileSync(path.join(dir, 'blocks.json'), 'utf-8'))
    const markdown = await generateTranscript(blocks, selected)
    fs.writeFileSync(path.join(dir, 'transcript_final.md'), markdown)

    update(job, {
      status: 'done',
      step: 'done',
      detail: '完成',
      finishedAt: Date.now(),
      result: { markdown, blocksCount: blocks.length, pptCount: selected.length },
    })
  } catch (e) {
    update(job, {
      status: 'error',
      error: e.message?.slice(0, 2000) || String(e),
      finishedAt: Date.now(),
    })
  } finally {
    running = false
    runNext()
  }
}

function runNext() {
  if (running || queue.length === 0) return
  const job = queue.shift()
  running = true
  runJob(job)
}

export function createTranscriptJob(courseId, subId, force = false) {
  const existing = jobsBySub.get(subId)
  if (existing && existing.status !== 'error' && !force) return existing

  // 之前成功过的任务直接从磁盘恢复（后端重启后不重跑）
  const dir = path.join(WORKDIR, `${courseId}_${subId}`)
  if (!force) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf-8'))
      if (saved.status === 'done' && saved.result?.markdown) {
        jobsBySub.set(subId, saved)
        jobsById.set(saved.jobId, saved)
        return saved
      }
    } catch {}
  }

  const job = {
    jobId: crypto.randomBytes(8).toString('hex'),
    courseId,
    subId,
    title: '',
    status: 'queued',
    step: '',
    progress: null,
    detail: '排队等待中（GPU 任务串行）',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    result: null,
  }
  jobsBySub.set(subId, job)
  jobsById.set(job.jobId, job)
  persist(job)
  queue.push(job)
  runNext()
  return job
}

export function getTranscriptJob(jobId) {
  return jobsById.get(jobId) || null
}
