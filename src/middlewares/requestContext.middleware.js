import { randomUUID } from 'crypto';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

const requestContext = (req, res, next) => {
  const incomingId = req.header('x-request-id');
  req.id = incomingId && SAFE_REQUEST_ID.test(incomingId)
    ? incomingId
    : randomUUID();

  res.setHeader('x-request-id', req.id);
  next();
};

export default requestContext;
