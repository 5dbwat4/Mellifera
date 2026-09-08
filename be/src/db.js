import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

// 课节缓存库；默认放在 be/data/ 下，不参与 git 与 scp 同步
const DB_PATH = process.env.SESSION_DB_PATH || path.resolve(import.meta.dirname, '../data/mellifera.db')

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS course_sessions (
    sub_id       INTEGER PRIMARY KEY,
    course_id    INTEGER NOT NULL,
    title        TEXT    NOT NULL,
    start_at     INTEGER NOT NULL,
    status       TEXT    NOT NULL,
    playback_url TEXT,
    cached_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_course_sessions_course_id ON course_sessions(course_id);

  CREATE TABLE IF NOT EXISTS tasks (
    task_id     TEXT    PRIMARY KEY,
    sub_id      INTEGER NOT NULL,
    course_id   INTEGER,
    title       TEXT    NOT NULL DEFAULT '',
    video_url   TEXT,
    logs        TEXT    NOT NULL DEFAULT '',
    step_id     TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'queued',
    progress    TEXT,
    detail      TEXT    NOT NULL DEFAULT '',
    error       TEXT,
    result_file TEXT,
    created_at  INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_sub_id ON tasks(sub_id);
`)

const upsertStmt = db.prepare(`
  INSERT INTO course_sessions (sub_id, course_id, title, start_at, status, playback_url, cached_at)
  VALUES (@subId, @courseId, @title, @startAt, @status, @playbackUrl, @cachedAt)
  ON CONFLICT(sub_id) DO UPDATE SET
    course_id    = excluded.course_id,
    title        = excluded.title,
    start_at     = excluded.start_at,
    status       = excluded.status,
    playback_url = excluded.playback_url,
    cached_at    = excluded.cached_at
`)

const insertMany = db.transaction((sessions, cachedAt) => {
  for (const s of sessions) upsertStmt.run({ ...s, cachedAt })
})

/** 访问即缓存：只存已生成回放（playbackUrl 非空）的课节，subId 为主键 */
export function cacheSessions(courseId, sessions) {
  const playable = sessions.filter((s) => s.playbackUrl).map((s) => ({ ...s, courseId }))
  if (playable.length) insertMany(playable, Date.now())
}

const selectByCourse = db.prepare(`
  SELECT sub_id, course_id, title, start_at, status, playback_url
  FROM course_sessions WHERE course_id = ?
  ORDER BY start_at DESC
`)

/** 上游不可用时的回退数据源，形同课节列表 items */
export function getCachedSessions(courseId) {
  return selectByCourse.all(courseId).map((r) => ({
    subId: r.sub_id,
    title: r.title,
    startAt: r.start_at,
    status: r.status,
    playbackUrl: r.playback_url,
  }))
}

const selectBySub = db.prepare('SELECT * FROM course_sessions WHERE sub_id = ?')

/** 按课节编号取缓存原始行（含 course_id/title/playback_url），没有则返回 null */
export function getCachedSessionRow(subId) {
  return selectBySub.get(subId) || null
}

// ---------- 任务（逐字稿生成）持久化 ----------

const insertTaskStmt = db.prepare(`
  INSERT INTO tasks (task_id, sub_id, course_id, title, video_url, logs, step_id, status,
                     progress, detail, error, result_file, created_at, finished_at)
  VALUES (@taskId, @subId, @courseId, @title, @videoUrl, @logs, @stepId, @status,
          @progress, @detail, @error, @resultFile, @createdAt, @finishedAt)
`)

const updateTaskStmt = db.prepare(`
  UPDATE tasks SET course_id=@courseId, title=@title, video_url=@videoUrl, logs=@logs,
    step_id=@stepId, status=@status, progress=@progress, detail=@detail, error=@error,
    result_file=@resultFile, finished_at=@finishedAt
  WHERE task_id=@taskId
`)

export function saveTask(t, isNew = false) {
  const row = {
    taskId: t.taskId,
    subId: t.subId,
    courseId: t.courseId ?? null,
    title: t.title || '',
    videoUrl: t.videoUrl ?? null,
    logs: t.logs || '',
    stepId: t.stepId || '',
    status: t.status,
    progress: t.progress ? JSON.stringify(t.progress) : null,
    detail: t.detail || '',
    error: t.error ?? null,
    resultFile: t.resultFile ?? null,
    createdAt: t.createdAt,
    finishedAt: t.finishedAt ?? null,
  }
  if (isNew) insertTaskStmt.run(row)
  else updateTaskStmt.run(row)
}

const selectTaskStmt = db.prepare('SELECT * FROM tasks WHERE task_id = ?')
const latestTaskBySubStmt = db.prepare(
  'SELECT * FROM tasks WHERE sub_id = ? ORDER BY created_at DESC LIMIT 1'
)
const listTasksStmt = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200')

export function getTaskRow(taskId) {
  return selectTaskStmt.get(taskId) || null
}

export function getLatestTaskRowBySub(subId) {
  return latestTaskBySubStmt.get(subId) || null
}

export function listTaskRows() {
  return listTasksStmt.all()
}
