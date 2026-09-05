import asyncHandler from '../utils/asyncHandler.js';
import salesAssistant from '../services/salesAssistant.service.js';

// AssistantInputError carries statusCode 400 and the error middleware already
// renders { success:false, message } for it — no local mapping needed.
export const chatWithSalesAssistant = asyncHandler(async (req, res) => {
  const result = await salesAssistant.answer({ user: req.user, body: req.body });
  return res.status(200).json(result);
});

// Server-sent events: `stage` while tools run, `delta` for answer text,
// `done` with the exact payload /ai/chat returns, `error` if even the
// fallback cannot answer. Validation/auth errors happen before headers are
// sent, so they remain ordinary JSON errors.
export const chatWithSalesAssistantStream = asyncHandler(async (req, res) => {
  const controller = new AbortController();
  let started = false;
  let ping = null;
  req.on('close', () => {
    controller.abort();
    if (ping) clearInterval(ping);
  });

  const emit = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onStart = () => {
    started = true;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // no-transform makes the compression middleware pass the stream through
    // untouched instead of buffering it.
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    ping = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
    }, 10_000);
  };

  try {
    await salesAssistant.answerStream({ user: req.user, body: req.body, onStart, emit, signal: controller.signal });
  } catch (error) {
    if (!started) throw error;
    emit('error', {
      message: error?.statusCode === 503
        ? error.message
        : 'Sales AI could not answer right now. Please try again.',
      code: error?.statusCode === 503 ? 'AI_DATA_UNAVAILABLE' : 'AI_UNAVAILABLE',
    });
  } finally {
    if (ping) clearInterval(ping);
    if (started && !res.writableEnded) res.end();
  }
});

export default chatWithSalesAssistant;
