import express from 'express';
const router = express.Router();
import upload from '../middlewares/multer.middleware.js';

import {
    getColonyMaps,
    getColonyMap,
    createColonyMap,
    updateColonyMap,
    deleteColonyMap,
    createPlot,
    updatePlot,
    deletePlot,
    getPlot,
    updatePlotStatus,
    bulkSavePlots,
    getMapStats,
    getPublicPlot,
    initializeLayout,
    uploadMapImage,
} from '../controllers/colonyMap.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';

// Public Plot Route (for sharing)
router.get('/public/plots/:plotId', getPublicPlot);

// Read-only routes accessible by AGENT, TEAM_HEAD, ADMIN
router.use(authMiddleware);
router.get('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), getColonyMaps);
router.get('/:id', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), getColonyMap);
router.get('/:id/stats', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), getMapStats);
router.get('/:id/plots/:plotId', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), getPlot);

// Initialize layout from code-defined config (creates map + all plots)
router.post('/initialize', checkRole(['ADMIN']), initializeLayout);

// Write routes: ADMIN only
router.post('/', checkRole(['ADMIN']), createColonyMap);
router.put('/:id', checkRole(['ADMIN']), updateColonyMap);
router.post('/:id/upload-image', checkRole(['ADMIN']), upload.single('map_image'), uploadMapImage);
router.delete('/:id', checkRole(['ADMIN']), deleteColonyMap);

// Plot write routes
router.post('/:id/plots', checkRole(['ADMIN']), createPlot);
router.post('/:id/plots/bulk', checkRole(['ADMIN']), bulkSavePlots);
router.put('/:id/plots/:plotId', checkRole(['ADMIN']), updatePlot);
router.delete('/:id/plots/:plotId', checkRole(['ADMIN']), deletePlot);
router.put('/:id/plots/:plotId/status', checkRole(['ADMIN']), updatePlotStatus);

export default router;
