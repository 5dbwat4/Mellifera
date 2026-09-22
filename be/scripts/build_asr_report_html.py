#!/usr/bin/env python3
"""组装 ASR 质量对比报告（HTML 版，符合 /opt/reports/AGENTS.md 约定：单文件 + Tailwind/ECharts CDN）。"""
import json
import os
import re
from datetime import date

SRC = '/opt/5db-proj/mellifera/be/tmp/asr_compare_86009_1966305.md'
DST_DIR = '/opt/reports'
COURSE_ID, SUB_ID = '86009', '1966305'

src = open(SRC, encoding='utf-8').read()

# ---- 解析分窗口表 ----
windows = []
m = re.search(r'## 分窗口 CER.*?\n\| --- \|.*?\n(.*?)\n\n', src, re.S)
for line in (m.group(1).split('\n') if m else []):
    cells = [c.strip() for c in line.strip('|').split('|')]
    if len(cells) >= 5 and cells[0].startswith('['):
        windows.append({
            'range': cells[0],
            'off': int(cells[1]),
            'our': int(cells[2]),
            'cer1': float(cells[3].rstrip('%')),
            'cer2': float(cells[4].rstrip('%')),
        })

# ---- 解析抽样 ----
def parse_samples(section):
    m = re.search(re.escape(section) + r'\n(.*?)(?=\n### |\Z)', src, re.S)
    out = {}
    for chunk in re.split(r'\n\*\*', m.group(1))[1:] if m else []:
        mm = re.match(r'\[(\d+:\d+)\]\*\*\s*\n+```\n(.*?)\n```', chunk, re.S)
        if mm:
            out[mm.group(1)] = mm.group(2).strip()
    return out

off_s = parse_samples('### 官方字幕')
our_s = parse_samples('### mellifera（文本块）')
times = sorted(set(off_s) | set(our_s), key=lambda t: int(t.split(':')[0]) * 60 + int(t.split(':')[1]))

sample_blocks = []
for t in times:
    esc = lambda s: (s or '（无）').replace('&', '&amp;').replace('<', '&lt;')
    sample_blocks.append(f'''
    <details class="group rounded-xl border border-gray-200 bg-white open:shadow-sm">
      <summary class="cursor-pointer list-none px-4 py-3 text-sm font-medium text-gray-700 flex items-center justify-between">
        <span>时间点 <span class="font-mono text-indigo-600">{t}</span></span>
        <span class="text-xs text-gray-400 group-open:hidden">展开对照 ▾</span>
        <span class="hidden text-xs text-gray-400 group-open:inline">收起 ▴</span>
      </summary>
      <div class="grid gap-3 px-4 pb-4 md:grid-cols-2">
        <div class="rounded-lg bg-indigo-50/60 p-3">
          <p class="mb-1 text-xs font-semibold text-indigo-700">官方字幕</p>
          <pre class="whitespace-pre-wrap text-xs leading-relaxed text-gray-700">{esc(off_s.get(t))}</pre>
        </div>
        <div class="rounded-lg bg-emerald-50/60 p-3">
          <p class="mb-1 text-xs font-semibold text-emerald-700">mellifera（文本块）</p>
          <pre class="whitespace-pre-wrap text-xs leading-relaxed text-gray-700">{esc(our_s.get(t))}</pre>
        </div>
      </div>
    </details>''')

chart_data = json.dumps(windows, ensure_ascii=False)

