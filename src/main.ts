import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { UploadPathInterceptor } from './common/interceptors/upload-path.interceptor';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { json, type NextFunction, type Request, type Response } from 'express';
import { syncRole } from './modules/sync/sync-tables';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  // A full copy from the laptop is one gzip-compressed request of the whole database.
  app.use('/api/sync/receive', json({ limit: '300mb' }));
  if (syncRole() === 'server') app.use(viewOnly);
  app.useBodyParser('json', { limit: '12mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '12mb' });
  const uploadDirectory = join(process.cwd(), 'uploads');
  mkdirSync(uploadDirectory, { recursive: true });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',').map((value) => value.trim()) ?? true, credentials: true });
  app.useStaticAssets(uploadDirectory, {
    prefix: '/uploads/',
    setHeaders: (response) => {
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new UploadPathInterceptor());
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Restaurant Order & Admin API')
    .setDescription('Restaurant menu, table, order, authentication, and analytics API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('/api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  await app.listen(process.env.PORT ?? 3000, process.env.HOST ?? '0.0.0.0');
  console.log("Server Started at ", process.env.PORT)
}
/** The hosted server is a copy of the restaurant laptop. Staff can sign in and look, but changes are made on the laptop. */
function viewOnly(request: Request, response: Response, next: NextFunction) {
  const path = request.path;
  const allowed = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) || path === '/api/auth/login' || path.startsWith('/api/sync/receive/');
  if (allowed) return next();
  response.status(403).json({ statusCode: 403, message: 'This server is a view-only copy. Make changes on the restaurant laptop.' });
}

void bootstrap();
