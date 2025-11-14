// ============================================
// src/routes/callRoutes.js (UPDATE)
const express = require('express');
const router = express.Router();
const callController = require('../controllers/callController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

router.get('/history', callController.getCallHistory);
router.get('/statistics', callController.getCallStatistics);
router.get('/:callId', callController.getCallDetails);
router.delete('/:callId', callController.deleteCallLog);

module.exports = router;