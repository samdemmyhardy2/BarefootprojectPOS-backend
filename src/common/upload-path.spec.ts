import { rewriteUploadUrls, uploadPath } from './upload-path';

describe('uploadPath', () => {
  it('drops the host from an uploaded file and leaves other urls alone', () => {
    expect(uploadPath('http://192.168.1.3:8000/uploads/images/dish.jpg')).toBe('/uploads/images/dish.jpg');
    expect(uploadPath('https://cdn.example.com/dish.jpg')).toBe('https://cdn.example.com/dish.jpg');
    expect(uploadPath('/uploads/images/dish.jpg')).toBe('/uploads/images/dish.jpg');
  });

  it('rewrites nested image fields without changing the source object', () => {
    const body = { imageUrl: 'http://10.0.0.8:8000/uploads/images/a.png', logoUrl: 'http://10.0.0.8:8000/uploads/images/logo.png', name: 'Soup' };
    expect(rewriteUploadUrls(body)).toEqual({ imageUrl: '/uploads/images/a.png', logoUrl: '/uploads/images/logo.png', name: 'Soup' });
    expect(body.imageUrl).toBe('http://10.0.0.8:8000/uploads/images/a.png');
  });
});
