import { BadRequestException, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

const uploadDirectory = join(process.cwd(), 'uploads', 'images');
mkdirSync(uploadDirectory, { recursive: true });

@ApiTags('Media')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('media')
export class MediaController {
  @Post('images')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } })
  @ApiOperation({ summary: 'Upload an image to local server storage' })
  @ApiResponse({ status: 201, description: 'Returns the locally hosted image URL.' })
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: uploadDirectory,
      filename: (_req, file, callback) => callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) {
        callback(new BadRequestException('Upload a JPG, PNG, WEBP, or GIF image.'), false);
        return;
      }
      callback(null, true);
    },
  }))
  upload(@UploadedFile() file: { filename: string } | undefined) {
    if (!file) throw new BadRequestException('An image file is required.');
    return { imageUrl: `/uploads/images/${file.filename}` };
  }
}