# ---- 全量左右对照：1 分钟窗口对齐官方字幕与我们的文本块 ----
FULL_W = 60
full_path = f'/opt/5db-proj/mellifera/be/tmp/asr_full_{COURSE_ID}_{SUB_ID}.json'
full_rows_html = ''
full_note = '<p class="text-xs text-red-500">全量数据文件缺失：请先运行 <code>node scripts/compare_asr.js</code> 重新生成。</p>'
if os.path.exists(full_path):
    full = json.load(open(full_path, encoding='utf-8'))
    esc2 = lambda s: s.replace('&', '&amp;').replace('<', '&lt;')
    dur = max(max(x['sec'] for x in full['official']), max(x['sec'] for x in full['blocks']))
    n_off = n_our = 0
    body = []
    for lo in range(0, int(dur) + FULL_W, FULL_W):
        hi = lo + FULL_W
        mm = lambda s: f'{s // 60:02d}:{s % 60:02d}'
        off = [f"{mm(int(x['sec']))} {x['text']}" for x in full['official'] if lo <= x['sec'] < hi]
        our = [f"{mm(int(x['sec']))} {x['text']}" for x in full['blocks'] if lo <= x['sec'] < hi]
        if not off and not our:
            continue
        n_off += len(off)
        n_our += len(our)
        body.append(f'''
        <div class="grid grid-cols-[70px_1fr_1fr] gap-2 border-b border-gray-100 px-3 py-2 text-xs leading-relaxed hover:bg-indigo-50/40">
          <div class="font-mono text-[11px] text-gray-400">{mm(lo)}-{mm(hi)}</div>
          <div class="whitespace-pre-wrap text-gray-700">{esc2(chr(10).join(off)) or '<span class="text-gray-300">（无）</span>'}</div>
          <div class="whitespace-pre-wrap text-gray-700">{esc2(chr(10).join(our)) or '<span class="text-gray-300">（无）</span>'}</div>
        </div>''')
    full_rows_html = f'''
      <div class="grid grid-cols-[70px_1fr_1fr] gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-500 sticky top-0">
        <div>时间窗</div><div>官方字幕（{n_off} 条）</div><div>mellifera 文本块（{n_our} 块）</div>
      </div>
      {''.join(body)}'''
    full_note = f'<p class="text-xs text-gray-400">按 1 分钟窗口对齐，共 {len(body)} 个窗口；官方 {n_off} 条 vs 我们 {n_our} 块。行内左右对照，灰色“（无）”表示该侧在此窗口无内容。</p>'

