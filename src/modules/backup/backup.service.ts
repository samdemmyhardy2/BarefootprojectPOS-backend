import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { GoogleDrive, type DriveFile } from './google-drive';
import { OrderExportService } from './order-export.service';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const DAY_MS = 24 * 60 * 60 * 1000;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

type BackupRun = { at: string; trigger: 'MANUAL' | 'SCHEDULED'; ok: boolean; file?: DriveFile; error?: string };

@Injectable()
export class BackupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupService.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastRun: BackupRun | null = null;
  private nextRunAt: Date | null = null;
  private drive: GoogleDrive | null = null;

  constructor(private readonly exports: OrderExportService) {}

  onModuleInit() {
    if (!this.configured()) {
      this.logger.warn('Google Drive backup is waiting for GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, and GOOGLE_DRIVE_REFRESH_TOKEN.');
      return;
    }
    this.schedule();
    void this.catchUp().catch((error: unknown) => this.logger.warn(error instanceof Error ? error.message : 'Backup catch-up failed'));
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  private configured() {
    return Boolean(process.env.GOOGLE_DRIVE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET && process.env.GOOGLE_DRIVE_REFRESH_TOKEN);
  }

  private client() {
    if (!this.configured()) throw new ServiceUnavailableException('Google Drive backup is not configured on the server.');
    this.drive ??= new GoogleDrive({
      clientId: process.env.GOOGLE_DRIVE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET!,
      refreshToken: process.env.GOOGLE_DRIVE_REFRESH_TOKEN!,
    });
    return this.drive;
  }

  private folderName() {
    return process.env.GOOGLE_DRIVE_BACKUP_FOLDER?.trim() || 'Restaurant table order backups';
  }

  /** First restaurant day in the workbook. Every run rebuilds the whole file from this day to today. */
  private firstDay() {
    const day = process.env.BACKUP_START_DATE?.trim();
    return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '2026-11-02';
  }

  private fileName() {
    return `orders-from-${this.firstDay()}.xlsx`;
  }

  private roomTabFileName() {
    return 'room-tab-orders.xlsx';
  }

  /** Hour of the day in Asia/Bangkok when the backup runs. */
  private backupHour() {
    const hour = Number(process.env.BACKUP_HOUR ?? 22);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 22;
  }

  private schedule() {
    const now = Date.now();
    const local = new Date(now + BANGKOK_OFFSET_MS);
    let target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), this.backupHour()) - BANGKOK_OFFSET_MS;
    if (target <= now) target += DAY_MS;
    this.nextRunAt = new Date(target);
    this.timer = setTimeout(() => {
      void this.run('SCHEDULED').catch(() => undefined).finally(() => this.schedule());
    }, target - now);
  }

  /** After downtime that spanned the backup hour, run the missed backup if the Drive file is older than it. */
  private async catchUp() {
    const now = Date.now();
    const local = new Date(now + BANGKOK_OFFSET_MS);
    let due = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), this.backupHour()) - BANGKOK_OFFSET_MS;
    if (due > now) due -= DAY_MS;
    const drive = this.client();
    const folderId = await drive.ensureFolder(this.folderName());
    const [ordersFile, roomTabFile] = await Promise.all([drive.file(this.fileName(), folderId), drive.file(this.roomTabFileName(), folderId)]);
    const stale = (file: DriveFile | null) => !file?.modifiedTime || Date.parse(file.modifiedTime) < due;
    if (stale(ordersFile) || stale(roomTabFile)) await this.run('SCHEDULED');
  }

  status() {
    return { configured: this.configured(), folder: this.folderName(), file: this.fileName(), roomTabFile: this.roomTabFileName(), firstDay: this.firstDay(), backupHour: this.backupHour(), running: this.running, nextRunAt: this.nextRunAt, lastRun: this.lastRun };
  }

  async run(trigger: 'MANUAL' | 'SCHEDULED') {
    const drive = this.client();
    if (this.running) throw new ConflictException('A backup is already running.');
    this.running = true;
    const name = this.fileName();
    try {
      const folderId = await drive.ensureFolder(this.folderName());
      const file = await drive.upload(folderId, name, XLSX_TYPE, await this.exports.workbook(this.firstDay()));
      const roomTabName = this.roomTabFileName();
      const roomTab = await drive.upload(folderId, roomTabName, XLSX_TYPE, await this.exports.roomTabWorkbook(this.firstDay()));
      this.lastRun = { at: new Date().toISOString(), trigger, ok: true, file: roomTab ?? file };
      this.logger.log(`Uploaded ${name} and ${roomTabName} to Google Drive.`);
      return { ...this.lastRun, ordersFile: file, roomTabFile: roomTab };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Backup failed';
      this.lastRun = { at: new Date().toISOString(), trigger, ok: false, error: message };
      this.logger.error(`Order backup failed: ${message}`);
      if (trigger === 'MANUAL') throw new ServiceUnavailableException(message);
      throw error;
    } finally {
      this.running = false;
    }
  }
}
