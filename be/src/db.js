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
