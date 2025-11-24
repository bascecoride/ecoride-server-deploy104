import express from 'express';
import {
  getAllFareRates,
  getFareRateByVehicle,
  updateFareRate,
  bulkUpdateFareRates,
  initializeFareRates,
} from '../controllers/fareRate.js';
import authenticateUser from '../middleware/authentication.js';

const router = express.Router();

// Admin middleware to check if user has admin role
const isAdmin = (req, res, next) => {
  // Check if user is admin from User model OR has admin/super-admin role from Admin model
  const isUserAdmin = req.user && req.user.role === 'admin';
  const isAdminModel = req.user && req.user.isAdmin === true;
  const hasAdminRole = req.user && (req.user.adminRole === 'admin' || req.user.adminRole === 'super-admin');
  
  if (isUserAdmin || isAdminModel || hasAdminRole) {
    next();
  } else {
    console.log('❌ Access denied. User info:', {
      role: req.user?.role,
      isAdmin: req.user?.isAdmin,
      adminRole: req.user?.adminRole
    });
    res.status(403).json({ message: 'Access denied. Admin privileges required.' });
  }
};

// Public route to get all fare rates (needed for ride booking)
router.get('/', getAllFareRates);

// Public route to get fare rate by vehicle type
router.get('/:vehicleType', getFareRateByVehicle);

// Admin/SuperAdmin only routes
router.post('/initialize', authenticateUser, isAdmin, initializeFareRates);
router.put('/:vehicleType', authenticateUser, isAdmin, updateFareRate);
router.put('/', authenticateUser, isAdmin, bulkUpdateFareRates);

export default router;
