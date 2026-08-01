import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import errorMiddleware from './middlewares/error.middleware.js';
import httpCacheHeaders from './middlewares/httpCache.middleware.js';
import requestContext from './middlewares/requestContext.middleware.js';
import corsOptions from './config/cors.js';
import pool from './config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const configuredProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || '1', 10);

app.disable('x-powered-by');
app.set('trust proxy', Number.isInteger(configuredProxyHops) && configuredProxyHops >= 0
  ? configuredProxyHops
  : 1);
app.use(requestContext);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(compression({ threshold: 1024 }));
morgan.token('request-id', (req) => req.id || '-');
morgan.token('safe-url', (req) => String(req.originalUrl || req.url || '').split('?')[0]);
app.use(morgan(':remote-addr - :request-id :method :safe-url :status :response-time ms', {
  skip: (req) => req.path === '/health',
}));
app.use(cors(corsOptions));
app.use(cookieParser());

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, status: 'ok', uptime: Math.floor(process.uptime()) });
});

app.get('/ready', async (req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, status: 'ready' });
  } catch (error) {
    error.statusCode = 503;
    next(error);
  }
});

// ZKTeco ADMS (Push SDK) endpoints — mounted BEFORE the global JSON body
// parser so the device's tab-separated raw body reaches the route's
// text-parser intact. Public, no auth (device has no JWT — auth is by
// matching the SN query parameter against attendance_locations).
import admsRoutes from './routes/adms.routes.js';
app.use('/iclock', admsRoutes);

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '256kb' }));
app.use(express.urlencoded({
  extended: true,
  limit: process.env.FORM_BODY_LIMIT || '256kb',
  parameterLimit: 1_000,
}));
app.use(httpCacheHeaders(30));

// Serve uploaded files (screenshots, etc.)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  dotfiles: 'deny',
  immutable: true,
  maxAge: '7d',
}));

// routes
import indexRoutes from './routes/index.js';
app.use('/api', indexRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'API route not found',
    requestId: req.id,
  });
});

// error middleware
app.use(errorMiddleware);

export default app;
