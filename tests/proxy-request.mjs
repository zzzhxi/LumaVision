import { request } from 'node:http';

// Emulate the HTTP hop from Nginx to Node. Fetch replaces the Host header.
export function proxyRequest(url, options) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: new Headers(res.headers) }));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
