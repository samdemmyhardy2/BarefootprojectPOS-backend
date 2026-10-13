import { SetMetadata } from '@nestjs/common';

export const STREAM_TOKEN_KEY = 'accept_stream_token';
export const AcceptStreamToken = () => SetMetadata(STREAM_TOKEN_KEY, true);
