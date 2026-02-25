import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import errorMiddleware from './middlewares/error.middleware.js';
import httpCacheHeaders from './middlewares/httpCache.middleware.js';

const app = express();

app.use(helmet());
app.use(morgan('combined'));
app.use(cors({
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(httpCacheHeaders(30));

// routes
import indexRoutes from './routes/index.js';
app.use('/api', indexRoutes);

// error middleware
app.use(errorMiddleware);

export default app;