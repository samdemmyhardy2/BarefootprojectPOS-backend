const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';

export type DriveCredentials = { clientId: string; clientSecret: string; refreshToken: string };
export type DriveFile = { id: string; name: string; webViewLink?: string; modifiedTime?: string };

/** Minimal Google Drive v3 client. The drive.file scope limits it to files and folders it created itself. */
export class GoogleDrive {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly credentials: DriveCredentials) {}

  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const body = await response.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!response.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? response.status}`);
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async request<T>(url: string, init: RequestInit = {}) {
    const response = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await this.accessToken()}` } });
    const body = await response.json().catch(() => null) as (T & { error?: { message?: string } }) | null;
    if (!response.ok || !body) throw new Error(`Google Drive request failed: ${body?.error?.message ?? response.status}`);
    return body as T;
  }

  private async find(name: string, parentId?: string, mimeType?: string) {
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const query = [`name = '${escaped}'`, 'trashed = false', parentId ? `'${parentId}' in parents` : '', mimeType ? `mimeType = '${mimeType}'` : ''].filter(Boolean).join(' and ');
    const { files } = await this.request<{ files: DriveFile[] }>(`${FILES_URL}?${new URLSearchParams({ q: query, fields: 'files(id,name,webViewLink,modifiedTime)', pageSize: '1' })}`);
    return files[0] ?? null;
  }

  file(name: string, parentId: string) {
    return this.find(name, parentId);
  }

  async ensureFolder(name: string) {
    const existing = await this.find(name, undefined, FOLDER_TYPE);
    if (existing) return existing.id;
    const created = await this.request<DriveFile>(`${FILES_URL}?fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_TYPE }),
    });
    return created.id;
  }

  /** Creates the file, or replaces its content when the folder already holds one with this name. */
  async upload(folderId: string, name: string, mimeType: string, content: string | Buffer) {
    const existing = await this.find(name, folderId);
    const metadata = existing ? { name } : { name, parents: [folderId] };
    const boundary = `backup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const text = typeof content === 'string';
    const body = Buffer.concat([
      Buffer.from([
        `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
        `--${boundary}`, `Content-Type: ${mimeType}${text ? '; charset=UTF-8' : ''}`, '', '',
      ].join('\r\n')),
      text ? Buffer.from(content) : content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const url = `${existing ? `${UPLOAD_URL}/${existing.id}` : UPLOAD_URL}?uploadType=multipart&fields=id,name,webViewLink`;
    return this.request<DriveFile>(url, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  }
}
