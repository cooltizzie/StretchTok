// StretchTok transcode server
//
// Runs on Render (free tier, Docker-based) so it has access to a real ffmpeg
// binary — something no plain "detect my language and run it" free host or
// a Cloudflare Worker (V8 isolate, no native binaries) can give you.
//
// Flow: browser uploads a video -> this server runs ffmpeg to stretch +
// re-encode it -> streams the finished file straight back. No database, no
// persistent storage — every temp file is deleted after the job finishes
// (or fails), and Render's disk is wiped on every restart anyway.

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Process-level safety net. Found during testing: when a client disconnects
// mid-upload, the raw incoming request stream can emit an 'error' event
// ("Request aborted") from inside multer/Node's HTTP layer, BEFORE the
// /stretch route handler even runs. An 'error' event with no listener
// crashes the entire Node process by default — confirmed by actually
// killing curl mid-upload in testing and watching the whole server die,
// taking down every other in-flight request on Render along with it, not
// just the one that disconnected. This handler is last-resort: it logs and
// keeps the process alive instead. The more targeted req.on('error', ...)
// listener below is the primary fix; this just guarantees nothing can slip
// past it and take the whole server down.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server staying alive):', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server staying alive):', err);
});

const app = express();
const PORT = process.env.PORT || 3000;
const TMP_DIR = path.join(__dirname, 'tmp');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// CORS: allow requests from the Cloudflare Worker (and directly from the
// browser page too, in case you skip the Worker during local testing).
// Tighten ALLOWED_ORIGIN in production once you know your real domains.
//
// exposedHeaders matters here: without it, the browser receives
// Content-Disposition on the wire fine, but client-side JS can't read it
// via xhr.getResponseHeader(...) — cross-origin responses only expose
// headers explicitly listed here. The client uses this header to recover
// the server's suggested output filename.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({
  origin: ALLOWED_ORIGIN,
  exposedHeaders: ['Content-Disposition', 'Content-Length'],
}));

// Targeted fix for the same issue the process-level handlers above guard
// against: attach an error listener directly on every incoming request
// before multer touches it, so a mid-upload disconnect is handled here
// instead of crashing the process. This is the primary fix; the
// process-level handlers above are the backstop in case anything else
// slips through in a shape this doesn't catch.
app.use((req, res, next) => {
  req.on('error', (err) => {
    console.log(`Request stream error (client likely disconnected): ${err.message}`);
  });
  next();
});

// 500MB upload cap — generous for personal use, adjust if you're hitting it.
// Render's free tier has limited RAM (512MB) so very large files may still
// struggle regardless of this cap; see the tutorial's "known limits" note.
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'stretchtok-server', ffmpeg: 'ready' });
});

// Simple health check Render (and you) can hit to confirm the box is awake —
// useful since free-tier services sleep after 15 min idle and cold-start
// on the next request.
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

