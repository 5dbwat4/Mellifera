#!/usr/bin/env python3
"""组装 ASR 质量对比正式报告：读取 compare_asr.js 的输出，生成带分析叙述的完整报告到 /opt/reports/。"""
import re
import sys
from datetime import date

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/5db-proj/mellifera/be/tmp/asr_compare_86009_1966305.md'
DST_DIR = '/opt/reports'
COURSE_ID, SUB_ID = '86009', '1966305'

src = open(SRC, encoding='utf-8').read()

def table_between(start, end):
    m = re.search(re.escape(start) + r'\n(.*?)\n' + re.escape(end), src, re.S)
    return m.group(1).strip() if m else ''

stats_table = table_between('## 总量统计', '## 字符错误率')
cer_table = table_between('## 字符错误率', '## 分窗口')
window_table = table_between('## 分窗口', '## 抽样对照')

# 解析抽样：两个小节（官方 / mellifera），按 **[mm:ss]** 配对
def parse_samples(section_title):
    m = re.search(re.escape(section_title) + r'\n(.*?)(?=\n### |\Z)', src, re.S)
    out = {}
    for chunk in re.split(r'\n\*\*', m.group(1))[1:] if m else []:
        mm = re.match(r'\[(\d+:\d+)\]\*\*\s*\n+```\n(.*?)\n```', chunk, re.S)
        if mm:
            out[mm.group(1)] = mm.group(2).strip()
    return out

off_samples = parse_samples('### 官方字幕')
our_samples = parse_samples('### mellifera（文本块）')
times = [t for t in off_samples if t in our_samples] + \
        [t for t in our_samples if t not in off_samples]
times = sorted(set(times), key=lambda t: int(t.split(':')[0]) * 60 + int(t.split(':')[1]))

interleaved = []
for t in times:
    interleaved.append(f'**时间点 {t}**\n')
    interleaved.append('官方字幕：')
    interleaved.append('> ' + (off_samples.get(t, '（无）').replace('\n', '\n> ')))
    interleaved.append('')
    interleaved.append('mellifera（文本块）：')
    interleaved.append('> ' + (our_samples.get(t, '（无）').replace('\n', '\n> ')))
    interleaved.append('')

samples_block = '\n'.join(interleaved)

report = f"""# ASR 质量对比报告：Mellifera 自建 ASR vs 智云课堂官方字幕

- **对比课节**：课程 {COURSE_ID}，课节 {SUB_ID}（2026-09-14 第 3-4 节，音频时长约 108.9 分钟）
- **报告生成日期**：{date.today().isoformat()}
- **数据来源**：智云课堂官方字幕接口（search-trans-result，1932 条）；Mellifera 流水线产物（asr_all.jsonl / blocks.json / transcript_final.md）

---

## 一、结论摘要

1. **语音覆盖度几乎一致**：两边的归一化总字数分别为 16881（官方）与 16912（我们，100.2%），不存在系统性多转/漏转整段内容的情况。
2. **原始转写层的互相分歧约 19.5%**（双向对称：19.5% / 19.4%）。这是两个不同的中文 ASR 系统在远场课堂音频上的典型分歧区间——官方字幕同样是机器转写、同样有错，该数字衡量的是"分歧度"而非"我们错了 19.5%"。
3. **分歧有明显的时间分布特征**：正文主体窗口 12.8% ~ 33.9%；开头十分钟偏高（27.8%），主因是结构性差异——课前闲聊段官方完全不出字、我们的 VAD 从头捡起；结尾窗口小样本失真（181 字对 276 字），指标不可比。
4. **Mellifera 的差异化价值在成品层**：LLM 结合 PPT 截图做术语纠错 + 语气词清理 + 章节结构化，成品字数为官方的 91.5%（语气词被清理），与官方的分歧度 19.7% 与原始层持平，说明纠错没有引入额外失真。

## 二、总量统计

{stats_table}

## 三、字符错误率（CER）

CER =（替换 + 删除 + 插入的字符数）/ 基准字符数，基于编辑距离（Levenshtein）计算，统计前已归一化去除标点与空白。

{cer_table}

**关于"互为基准"的两个数字**：编辑距离天然对称，但分母不同（两边字数不同），因此 19.5% 与 19.4% 的微小差异来自分母（16881 vs 16912）。两者几乎重合本身就是旁证：分歧是逐字的替换错，而非整段的缺失或多余。反例是结尾窗口（181 字 vs 276 字），同一个编辑距离（≈242 字）呈现出 133.7% 与 87.7% 两个悬殊数字。

## 四、分窗口 CER（每 10 分钟）

{window_table}

**观察**：

- [10:00-20:00] 分歧最低（12.8%），是授课主体、吐字清晰的时段；
- [50:00-60:00] 分歧最高（33.9%），值得对着音频人工抽查——这节课该时段可能存在板书讲解、翻页噪音或师生互动；
- [100:00-110:00] 官方仅 181 字 vs 我们 276 字：下课前的零散话语，样本过小导致 CER 失真，可忽略。

## 五、逐时点并排抽样对照（每 15 分钟取 1 分钟窗口）

{samples_block}

## 六、分歧性质分析

1. **覆盖边界不同（结构性差异）**：官方把课前闲聊、非授课段完全压制；我们的 VAD 策略是"有语音就转"。例如 00:00-01:00 官方无字幕，我们转出了开场前的远场对话（内容支离破碎，双方在这种音频上的识别都不可靠）。
2. **语气词处理**：我们的成品清理了"嗯、呃、啊"等填充词（blocks 阶段保留，LLM 成品阶段清理），因此成品字数只有官方的 91.5%。
3. **术语纠错**：成品阶段以 PPT 截图为权威依据修正同音/近音误听（如"蘑菇模型→魔搭模型"类错误）。官方没有课件对照能力，这类错误官方同样存在——因此成品与官方的 CER 不会因为纠错而下降，反而可能因"纠正了官方也错的词"而略升。
4. **碎段过滤**：blocks 阶段丢弃了时长 <1s 且 ≤2 字的碎段（约 3.7% 字数），多为咳嗽、翻书声的误转写。

## 七、方法与局限

- **没有人工转写基准**：CER 只能衡量两个系统的分歧度。要判定谁更准确，需人工对照音频复核分歧窗口，重点推荐 [50:00-60:00]。
- **对齐方式**：按时间窗口（10 分钟）切分后分别拼接计算，不做句级强制对齐；时间戳两侧均以视频起点为原点。
- **小样本窗口**：字数过少的窗口 CER 波动大，仅供参考。

## 八、复现方式

```bash
cd /opt/5db-proj/mellifera/be
node scripts/compare_asr.js {COURSE_ID} {SUB_ID}   # 生成原始对比数据 + 并排抽样
# 本报告由组装脚本从其输出构建
```

原始对比数据：`/opt/5db-proj/mellifera/be/tmp/asr_compare_{COURSE_ID}_{SUB_ID}.md`
"""

import os
os.makedirs(DST_DIR, exist_ok=True)
dst = os.path.join(DST_DIR, f'ASR质量对比报告_{COURSE_ID}_{SUB_ID}.md')
with open(dst, 'w', encoding='utf-8') as f:
    f.write(report)
print('报告已写入:', dst)
print('字数:', len(report))
