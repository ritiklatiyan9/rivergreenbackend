// ADMS endpoints — public (device has no JWT). Mounted at /iclock so the
// device's hardcoded URL pattern (cdata, getrequest, devicecmd) reaches us
// as-is. The body parser is text/raw, NOT JSON, because the device sends
// tab-separated plain text.

import express from 'express';
import {
  handshake,
  pushData,
  getRequest,
  deviceCmd,
  ping,
} from '../controllers/adms.controller.js';

const router = express.Router();

// Accept any content-type — devices vary between octet-stream, text/plain,
// or none. We always want the raw body as a string.
router.use(express.text({ type: '*/*', limit: '2mb' }));

router.get('/ping', ping);
router.get('/cdata', handshake);
router.post('/cdata', pushData);
router.get('/getrequest', getRequest);
router.post('/devicecmd', deviceCmd);

// Some firmwares POST extra tables to /fdata or /edata. Accept and ignore so
// the device doesn't loop on them.
router.post('/fdata', (req, res) => res.type('text/plain').send('OK'));
router.post('/edata', (req, res) => res.type('text/plain').send('OK'));

export default router;
