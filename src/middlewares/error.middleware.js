const errorMiddleware = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  let statusCode = Number(err.statusCode || err.status || 500);
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') statusCode = 413;
  else if (err.name === 'MulterError') statusCode = 400;
  else if (err.code === '23505') statusCode = 409;
  else if (err.code === '23503') statusCode = 409;
  else if (err.code === '22P02') statusCode = 400;
  else if (err.code === '57014') statusCode = 503;
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) statusCode = 400;
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) statusCode = 500;

  const isServerError = statusCode >= 500;
  const safeDatabaseMessages = {
    23505: 'That record already exists',
    23503: 'This record is still in use',
    '22P02': 'Invalid identifier or value',
    57014: 'The request took too long. Please try again.',
  };
  const publicMessage = safeDatabaseMessages[err.code]
    || (isServerError && process.env.NODE_ENV === 'production'
      ? 'Something went wrong'
      : (err.message || 'Something went wrong'));

  console.error(`[${req.id || 'no-request-id'}] ${req.method} ${req.originalUrl}`, err.stack || err);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(statusCode).json({
    success: false,
    message: publicMessage,
    requestId: req.id,
  });
};

export default errorMiddleware;
