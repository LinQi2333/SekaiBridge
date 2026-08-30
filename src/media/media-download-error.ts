/** 媒体下载错误（规格 §48 媒体安全）。 */
export type MediaDownloadErrorCode =
  | 'BAD_PROTOCOL'
  | 'FETCH_FAILED'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'BAD_CONTENT_TYPE'
  | 'TOO_LARGE';

export class MediaDownloadError extends Error {
  readonly code: MediaDownloadErrorCode;
  readonly status: number | null;

  constructor(code: MediaDownloadErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'MediaDownloadError';
    this.code = code;
    this.status = status;
  }
}
