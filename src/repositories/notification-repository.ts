import type Database from 'better-sqlite3';
import type { QqNotification } from '../domain/notification.js';

interface NotificationRow {
  id: number;
  tweet_id: number;
  text: string;
  screenshot_path: string | null;
  video_thumbnails: string | null;
  status: string;
  created_at: string;
  sent_at: string | null;
}

function toDomain(row: NotificationRow): QqNotification {
  let videoThumbnails: string[] = [];
  if (row.video_thumbnails) {
    try {
      const parsed: unknown = JSON.parse(row.video_thumbnails);
      videoThumbnails = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      videoThumbnails = [];
    }
  }
  return {
    id: row.id,
    tweetId: row.tweet_id,
    text: row.text,
    screenshotPath: row.screenshot_path,
    videoThumbnails,
    status: row.status as QqNotification['status'],
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

export class NotificationRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    tweetId: number;
    text: string;
    screenshotPath: string | null;
    videoThumbnails: string[];
  }): QqNotification {
    const info = this.db
      .prepare(
        `INSERT INTO qq_notifications (tweet_id, text, screenshot_path, video_thumbnails)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.tweetId,
        input.text,
        input.screenshotPath,
        input.videoThumbnails.length > 0 ? JSON.stringify(input.videoThumbnails) : null,
      );
    return this.findById(Number(info.lastInsertRowid)) as QqNotification;
  }

  findById(id: number): QqNotification | null {
    const row = this.db
      .prepare('SELECT * FROM qq_notifications WHERE id = ?')
      .get(id) as unknown as NotificationRow | undefined;
    return row ? toDomain(row) : null;
  }

  listPending(limit = 50): QqNotification[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM qq_notifications WHERE status = 'PENDING' ORDER BY id ASC LIMIT ?",
      )
      .all(limit) as unknown as NotificationRow[];
    return rows.map(toDomain);
  }

  /** 标记已发送；返回是否成功（记录存在且为 PENDING）。 */
  markSent(id: number): boolean {
    const info = this.db
      .prepare(
        "UPDATE qq_notifications SET status = 'SENT', sent_at = datetime('now') WHERE id = ? AND status = 'PENDING'",
      )
      .run(id);
    return info.changes > 0;
  }
}
