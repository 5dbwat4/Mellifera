/** 逐字稿任务各步骤的展示名（与后端 stepId 对应） */
export const STEP_LABELS: Record<string, string> = {
  meta: '解析课时信息',
  download: '下载回放视频',
  audio: '抽取音频',
  vad: 'VAD 切段',
  asr: '逐段转写',
  punc: '合并分句 + 标点恢复',
  ppt: '获取并筛选 PPT',
  llm: '大模型生成逐字稿',
  done: '完成',
}

/** 步骤展示文本，带进度时追加 "done / total" */
export function stepText(stepId: string, progress: { done: number; total: number } | null): string {
  const label = STEP_LABELS[stepId] || stepId
  if (progress && progress.total > 0) return `${label}：${progress.done} / ${progress.total}`
  return label
}
