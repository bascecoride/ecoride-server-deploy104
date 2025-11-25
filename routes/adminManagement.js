import express from 'express';
import { 
  getAllAdmins,
  getAdminById,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  toggleAdminStatus,
  getActivityLogs,
  adminLogin,
  getLoginAttempts,
  unlockAdminAccount,
  checkLockoutStatus
} from '../controllers/adminManagement.js';
import authenticateUser from '../middleware/authentication.js';

const router = express.Router();

// Admin middleware to check if user has admin role
const isAdmin = (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.adminRole)) {
    next();
  } else {
    res.status(403).json({ message: 'Access denied. Admin privileges required.' });
  }
};

// Super-admin middleware
const isSuperAdmin = (req, res, next) => {
  if (req.user && req.user.adminRole === 'super-admin') {
    next();
  } else {
    res.status(403).json({ message: 'Access denied. Super-admin privileges required.' });
  }
};

// Public routes (no authentication required)
router.post('/login', adminLogin);
router.post('/check-lockout', checkLockoutStatus);  // Check lockout status before login

// Protected routes - require authentication
router.use(authenticateUser);

// Activity logs - accessible by all admins
router.get('/activity-logs', isAdmin, getActivityLogs);

// Login attempts management - super-admin only
router.get('/login-attempts', isSuperAdmin, getLoginAttempts);
router.post('/unlock-account', isSuperAdmin, unlockAdminAccount);

// Admin management routes - super-admin only
router.get('/admins', isSuperAdmin, getAllAdmins);
router.get('/admins/:id', isAdmin, getAdminById); // Admins can view their own profile
router.post('/admins', isSuperAdmin, createAdmin);
router.put('/admins/:id', isAdmin, updateAdmin); // Admins can update their own profile
router.delete('/admins/:id', isSuperAdmin, deleteAdmin);
router.patch('/admins/:id/toggle-status', isSuperAdmin, toggleAdminStatus);

export default router;