HTML = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ASR 质量对比报告：Mellifera vs 智云课堂官方（__COURSE___ __SUB__）</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
</head>
<body class="bg-gray-50 text-gray-800 antialiased">
<div class="mx-auto max-w-5xl px-6 py-10">

  <header class="mb-8">
    <h1 class="text-3xl font-bold tracking-tight text-gray-900">ASR 质量对比报告</h1>
    <p class="mt-1 text-lg text-gray-500">Mellifera 自建 ASR vs 智云课堂官方字幕</p>
    <div class="mt-4 flex flex-wrap gap-2 text-xs">
      <span class="rounded-full bg-white px-3 py-1 ring-1 ring-gray-200">课程 __COURSE__ · 课节 __SUB__</span>
      <span class="rounded-full bg-white px-3 py-1 ring-1 ring-gray-200">2026-09-14 第 3-4 节 · 音频 108.9 分钟</span>
      <span class="rounded-full bg-white px-3 py-1 ring-1 ring-gray-200">报告日期 __DATE__</span>
    </div>
  </header>

  <!-- 结论摘要卡片 -->
  <section class="mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <div class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
      <p class="text-xs text-gray-500">全文互相分歧度（CER）</p>
      <p class="mt-2 text-3xl font-bold text-gray-900">19.5%</p>
      <p class="mt-1 text-xs text-gray-400">双向对称 19.5% / 19.4%</p>
    </div>
    <div class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
      <p class="text-xs text-gray-500">语音覆盖度（字数比）</p>
      <p class="mt-2 text-3xl font-bold text-emerald-600">100.2%</p>
      <p class="mt-1 text-xs text-gray-400">无系统性多转 / 漏转</p>
    </div>
    <div class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
      <p class="text-xs text-gray-500">正文主体窗口分歧</p>
      <p class="mt-2 text-3xl font-bold text-gray-900">12.8–33.9%</p>
      <p class="mt-1 text-xs text-gray-400">最优窗口 [10:00-20:00] 约 13%</p>
    </div>
    <div class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
      <p class="text-xs text-gray-500">LLM 成品 vs 官方</p>
      <p class="mt-2 text-3xl font-bold text-gray-900">19.7%</p>
      <p class="mt-1 text-xs text-gray-400">字数 91.5%（语气词清理 + PPT 纠错）</p>
    </div>
  </section>

  <section class="mb-10 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
    <h2 class="mb-4 text-lg font-semibold text-gray-900">一、分窗口分歧度与转写量</h2>
    <div id="chartCer" class="h-80"></div>
    <div id="chartChars" class="mt-6 h-72"></div>
    <p class="mt-4 text-xs leading-relaxed text-gray-400">
      左图：每个 10 分钟窗口内两份转写的互相 CER（柱越高分歧越大）。右图：同窗口的归一化字数对比（两条曲线越贴合，说明覆盖越一致）。
      [100:00-110:00] 官方仅 181 字 vs 我们 276 字，属下课前的零散话语，小样本导致指标失真，仅供参考。
    </p>
  </section>

  <section class="mb-10 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
    <h2 class="mb-4 text-lg font-semibold text-gray-900">二、总量统计</h2>
    <table class="w-full text-sm">
      <thead><tr class="border-b border-gray-200 text-left text-xs text-gray-500">
        <th class="py-2">来源</th><th class="py-2">条数</th><th class="py-2">归一化字数</th><th class="py-2">字数比（相对官方）</th>
      </tr></thead>
      <tbody class="divide-y divide-gray-100">
        <tr><td class="py-2">官方字幕</td><td class="py-2">1932</td><td class="py-2">16881</td><td class="py-2">100%</td></tr>
        <tr><td class="py-2">mellifera 原始分段（asr_all）</td><td class="py-2">2095</td><td class="py-2">16912</td><td class="py-2">100.2%</td></tr>
        <tr><td class="py-2">mellifera 文本块（blocks，滤碎合并+标点）</td><td class="py-2">410</td><td class="py-2">16248</td><td class="py-2">96.3%</td></tr>
        <tr><td class="py-2">mellifera 成品（transcript_final，LLM 纠错）</td><td class="py-2">—</td><td class="py-2">15447</td><td class="py-2">91.5%</td></tr>
      </tbody>
    </table>
  </section>

  <section class="mb-10 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
    <h2 class="mb-4 text-lg font-semibold text-gray-900">三、分歧性质分析</h2>
    <ol class="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-gray-700">
      <li><b>覆盖边界不同（结构性差异）</b>：官方压制课前闲聊与非授课段，我们的 VAD"有语音就转"。00:00-01:00 官方无字幕，我们转出了开场前的远场对话——开头十分钟分歧偏高（27.8%）主要源于此，而非识别质量问题。</li>
      <li><b>语气词处理</b>：成品阶段清理"嗯、呃、啊"等填充词，成品字数为官方的 91.5%。</li>
      <li><b>术语纠错</b>：成品以 PPT 截图为权威依据修正同音/近音误听（官方无课件对照能力，此类错误官方同样存在），成品 CER 19.7% 与原始层持平，说明纠错未引入额外失真。</li>
      <li><b>碎段过滤</b>：blocks 阶段丢弃时长 &lt;1s 且 ≤2 字的碎段（约 3.7% 字数），多为咳嗽、翻书声误转写。</li>
      <li><b>关于互为基准的两个 CER</b>：编辑距离对称而分母不同，19.5% / 19.4% 的微小差来自两边字数差（16881 vs 16912）。两者几乎重合本身就是旁证：分歧是逐字替换错，而非整段缺失或多余。</li>
    </ol>
  </section>

  <section class="mb-10 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
    <h2 class="mb-2 text-lg font-semibold text-gray-900">四、逐时点并排抽样对照</h2>
    <p class="mb-4 text-xs text-gray-400">每 15 分钟取 1 分钟窗口。判定谁对谁错需对照音频人工复核，重点推荐分歧最高的 [50:00-60:00] 窗口。</p>
    <div class="flex flex-col gap-3">__SAMPLES__</div>
  </section>

  <section class="mb-10 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
    <h2 class="mb-4 text-lg font-semibold text-gray-900">五、方法与局限</h2>
    <ul class="list-disc space-y-2 pl-5 text-sm leading-relaxed text-gray-700">
      <li>CER =（替换+删除+插入字符数）/ 基准字符数，基于编辑距离计算，统计前已归一化去除标点与空白。</li>
      <li><b>没有人工转写基准</b>：官方字幕同样是机器 ASR。CER 只衡量分歧度，不代表我方错误率。</li>
      <li>按 10 分钟时间窗口切分后分别拼接计算，不做句级强制对齐；两侧时间戳均以视频起点为原点。</li>
      <li>小样本窗口（字数过少）CER 波动大，仅供参考。</li>
    </ul>
  </section>

  <details class="mb-10 rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
    <summary class="cursor-pointer list-none px-6 py-5 flex items-center justify-between">
      <span class="text-lg font-semibold text-gray-900">六、全量左右对照</span>
      <span class="text-xs text-gray-400">点击展开全部分钟级对照（内容较长）▾</span>
    </summary>
    <div class="px-6 pb-6">
      __FULLNOTE__
      <div class="mt-3 max-h-[70vh] overflow-auto rounded-xl border border-gray-200">__FULLROWS__</div>
    </div>
  </details>

  <footer class="pb-6 text-xs text-gray-400">
    数据来源：智云课堂官方字幕接口（search-trans-result）与 Mellifera 流水线产物 · 原始对比数据
    <code>/opt/5db-proj/mellifera/be/tmp/asr_compare___COURSE______SUB__.md</code> ·
    复现：<code>node scripts/compare_asr.js __COURSE__ __SUB__</code> 后运行
    <code>python3 scripts/build_asr_report_html.py</code>
  </footer>
