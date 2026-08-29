/**
 * StretchTok Cloudflare Worker
 *
 * Honest scope of this file: Cloudflare Workers run in V8 isolates with no
 * native binaries and no filesystem, so they genuinely cannot run ffmpeg
 * themselves on the free plan. What this Worker DOES do:
 *
 *   1. Gives you a stable Cloudflare-hosted URL for your app to call
 *   2. Validates the incoming request before it burns any Render compute
 *      (rejects non-video uploads, oversized files, missing params)
 *   3. Forwards the actual transcode job to the Render server, which is
 *      the box that runs real ffmpeg
 *   4. Streams the finished video straight back through to the browser
 *
 * If you ever move to Cloudflare Containers (paid Workers plan), you'd
 * swap RENDER_SERVER_URL below for a container binding and skip Render
 * entirely — the client-facing contract (POST /export) stays the same.
 */
const RENDER_SERVER_URL = 'https://stretchtok.onrender.com';
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // keep in sync with server.js's multer limit

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // tighten to your real domain once you have one
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // Without this, the browser receives Content-Disposition on the response
  // just fine over the wire, but JS (xhr.getResponseHeader(...)) can't read
  // it — cross-origin responses only expose headers listed here. The client
  // uses Content-Disposition to recover the server's suggested filename.
  'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, worker: 'stretchtok-proxy' });
    }

    if (url.pathname === '/export' && request.method === 'POST') {
      return handleExport(request);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};

async function handleExport(request) {
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_BYTES) {
    return jsonResponse({ error: `File too large. Max ${MAX_UPLOAD_BYTES / 1048576}MB.` }, 413);
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return jsonResponse({ error: 'Expected multipart/form-data with a "video" field.' }, 400);
  }

  // Basic shape validation before we spend Render's compute on it.
  // We don't fully parse the multipart body here (that'd mean buffering
  // the whole upload in the Worker, which defeats the point of streaming)
  // — server.js does the real validation once the job actually starts.
  let target;
  try {
    target = new URL('/stretch', RENDER_SERVER_URL);
  } catch (err) {
    return jsonResponse({ error: 'Worker misconfigured: RENDER_SERVER_URL is not a valid URL. Update worker.js.' }, 500);
  }

  try {
    const upstreamResponse = await fetch(target.toString(), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: request.body,
    });

    // stream the response straight through — video files are big, we don't
    // want to buffer the whole thing in the Worker's memory
    const headers = new Headers(upstreamResponse.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      headers.set(key, value);
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers,
    });
  } catch (err) {
    return jsonResponse({
      error: 'Could not reach the transcode server. It may be asleep (free-tier Render spins down after 15min idle) — try again in ~30-60s.',
      detail: String(err),
    }, 502);
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
