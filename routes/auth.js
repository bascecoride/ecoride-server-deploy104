import express from 'express';
import { refreshToken, auth, login, register, testAuth, getUserProfile, updateUserProfile, forgotPassword, resetPassword, verifyCode, uploadDocuments } from '../controllers/auth.js';
import authenticateUser from '../middleware/authentication.js';
import { upload } from '../utils/cloudinary.js';
import User from '../models/User.js';
import LoginAttempt from '../models/LoginAttempt.js';
import { StatusCodes } from 'http-status-codes';
import jwt from 'jsonwebtoken';

const router = express.Router();

// Login attempt configuration - Industry standard settings
const LOGIN_CONFIG = {
  MAX_ATTEMPTS: 5,           // Maximum failed attempts before lockout
  LOCKOUT_MINUTES: 30,       // Lockout duration in minutes
  CLEAR_ON_SUCCESS: true     // Clear failed attempts on successful login
};

// Debug route to test if auth routes are working
router.get('/test', (req, res) => {
  console.log('✅ Auth routes are working!');
  res.json({ message: 'Auth routes are working!' });
});

router.get('/', testAuth);
router.post('/refresh-token', refreshToken);
router.post('/signin', auth); // Legacy endpoint
router.post('/login', login); // New email/password login
router.post('/register', register); // New registration endpoint
router.get('/profile', authenticateUser, getUserProfile); // Get user profile
router.put('/profile', authenticateUser, updateUserProfile); // Update user profile
router.post('/forgot-password', forgotPassword); // Send password reset verification code
router.post('/verify-code', verifyCode); // Verify code without resetting password
router.post('/reset-password', resetPassword); // Verify code and reset password
router.post('/upload-documents', upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'schoolIdDocument', maxCount: 1 },
  { name: 'staffFacultyIdDocument', maxCount: 1 },
  { name: 'cor', maxCount: 1 },
  { name: 'driverLicense', maxCount: 1 },
  { name: 'orCr', maxCount: 1 },
  { name: 'pwdCardDocument', maxCount: 1 } // PWD Card for disability verification
]), uploadDocuments); // Upload verification documents

// Special admin login endpoint (legacy - for User model admins)
// Note: This endpoint is kept for backward compatibility with User model admins
// The main admin login is at /api/admin-management/login which uses the Admin model
router.post('/admin-login', async (req, res) => {
  const ipAddress = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  const { email, password } = req.body;
  
  console.log('Admin login attempt (legacy):', email);
  
  try {
    if (!email || !password) {
      return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Please provide email and password' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    
    // ============================================
    // STEP 1: Check if email is currently locked out
    // ============================================
    const lockoutStatus = await LoginAttempt.checkLockoutStatus(
      normalizedEmail,
      LOGIN_CONFIG.MAX_ATTEMPTS,
      LOGIN_CONFIG.LOCKOUT_MINUTES
    );
    
    if (lockoutStatus.isLocked) {
      console.log(`🔒 Login blocked - Account locked: ${normalizedEmail}`);
      
      await LoginAttempt.recordAttempt({
        email: normalizedEmail,
        ipAddress,
        userAgent,
        success: false,
        failureReason: 'account_locked',
        attemptType: 'admin'
      });
      
      return res.status(StatusCodes.TOO_MANY_REQUESTS).json({
        message: `Account temporarily locked due to too many failed login attempts. Please try again in ${lockoutStatus.remainingTime} minute(s).`,
        isLocked: true,
        remainingTime: lockoutStatus.remainingTime,
        remainingSeconds: lockoutStatus.remainingSeconds,
        lockoutEndsAt: lockoutStatus.lockoutEndsAt
      });
    }

    // ============================================
    // STEP 2: Find admin user by email
    // ============================================
    const admin = await User.findOne({ email: normalizedEmail, role: 'admin' });
    
    if (!admin) {
      console.log('Admin not found with email:', normalizedEmail);
      
      await LoginAttempt.recordAttempt({
        email: normalizedEmail,
        ipAddress,
        userAgent,
        success: false,
        failureReason: 'invalid_email',
        attemptType: 'admin'
      });
      
      const updatedStatus = await LoginAttempt.checkLockoutStatus(
        normalizedEmail,
        LOGIN_CONFIG.MAX_ATTEMPTS,
        LOGIN_CONFIG.LOCKOUT_MINUTES
      );
      
      return res.status(StatusCodes.UNAUTHORIZED).json({
        message: 'Invalid credentials',
        attemptsRemaining: updatedStatus.attemptsRemaining,
        warningMessage: updatedStatus.attemptsRemaining <= 2 
          ? `Warning: ${updatedStatus.attemptsRemaining} attempt(s) remaining before account lockout.`
          : null
      });
    }
    
    // ============================================
    // STEP 3: Check password
    // ============================================
    const isPasswordCorrect = await admin.comparePassword(password);
    if (!isPasswordCorrect) {
      console.log('Incorrect password for admin:', normalizedEmail);
      
      await LoginAttempt.recordAttempt({
        email: normalizedEmail,
        ipAddress,
        userAgent,
        success: false,
        failureReason: 'invalid_password',
        attemptType: 'admin'
      });
      
      const updatedStatus = await LoginAttempt.checkLockoutStatus(
        normalizedEmail,
        LOGIN_CONFIG.MAX_ATTEMPTS,
        LOGIN_CONFIG.LOCKOUT_MINUTES
      );
      
      if (updatedStatus.isLocked) {
        return res.status(StatusCodes.TOO_MANY_REQUESTS).json({
          message: `Account locked due to ${LOGIN_CONFIG.MAX_ATTEMPTS} failed login attempts. Please try again in ${LOGIN_CONFIG.LOCKOUT_MINUTES} minutes.`,
          isLocked: true,
          remainingTime: updatedStatus.remainingTime,
          remainingSeconds: updatedStatus.remainingSeconds,
          lockoutEndsAt: updatedStatus.lockoutEndsAt
        });
      }
      
      return res.status(StatusCodes.UNAUTHORIZED).json({
        message: 'Invalid credentials',
        attemptsRemaining: updatedStatus.attemptsRemaining,
        warningMessage: updatedStatus.attemptsRemaining <= 2 
          ? `Warning: ${updatedStatus.attemptsRemaining} attempt(s) remaining before account lockout.`
          : null
      });
    }
    
    // ============================================
    // STEP 4: Successful login
    // ============================================
    console.log(`✅ Admin login successful: ${normalizedEmail}`);
    
    await LoginAttempt.recordAttempt({
      email: normalizedEmail,
      ipAddress,
      userAgent,
      success: true,
      attemptType: 'admin'
    });
    
    if (LOGIN_CONFIG.CLEAR_ON_SUCCESS) {
      await LoginAttempt.clearFailedAttempts(normalizedEmail);
    }
    
    const accessToken = admin.createAccessToken();
    const refreshToken = admin.createRefreshToken();
    
    return res.status(StatusCodes.OK).json({
      message: 'Admin logged in successfully',
      user: admin,
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (error) {
    console.error('Admin login error:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error during admin login',
      error: error.message
    });
  }
});

export default router;