</div>

<script>
const windows = __WINDOWS__;
const cer1 = echarts.init(document.getElementById('chartCer'));
cer1.setOption({
  tooltip: { trigger: 'axis', valueFormatter: v => v + '%' },
  legend: { data: ['官方为基准→我们', '我们为基准→官方'] },
  grid: { left: 50, right: 20, top: 40, bottom: 60 },
  xAxis: { type: 'category', data: windows.map(w => w.range), axisLabel: { rotate: 40, fontSize: 10 } },
  yAxis: { type: 'value', axisLabel: { formatter: '{value}%' } },
  series: [
    { name: '官方为基准→我们', type: 'bar', data: windows.map(w => w.cer1), itemStyle: { color: '#6366f1' } },
    { name: '我们为基准→官方', type: 'bar', data: windows.map(w => w.cer2), itemStyle: { color: '#a5b4fc' } },
  ],
});
const chars = echarts.init(document.getElementById('chartChars'));
chars.setOption({
  tooltip: { trigger: 'axis' },
  legend: { data: ['官方字数', 'mellifera 字数'] },
  grid: { left: 60, right: 20, top: 40, bottom: 60 },
  xAxis: { type: 'category', data: windows.map(w => w.range), axisLabel: { rotate: 40, fontSize: 10 } },
  yAxis: { type: 'value' },
  series: [
    { name: '官方字数', type: 'line', smooth: true, data: windows.map(w => w.off), itemStyle: { color: '#6366f1' } },
    { name: 'mellifera 字数', type: 'line', smooth: true, data: windows.map(w => w.our), itemStyle: { color: '#10b981' } },
  ],
});
window.addEventListener('resize', () => { cer1.resize(); chars.resize(); });
</script>
</body>
</html>'''

html = (HTML
        .replace('__SAMPLES__', '\n'.join(sample_blocks))
        .replace('__WINDOWS__', chart_data)
        .replace('__FULLROWS__', full_rows_html)
        .replace('__FULLNOTE__', full_note)
        .replace('__DATE__', date.today().isoformat())
        .replace('__COURSE__', COURSE_ID)
        .replace('__SUB__', SUB_ID))

os.makedirs(DST_DIR, exist_ok=True)
dst = os.path.join(DST_DIR, f'ASR质量对比报告_{COURSE_ID}_{SUB_ID}.html')
with open(dst, 'w', encoding='utf-8') as f:
    f.write(html)
print('报告已写入:', dst, f'({len(html)} bytes, {len(windows)} windows, {len(sample_blocks)} samples)')
