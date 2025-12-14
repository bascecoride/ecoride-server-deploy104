import express from 'express';
import { 
  getAllUsers, 
  getUserById, 
  approveUser, 
  disapproveUser, 
  updateUser, 
  deleteUser,
  addPenaltyComment,
  getAllRides,
  verifyPWD
} from '../controllers/admin.js';
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

// User management routes
router.get('/users', getAllUsers);
router.get('/users/:id', getUserById);
router.put('/users/:id/approve', approveUser);
router.put('/users/:id/disapprove', disapproveUser);
router.put('/users/:id/penalty', addPenaltyComment);
router.put('/users/:id/verify-pwd', verifyPWD);
router.put('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);

// Ride management routes
router.get('/rides', getAllRides);

export default router;
