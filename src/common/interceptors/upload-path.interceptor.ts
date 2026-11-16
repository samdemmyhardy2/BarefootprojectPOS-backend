import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';
import { rewriteUploadUrls } from '../upload-path';

@Injectable()
export class UploadPathInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(map((body) => rewriteUploadUrls(body)));
  }
}
