# Mellifera

前后端分离项目脚手架。

- **后端 `be/`**：Node.js + Express 5（端口 **9000**），接口统一挂在 `/api` 前缀下，纯 ESM、免构建
- **前端 `fe/`**：Vue 3 + TypeScript + Vite + Tailwind CSS v4 + vue-router（端口 **5180**）

## 目录结构

```
mellifera/
├── be/                    # Node.js 后端
│   ├── src/
│   │   ├── index.js       # 入口：启动 HTTP 服务
│   │   ├── app.js         # Express 应用（CORS、JSON 解析、路由注册、错误处理）
│   │   ├── config.js      # 配置（端口、CORS 白名单，支持环境变量覆盖）
│   │   └── routes/        # health、items（内存存储示例）路由
│   └── package.json
└── fe/                    # Vue 前端
    ├── src/
    │   ├── api.ts         # 后端 API 客户端
    │   ├── router/index.ts    # vue-router 路由（/courses /tasks /system）
    │   ├── components/AppHeader.vue   # 全局顶部导航
    │   ├── views/         # 页面：CourseList / MyTasks / SystemStatus
    │   ├── assets/icons/  # iconify SVG 图标（vite-svg-loader 内联引入）
    │   ├── App.vue        # 布局（Header + RouterView）
    │   ├── style.css      # Tailwind 入口
    │   └── main.ts
    └── vite.config.ts     # 端口 5180，代理 /api -> http://127.0.0.1:9000
```

## 快速开始

### 1. 启动后端（端口 9000）

```bash
cd be
npm install
npm run dev        # node --watch，代码改动自动重启；自动加载根目录 .env
```

> 端口约定：后端 **9000**、前端 **5180**。可用环境变量 `PORT` / `HOST` 覆盖后端端口；如需更改前端端口或代理目标，修改 `fe/vite.config.ts` 与 `be/src/config.js` 中的 CORS 白名单。
>
> 智云课堂相关接口需要根目录 `.env` 提供 `ZJU_USERNAME` / `ZJU_PASSWORD`（ZJUAM 统一身份认证），首次调用相关接口时会触发登录（数秒）。

### 2. 启动前端（端口 5180）

```bash
cd fe
npm install
npm run dev
```

浏览器访问 http://localhost:5180 ，"系统情况"页会实时检测后端在线状态。开发模式下 Vite 把 `/api` 请求代理到 `http://127.0.0.1:9000`，无需处理跨域；后端 CORS 也已按 5180 配置兜底。前端配置了 `strictPort: true`，端口被占时直接报错而不是自动换端口。

## 示例接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，返回 `{ "status": "ok" }` |
| GET | `/api/items` | 列表 |
| POST | `/api/items` | 新增 `{ "name": "...", "description": "..." }`，校验失败返回 400 |
| DELETE | `/api/items/{id}` | 删除，不存在返回 404 |
| GET | `/api/courses?page=1&pageSize=9` | 我的智云课堂课程（`force_mycourse=1`），分页透传平台原生参数 |
| GET | `/api/courses/{courseId}/sessions` | 课节列表（按开课时间倒序，含回放地址）；**不限于自己的课程**，智云课堂存在的课程编号即可查 |
| POST | `/api/transcripts` | 创建逐字稿任务 `{ courseId, subId, force? }`，同一课时幂等；任务串行排队 |
| GET | `/api/transcripts/{jobId}` | 查询任务状态/进度/结果 |

## 逐字稿生成流水线

课时节列表页点击"生成逐字稿"后，后端在 qwen38 上依次执行：

```
解析课时 → curl 下载回放视频 → ffmpeg 抽 16kHz 音频
  → be/pipeline/asr_stage.py（FireRedVAD 切段 → FireRedASR2-LLM 逐段转写 → 滤碎/合并 → FireRedPunc 标点）
  → 智云课堂 PPT 列表，去重换片后均匀采样 ≤16 张
  → ASR 文本块 + PPT 截图一起送 SGLang(Qwen3.8-27B, 127.0.0.1:8000) 生成 Markdown 逐字稿
```

- 视频下载/抽取音频/ASR 段落均支持断点复用；成功任务持久化在 `TRANSCRIPT_WORKDIR`（默认 `/opt/test2/mellifera/<courseId>_<subId>/`），后端重启后直接返回已完成的产物
- ASR 阶段依赖 `/opt/FireRedASR2S`（本地包 `fireredasr2s`）与 conda 环境 `qwen38`，可用环境变量覆盖：`CONDA_PYTHON`、`FIRERED_ROOT`、`SGLANG_BASE`、`SGLANG_MODEL`、`TRANSCRIPT_WORKDIR`、`PPT_SELECT_MAX`（默认 16）、`ASR_MAX_SEGMENTS`（调试用）
- 全流程对 2.5 小时课程约需 25-35 分钟（ASR ~15 分钟为大头），GPU 任务同一时间只跑一个

items 目前为内存存储（进程重启清空），接入数据库时替换 `be/src/routes/items.js` 中的 Map 即可。
