// 对比 mellifera ASR 与智云课堂官方字幕的质量差异
// 用法: node scripts/compare_asr.js [courseId] [subId]   （在 be/ 目录下运行）
// 输出: tmp/asr_compare_<courseId>_<subId>.md
//
// 对比三层 mellifera 产物：
//   asr_all.jsonl        原始逐段转写（和官方同层级，最公平）
//   blocks.json          滤碎/合并/标点后
//   transcript_final.md  LLM 结合 PPT 纠错后的成品（若有）
// 指标：分时间窗口的字符错误率 CER（互为基准各算一次）、字数比、并排抽样。
// 注意：官方字幕同样是机器 ASR、也有错，CER 差异只代表"分歧度"，需要结合抽样人工判断谁对。
import fs from 'node:fs'
import path from 'node:path'
import { CLASSROOM, ZJUAM } from 'login-zju'

const envPath = path.resolve(import.meta.dirname, '../../.env')
for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^"(.*)"$/, '$1')
}

const courseId = process.argv[2] || '86009'
const subId = process.argv[3] || '1966305'
const workdir = process.env.TRANSCRIPT_WORKDIR || '/opt/test2/mellifera'
const jobDir = path.join(workdir, `${courseId}_${subId}`)
const BUCKET = 600 // CER 统计窗口：10 分钟

const pad = (n) => n.toString().padStart(2, '0')
const mmss = (sec) => `[${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}]`

const classroom = new CLASSROOM(new ZJUAM(process.env.ZJU_USERNAME, process.env.ZJU_PASSWORD))

// ---------- 1. 官方字幕 ----------
console.log('拉取官方字幕...')
const transRes = await classroom
  .fetch(`https://yjapi.cmc.zju.edu.cn/courseapi/v3/web-socket/search-trans-result?sub_id=${subId}&format=json`)
  .then((r) => r.json())
const official = []
for (const item of transRes.list || []) {
  for (const c of item.all_content || []) {
    const text = (c.Text || '').trim()
    if (text) official.push({ sec: Number(c.BeginSec || 0), text })
  }
}
official.sort((a, b) => a.sec - b.sec)
if (!official.length) {
  console.error('该课节没有官方字幕（可能平台未生成）')
  process.exit(1)
}

// ---------- 2. 我们的产物 ----------
const asrRaw = fs
  .readFileSync(path.join(jobDir, 'asr_all.jsonl'), 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .map((r) => ({ sec: r.start, text: r.text || '' }))
const blocks = JSON.parse(fs.readFileSync(path.join(jobDir, 'blocks.json'), 'utf-8')).map((b) => ({
  sec: b.start,
  text: b.text || '',
}))
let finalText = ''
const finalFile = path.join(jobDir, 'transcript_final.md')
if (fs.existsSync(finalFile)) {
  finalText = fs
    .readFileSync(finalFile, 'utf-8')
    .split('\n')
    .filter((l) => !l.startsWith('#')) // 去掉章节标题行
    .map((l) => l.replace(/\[\d+:\d+\]\s*/g, '')) // 去掉句首时间戳
    .join('\n')
}

// ---------- 3. 指标 ----------
const norm = (s) => s.replace(/[\s，。、；：？！,.:;?!“”‘’"'"()（）[\]【】《》<>…—·\-～~]/g, '')

function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = new Array(b.length + 1)
  let cur = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length]
}

// CER：hyp 相对 ref 的字符错误率（归一化标点空白后）
function cer(refText, hypText) {
  const ref = norm(refText)
  const hyp = norm(hypText)
  if (!ref.length) return null
  return levenshtein(ref, hyp) / ref.length
}

const inRange = (items, lo, hi) => items.filter((x) => x.sec >= lo && x.sec < hi).map((x) => x.text).join('')
const concatText = (items) => items.map((x) => x.text).join('')

const duration = Math.max(
  official[official.length - 1].sec,
  asrRaw[asrRaw.length - 1]?.sec || 0,
  blocks[blocks.length - 1]?.sec || 0
)

// 全文 CER
const globalOff = concatText(official)
const globalRaw = concatText(asrRaw)
const globalBlocks = concatText(blocks)
const stats = {
  officialChars: norm(globalOff).length,
  rawChars: norm(globalRaw).length,
  blocksChars: norm(globalBlocks).length,
  cerRawVsOff: cer(globalOff, globalRaw),
  cerOffVsRaw: cer(globalRaw, globalOff),
  cerBlocksVsOff: cer(globalOff, globalBlocks),
  cerFinalVsOff: finalText ? cer(globalOff, finalText) : null,
}

// 分窗口 CER
const windowRows = []
for (let lo = 0; lo < duration; lo += BUCKET) {
  const hi = lo + BUCKET
  const off = inRange(official, lo, hi)
  const raw = inRange(asrRaw, lo, hi)
  if (!norm(off).length && !norm(raw).length) continue
  windowRows.push({
    range: `${mmss(lo)}-${mmss(hi)}`,
    offChars: norm(off).length,
    rawChars: norm(raw).length,
    cerRawVsOff: cer(off, raw),
    cerOffVsRaw: cer(raw, off),
  })
}