app.post('/stretch', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file uploaded (expected field name "video").' });
  }

  const aspectRatio = parseFloat(req.body.aspectRatio);
  if (!aspectRatio || aspectRatio <= 0 || aspectRatio > 10) {
    cleanup(req.file.path);
    return res.status(400).json({ error: 'Invalid or missing aspectRatio (expected a positive number, e.g. 1.78).' });
  }

  // "source" or a specific height like "720"
  const heightArg = req.body.targetHeight;
  const targetHeight = heightArg && heightArg !== 'source' ? parseInt(heightArg, 10) : null;

  const jobId = crypto.randomBytes(8).toString('hex');
  const inputPath = req.file.path;
  const outputPath = path.join(TMP_DIR, `${jobId}_out.mp4`);

  // Tracks the job's terminal state so the single disconnect handler below
  // (res.on('close')) always knows exactly what still needs cleaning up,
  // regardless of which phase the disconnect happens during: mid-upload,
  // mid-ffmpeg, or mid-download of the finished file. This got a genuine
  // rewrite after testing revealed the first version marked the job
  // "settled" as soon as ffmpeg finished — which meant a disconnect that
  // happened WHILE the finished file was still streaming to the client
  // skipped cleanup and leaked the output file anyway.
  let ffmpegDone = false;   // true once the ffmpeg process itself has exited
  let fullySent = false;    // true only once the client fully received the response

  // scale filter: width is derived from the OUTPUT height * aspectRatio to
  // match the aspect-ratio stretch the preview shows — not from ffmpeg's
  // `ih`, which refers to the source video's input height. Using `ih` here
  // was a real bug: when targetHeight differs from the source height (e.g.
  // downscaling to 480p), `ih` still evaluates to the source's original
  // height, producing an incorrectly-sized width for the requested output.
  const scaleFilter = targetHeight
    ? `scale=trunc(${targetHeight}*${aspectRatio}/2)*2:${targetHeight}`
    : `scale=trunc(ih*${aspectRatio}/2)*2:ih`;

  const ffmpegArgs = [
    '-y',
    '-i', inputPath,
    '-vf', scaleFilter,
    '-c:v', 'libx264',
    '-preset', 'veryfast', // real ffmpeg preset, not ultrafast-desperation like the browser version needed
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath
  ];

  console.log(`[${jobId}] Starting ffmpeg: ${req.file.originalname} (ratio=${aspectRatio}, height=${targetHeight || 'source'})`);

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  let stderrTail = '';
  ffmpegProcess.stderr.on('data', (chunk) => {
    stderrTail += chunk.toString();
    if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000); // keep last bit only
  });

  ffmpegProcess.on('close', (code) => {
    ffmpegDone = true;
    cleanup(inputPath); // input is never needed again once ffmpeg exits, success or not

    if (code !== 0) {
      console.error(`[${jobId}] ffmpeg failed (code ${code}):`, stderrTail);
      cleanup(outputPath);
      fullySent = true; // nothing left to send or clean up after this
      if (!res.headersSent) {
        res.status(500).json({ error: 'Transcode failed.', detail: stderrTail.slice(-500) });
      }
      return;
    }

    if (!fs.existsSync(outputPath)) {
      console.error(`[${jobId}] ffmpeg exited 0 but no output file found.`);
      fullySent = true;
      if (!res.headersSent) {
        res.status(500).json({ error: 'Transcode produced no output.' });
      }
      return;
    }

    const stat = fs.statSync(outputPath);
    console.log(`[${jobId}] Done: ${(stat.size / 1048576).toFixed(2)}MB`);

    const downloadName = (req.file.originalname || 'video')
      .replace(/\.[^/.]+$/, '') + '_stretched.mp4';

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);

    // this is the ONLY point at which it's safe to say the job is fully
    // done and outputPath can be forgotten about
    res.on('finish', () => {
      fullySent = true;
      cleanup(outputPath);
    });

    stream.on('error', (err) => {
      console.error(`[${jobId}] Stream error:`, err.message);
      fullySent = true;
      cleanup(outputPath);
    });
  });

  ffmpegProcess.on('error', (err) => {
    console.error(`[${jobId}] Failed to spawn ffmpeg:`, err.message);
    ffmpegDone = true;
    fullySent = true;
    cleanup(inputPath);
    cleanup(outputPath);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start ffmpeg on the server.', detail: err.message });
    }
  });

  // Detecting client disconnects properly matters a lot here — this is what
  // actually caught a real leak during testing. req.on('close') looks like
  // the obvious choice but does NOT reliably fire in Express when a client
  // aborts mid-request (Express's body-parsing middleware, multer in our
  // case, ends the request stream before this handler even runs, so the
  // event never reaches here). res.on('close') is the documented, correct
  // way to detect an aborted connection in Express — and it fires on BOTH
  // normal completion and aborts, so fullySent is what tells this handler
  // whether there's anything left to do.
  //
  // Confirmed by testing: the first version of this fix marked cleanup done
  // as soon as ffmpeg exited, before the output had actually finished
  // streaming to the client — a disconnect during that download window
  // still leaked the output file. Testing the disconnect at each of the
  // three real phases (mid-upload, mid-ffmpeg, mid-download) is what caught
  // both this and the earlier req.on('close') bug.
  res.on('close', () => {
    if (fullySent) return; // job genuinely completed, nothing to clean up
    console.log(`[${jobId}] Client disconnected before job completed — cleaning up.`);
    if (!ffmpegDone) {
      ffmpegProcess.kill('SIGKILL');
      cleanup(inputPath);
    }
    cleanup(outputPath);
    fullySent = true;
  });
});

function cleanup(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') console.warn('Cleanup warning:', err.message);
  });
}

app.listen(PORT, () => {
  console.log(`StretchTok server listening on port ${PORT}`);
});
