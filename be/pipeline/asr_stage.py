#!/usr/bin/env python
"""智云课堂课时音频 ASR 阶段：VAD 切段 -> 逐段转写 -> 滤碎/合并 -> 标点。

逻辑与 /opt/FireRedASR2S 的 vad_reform.py + asr_rest.py + postprocess.py 一致，
参数化后供 mellifera 后端调用：

    python asr_stage.py --workdir <dir> [--audio <wav>] [--max-segments N]

约定：<workdir>/audio.wav 为输入（16kHz 单声道）；产出：
    vad_segments.json / asr_all.jsonl / blocks.json / progress.json
progress.json 由后端轮询展示进度；ASR 逐段可断点续跑（跳过 asr_all.jsonl 已有段落）。
"""
import argparse
import json
import os
import time


def write_progress(workdir, step, done, total, detail=""):
    tmp = os.path.join(workdir, "progress.json.tmp")
    with open(tmp, "w") as f:
        json.dump({"step": step, "done": done, "total": total, "detail": detail}, f)
    os.replace(tmp, os.path.join(workdir, "progress.json"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--audio", default=None)
    ap.add_argument("--max-segments", type=int, default=0, help="调试用：只处理前 N 段")
    args = ap.parse_args()

    wd = args.workdir
    audio = args.audio or os.path.join(wd, "audio.wav")
    SR = 16000

    from fireredasr2s.fireredasr2.asr import FireRedAsr2, FireRedAsr2Config
    from fireredasr2s.fireredvad import FireRedVad, FireRedVadConfig

    # ---- 1) VAD 切段 ----
    import threading
    import wave

    with wave.open(audio, "rb") as w:
        audio_dur = w.getnframes() / w.getframerate()
    write_progress(wd, "vad", 0, 1)
    t_vad = time.time()
    print(f"[vad] 音频时长 {audio_dur / 60:.1f}min", flush=True)

    vad_path = os.path.join(wd, "vad_segments.json")
    if os.path.exists(vad_path):
        segs = json.load(open(vad_path))
        print(f"[vad] 复用已有 vad_segments.json（{len(segs)} 段）", flush=True)
    else:
        t_load = time.time()
        vad = FireRedVad.from_pretrained("/opt/models/FireRedVAD/VAD", FireRedVadConfig(use_gpu=True))
        print(f"[vad] 模型加载完成（{time.time() - t_load:.1f}s），开始检测", flush=True)
        # detect 是单次黑盒调用：放后台线程跑，主线程按 ~30x 实时的假设写估计进度
        box = {}

        def _detect():
            try:
                box["res"] = vad.detect(audio)
            except BaseException as e:  # 线程内异常带回主线程抛出
                box["err"] = e

        th = threading.Thread(target=_detect)
        th.start()
        t_detect = time.time()
        while True:
            th.join(timeout=2)
            if not th.is_alive():
                break
            elapsed = time.time() - t_detect
            write_progress(wd, "vad", min(int(elapsed * 30), int(audio_dur)), int(audio_dur),
                           f"VAD 处理中 {elapsed:.0f}s（估计）")
        if "err" in box:
            raise box["err"]
        result, _ = box["res"]
        segs = result["timestamps"]
        json.dump(segs, open(vad_path, "w"))
    if args.max_segments > 0:
        segs = segs[: args.max_segments]
    speech = sum(e - s for s, e in segs)
    longest = max((e - s for s, e in segs), default=0)
    print(f"[vad] 切出 {len(segs)} 段，语音共 {speech / 60:.1f}min，最长段 {longest:.1f}s，"
          f"VAD 总耗时 {time.time() - t_vad:.1f}s", flush=True)
    write_progress(wd, "vad", int(audio_dur), int(audio_dur), f"切出 {len(segs)} 段")

    # ---- 2) 逐段 ASR（断点续跑）----
    segs_dir = os.path.join(wd, "segs")
    os.makedirs(segs_dir, exist_ok=True)
    asr_path = os.path.join(wd, "asr_all.jsonl")
    done_starts = set()
    if os.path.exists(asr_path):
        for line in open(asr_path):
            try:
                done_starts.add(json.loads(line)["start"])
            except Exception:
                pass

    write_progress(wd, "asr", 0, 0, f"加载 ASR 模型（VAD 已切 {len(segs)} 段）")
    asr = FireRedAsr2.from_pretrained(
        "llm", "/opt/models/FireRedASR2-LLM",
        FireRedAsr2Config(use_gpu=True, use_half=True, decode_min_len=0, repetition_penalty=3.0,
                          llm_length_penalty=1.0, temperature=1.0))
    import soundfile as sf
    import torch

    t0 = time.time()
    with open(asr_path, "a") as out:
        for i, (s, e) in enumerate(segs):
            if s in done_starts:
                write_progress(wd, "asr", i + 1, len(segs), "跳过已完成段")
                continue
            p = os.path.join(segs_dir, f"seg_{i:05d}.wav")
            if not os.path.exists(p):
                data = sf.read(audio, start=int(s * SR), stop=int(e * SR), dtype="int16")[0]
                sf.write(p, data, SR)
            try:
                text = asr.transcribe([f"seg_{i:05d}"], [p])[0]["text"].strip()
            except Exception:
                text = ""
            out.write(json.dumps({"start": s, "end": e, "text": text}, ensure_ascii=False) + "\n")
            out.flush()
            if (i + 1) % 25 == 0:
                torch.cuda.empty_cache()
            elapsed = time.time() - t0
            done_n = i + 1
            eta = elapsed / done_n * (len(segs) - done_n)
            write_progress(wd, "asr", done_n, len(segs), f"eta {eta / 60:.1f}min")

    # ---- 3) 滤碎段 + 合并相邻段 ----
    del asr  # 释放 ~19GB 显存再加载 Punc（原工作流为独立脚本先后运行）
    torch.cuda.empty_cache()
    rows = [json.loads(l) for l in open(asr_path)]
    kept = [r for r in rows if not (r["end"] - r["start"] < 1.0 and len(r["text"].strip()) <= 2)]
    blocks = []
    for r in kept:
        if blocks and r["start"] - blocks[-1]["end"] <= 2.0 \
                and len(blocks[-1]["text"]) + len(r["text"]) < 100:
            blocks[-1]["end"] = r["end"]
            blocks[-1]["text"] += r["text"]
            continue
        blocks.append(dict(r))
    print(f"ASR {len(rows)} segs -> {len(kept)} kept -> {len(blocks)} blocks", flush=True)

    # ---- 4) 标点 ----
    from fireredasr2s.fireredpunc import FireRedPunc, FireRedPuncConfig

    write_progress(wd, "punc", 0, len(blocks))
    punc = FireRedPunc.from_pretrained("/opt/models/FireRedPunc", FireRedPuncConfig(use_gpu=True))
    results = []
    BS = 32
    for i in range(0, len(blocks), BS):
        results += punc.process([b["text"] for b in blocks[i:i + BS]])
        write_progress(wd, "punc", min(i + BS, len(blocks)), len(blocks))
    out_blocks = []
    for b, p in zip(blocks, results):
        text = p["punc_text"] if isinstance(p, dict) else p
        out_blocks.append({"start": b["start"], "end": b["end"], "text": text})
    with open(os.path.join(wd, "blocks.json"), "w") as f:
        json.dump(out_blocks, f, ensure_ascii=False)
    write_progress(wd, "done", 1, 1)
    print("ASR stage complete.", flush=True)


if __name__ == "__main__":
    main()
