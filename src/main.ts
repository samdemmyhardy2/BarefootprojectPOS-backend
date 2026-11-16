import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { UploadPathInterceptor } from './common/interceptors/upload-path.interceptor';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
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
void bootstrap();
