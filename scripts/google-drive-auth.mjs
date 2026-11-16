// One-time helper: signs in to Google and prints the refresh token the daily backup needs.
// Usage: GOOGLE_DRIVE_CLIENT_ID=... GOOGLE_DRIVE_CLIENT_SECRET=... node scripts/google-drive-auth.mjs
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET first.');
  process.exit(1);
}

const port = Number(process.env.GOOGLE_DRIVE_AUTH_PORT ?? 53682);
const redirectUri = `http://127.0.0.1:${port}`;
const state = randomBytes(16).toString('hex');

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', redirectUri);
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== state) {
    response.writeHead(400).end('Sign-in was not completed. Return to the terminal and try again.');
    return;
  }
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const body = await tokenResponse.json();
  if (!body.refresh_token) {
    response.writeHead(500).end('Google did not return a refresh token. See the terminal.');
    console.error('No refresh token returned:', body.error_description ?? body.error ?? body);
  } else {
    response.writeHead(200).end('Google Drive is connected. You can close this tab.');
    console.log('\nAdd this line to the backend .env file, then restart the server:\n');
    console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${body.refresh_token}\n`);
  }
  server.close();
});

server.listen(port, '127.0.0.1', () => {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  console.log('Open this address in a browser on this computer and sign in with the Google account that should hold the backups:\n');
  console.log(`https://accounts.google.com/o/oauth2/v2/auth?${params}\n`);
});