// 并排抽样：每 15 分钟取窗口 ±30s
const SAMPLE_STEP = 900
const samples = []
for (let t = 0; t < duration; t += SAMPLE_STEP) {
  const off = official.filter((x) => x.sec >= t && x.sec < t + 60).map((x) => `${mmss(x.sec)} ${x.text}`)
  const ours = blocks.filter((x) => x.sec >= t && x.sec < t + 60).map((x) => `${mmss(x.sec)} ${x.text}`)
  if (!off.length && !ours.length) continue
  samples.push({ at: mmss(t), off: off.join('\n') || '（无）', ours: ours.join('\n') || '（无）' })
}

const pct = (v) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)

// ---------- 4. 报告 ----------
const lines = []
lines.push(`# ASR 质量对比：mellifera vs 智云课堂官方`)
lines.push('')
lines.push(`- 课节：${courseId}_${subId}`)
lines.push(`- 对比时长范围：${mmss(0)} - ${mmss(duration)}`)
lines.push('')
lines.push(`## 总量统计`)
lines.push('')
lines.push(`| 来源 | 条数 | 归一化字数 | 字数比（相对官方） |`)
lines.push(`| --- | --- | --- | --- |`)
lines.push(`| 官方字幕 | ${official.length} | ${stats.officialChars} | 100% |`)
lines.push(`| mellifera 原始分段 (asr_all) | ${asrRaw.length} | ${stats.rawChars} | ${((stats.rawChars / stats.officialChars) * 100).toFixed(1)}% |`)
lines.push(`| mellifera 文本块 (blocks) | ${blocks.length} | ${stats.blocksChars} | ${((stats.blocksChars / stats.officialChars) * 100).toFixed(1)}% |`)
if (finalText) lines.push(`| mellifera 成品 (transcript_final) | — | ${norm(finalText).length} | ${((norm(finalText).length / stats.officialChars) * 100).toFixed(1)}% |`)
lines.push('')
lines.push(`## 字符错误率 CER（归一化标点后）`)
lines.push('')
lines.push(`| 对比 | CER | 说明 |`)
lines.push(`| --- | --- | --- |`)
lines.push(`| 官方为基准 → 原始分段 | ${pct(stats.cerRawVsOff)} | 同层级最公平的分歧度 |`)
lines.push(`| 原始分段为基准 → 官方 | ${pct(stats.cerOffVsRaw)} | 反向分歧度 |`)
lines.push(`| 官方为基准 → 文本块 | ${pct(stats.cerBlocksVsOff)} | 滤碎/合并不应改变内容，理论接近上行 |`)
if (finalText) lines.push(`| 官方为基准 → LLM 成品 | ${pct(stats.cerFinalVsOff)} | 高于原始属预期：PPT 纠错在修正官方也有的错 |`)
lines.push('')
lines.push(`> 注意：官方字幕也是机器 ASR，同样有错。CER 只衡量分歧度，谁对谁错需看抽样对照。`)
lines.push('')
lines.push(`## 分窗口 CER（每 ${BUCKET / 60} 分钟）`)
lines.push('')
lines.push(`| 时间窗 | 官方字数 | 我们字数 | 官方为基准→我们 | 我们为基准→官方 |`)
lines.push(`| --- | --- | --- | --- | --- |`)
for (const w of windowRows) {
  lines.push(`| ${w.range} | ${w.offChars} | ${w.rawChars} | ${pct(w.cerRawVsOff)} | ${pct(w.cerOffVsRaw)} |`)
}
lines.push('')
lines.push(`## 抽样对照（每 15 分钟取 1 分钟窗口）`)
lines.push('')
lines.push(`### 官方字幕`)
for (const s of samples) {
  lines.push('')
  lines.push(`**${s.at}**`)
  lines.push('```')
  lines.push(s.off)
  lines.push('```')
}
lines.push('')
lines.push(`### mellifera（文本块）`)
for (const s of samples) {
  lines.push('')
  lines.push(`**${s.at}**`)
  lines.push('```')
  lines.push(s.ours)
  lines.push('```')
}

const outDir = path.resolve(import.meta.dirname, '../tmp')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, `asr_compare_${courseId}_${subId}.md`)
fs.writeFileSync(outFile, lines.join('\n'), 'utf-8')

// 全量数据落盘，供报告构建器渲染逐分钟左右对照
fs.writeFileSync(
  path.join(outDir, `asr_full_${courseId}_${subId}.json`),
  JSON.stringify({ official, blocks })
)

console.log(`官方字幕 ${official.length} 条 / 我们原始 ${asrRaw.length} 段`)
console.log(`全文 CER：官方为基准→原始分段 ${pct(stats.cerRawVsOff)}，反向 ${pct(stats.cerOffVsRaw)}，成品 ${pct(stats.cerFinalVsOff)}`)
console.log('报告已写入:', outFile)
