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
  origin: [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'https://adminrivergreen.vercel.app',
    'https://adminrivergreen-git-main-ritik-latiyans-projects.vercel.app',
    'https://adminrivergreen-prb31i4e1-ritik-latiyans-projects.vercel.app',
  ],
  credentials: true,
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