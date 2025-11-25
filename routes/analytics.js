import express from 'express';
import { 
  getUserStats,
  getRideStats,
  getCombinedAnalytics,
  getTopPerformingRiders,
  getRevenueTrends,
  getRideStatusMonitoring,
  getPeakHoursAnalysis,
  getPopularRoutes,
  getCompletedRidesDebug,
  getVehicleBreakdown,
  getPaymentMethodAnalytics,
  getRideStatusBreakdown
} from '../controllers/analytics.js';
import authenticateUser from '../middleware/authentication.js';

const router = express.Router();

// Admin middleware to check if user has admin role
const isAdmin = (req, res, next) => {
  // Temporarily bypass admin check for development
  return next();
  
  // Original check (commented out for now)
  /*
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ message: 'Access denied. Admin privileges required.' });
  }
  */
};

// Apply authentication and admin check to all routes
router.use(authenticateUser, isAdmin);

// Analytics routes
router.get('/user-stats', getUserStats);
router.get('/ride-stats', getRideStats);
router.get('/combined', getCombinedAnalytics);
router.get('/top-riders', getTopPerformingRiders);
router.get('/revenue-trends', getRevenueTrends);
router.get('/ride-monitoring', getRideStatusMonitoring);
router.get('/peak-hours', getPeakHoursAnalysis);
router.get('/popular-routes', getPopularRoutes);
router.get('/debug/completed-rides', getCompletedRidesDebug);
router.get('/vehicle-breakdown', getVehicleBreakdown);
router.get('/payment-methods', getPaymentMethodAnalytics);
router.get('/ride-status-breakdown', getRideStatusBreakdown);

export default router;
