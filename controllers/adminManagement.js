import Admin from '../models/Admin.js';
import ActivityLog from '../models/ActivityLog.js';
import LoginAttempt from '../models/LoginAttempt.js';
import { StatusCodes } from 'http-status-codes';
import { BadRequestError, NotFoundError, UnauthenticatedError } from '../errors/index.js';

// Login attempt configuration - Industry standard settings
const LOGIN_CONFIG = {
  MAX_ATTEMPTS: 5,           // Maximum failed attempts before lockout
  LOCKOUT_MINUTES: 30,       // Lockout duration in minutes
  CLEAR_ON_SUCCESS: true     // Clear failed attempts on successful login
};

// Helper function to log activity
export const logActivity = async (adminId, adminName, action, targetType, targetId, targetName, description, metadata = {}, ipAddress = null) => {
  try {
    await ActivityLog.create({
      admin: adminId,
      adminName,
      action,
      targetType,
      targetId,
      targetName,
      description,
      metadata,
      ipAddress
    });
    console.log(`📝 Activity logged: ${adminName} - ${action} - ${targetName}`);
  } catch (error) {
    console.error('Error logging activity:', error);
    // Don't throw error - activity logging should not break the main operation
  }
};

// Get all admins (super-admin only)
export const getAllAdmins = async (req, res) => {
  try {
    // Check if user is super-admin
    if (req.user.adminRole !== 'super-admin') {
      return res.status(StatusCodes.FORBIDDEN).json({ 
        message: 'Access denied. Super-admin privileges required.' 
      });
    }

    const admins = await Admin.find()
      .select('-password')
      .populate('createdBy', 'name username')
      .sort({ createdAt: -1 });
    
    res.status(StatusCodes.OK).json({
      count: admins.length,
      admins
    });
  } catch (error) {
    console.error('Error fetching admins:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error fetching admins',
      error: error.message
    });
  }
};

// Get admin by ID
export const getAdminById = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user is super-admin or viewing their own profile
    if (req.user.adminRole !== 'super-admin' && req.user.id !== id) {
      return res.status(StatusCodes.FORBIDDEN).json({ 
        message: 'Access denied.' 
      });
    }

    const admin = await Admin.findById(id)
      .select('-password')
      .populate('createdBy', 'name username');
    
    if (!admin) {
      throw new NotFoundError(`No admin found with id ${id}`);
    }
    
    res.status(StatusCodes.OK).json({ admin });
  } catch (error) {
    console.error(`Error fetching admin ${req.params.id}:`, error);
    
    if (error.name === 'NotFoundError') {
      res.status(StatusCodes.NOT_FOUND).json({ message: error.message });
      return;
    }
    
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error fetching admin',
      error: error.message
    });
  }
};

// Create new admin (super-admin only)
export const createAdmin = async (req, res) => {
  try {
    // Check if user is super-admin
    if (req.user.adminRole !== 'super-admin') {
      return res.status(StatusCodes.FORBIDDEN).json({ 
        message: 'Access denied. Super-admin privileges required.' 
      });
    }

    const { username, name, email, password, role } = req.body;
    
    // Validate required fields
    if (!username || !name || !email || !password) {
      throw new BadRequestError('Username, name, email, and password are required');
    }

    // Validate role
    if (role && !['admin', 'super-admin'].includes(role)) {
      throw new BadRequestError('Invalid role. Must be admin or super-admin');
    }

    // Check if username already exists
    const existingUsername = await Admin.findOne({ username });
    if (existingUsername) {
      throw new BadRequestError('Username already exists');
    }

    // Check if email already exists
    const existingEmail = await Admin.findOne({ email });
    if (existingEmail) {
      throw new BadRequestError('Email already exists');
    }

    // Create new admin
    const admin = await Admin.create({
      username,
      name,
      email,
      password,
      role: role || 'admin',
      createdBy: req.user.id
    });

    // Log activity
    await logActivity(
      req.user.id,
      req.user.name || req.user.username,
      'CREATED_ADMIN',
      'ADMIN',
      admin._id,
      admin.name,
      `Created new ${admin.role} account: ${admin.username}`,
      { username: admin.username, email: admin.email, role: admin.role },
      req.ip
    );

    const adminResponse = await Admin.findById(admin._id).select('-password');
    
    res.status(StatusCodes.CREATED).json({
      message: 'Admin created successfully',
      admin: adminResponse
    });
  } catch (error) {
    console.error('Error creating admin:', error);
    
    if (error.name === 'BadRequestError') {
      res.status(StatusCodes.BAD_REQUEST).json({ message: error.message });
      return;
    }
    
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error creating admin',
      error: error.message
    });
  }
};

// Update admin (super-admin only, or admin updating their own profile)
export const updateAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { username, name, email, role, isActive, password, currentPassword } = req.body;
    
    // Check permissions
    const isSuperAdmin = req.user.adminRole === 'super-admin';
    const isSelfUpdate = req.user.id === id;
    
    if (!isSuperAdmin && !isSelfUpdate) {
      return res.status(StatusCodes.FORBIDDEN).json({ 
        message: 'Access denied.' 
      });
    }

    const admin = await Admin.findById(id);
    
    if (!admin) {
      throw new NotFoundError(`No admin found with id ${id}`);
    }

    const oldData = {
      username: admin.username,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      isActive: admin.isActive
    };

    // Update fields
    if (username !== undefined && username !== admin.username) {
      // Check if new username is taken
      const existingUsername = await Admin.findOne({ username, _id: { $ne: id } });
      if (existingUsername) {
        throw new BadRequestError('Username already exists');
      }
      admin.username = username;
    }

    if (name !== undefined) admin.name = name;

    // Prevent email changes for security reasons
    // Email changes should only be done by super-admin through a separate secure process
    if (email !== undefined && email !== admin.email) {
      console.log('⚠️ Email change attempt blocked for security reasons');
      throw new BadRequestError('Email addresses cannot be changed for security reasons. Contact a super-admin if you need to change your email.');
    }

    // Handle password update if provided
    if (password !== undefined && password.trim() !== '') {
      // Validate password length
      if (password.length < 6) {
        throw new BadRequestError('Password must be at least 6 characters long');
      }
      
      // If this is a self-update (admin changing their own password), verify current password
      if (isSelfUpdate && !isSuperAdmin) {
        // Current password is required for self password changes
        if (!currentPassword || currentPassword.trim() === '') {
          throw new BadRequestError('Current password is required to change your password');
        }
        
        // Verify current password is correct
        console.log(`🔐 Verifying current password for admin: ${admin.username}`);
        const isCurrentPasswordCorrect = await admin.comparePassword(currentPassword);
        
        if (!isCurrentPasswordCorrect) {
          console.log(`❌ Current password verification failed for admin: ${admin.username}`);
          throw new BadRequestError('Current password is incorrect');
        }
        
        console.log(`✅ Current password verified successfully for admin: ${admin.username}`);
      }
      
      // If super-admin is changing another admin's password, no current password needed
      console.log(`🔐 Updating password for admin: ${admin.username}`);
      console.log(`🔐 Password before update: ${admin.password.substring(0, 10)}...`);
      console.log(`🔐 New password (plain): ${password}`);
      console.log(`🔐 Is password modified before setting: ${admin.isModified('password')}`);
      
      admin.password = password; // Will be hashed by the pre-save hook in Admin model
      admin.markModified('password'); // Explicitly mark password as modified to ensure pre-save hook runs
      
      console.log(`🔐 Is password modified after setting: ${admin.isModified('password')}`);
      console.log(`🔐 Password after setting (should still be plain): ${admin.password}`);
    }

    // Only super-admin can change role and active status
    if (isSuperAdmin) {
      if (role !== undefined && ['admin', 'super-admin'].includes(role)) {
        admin.role = role;
      }
      if (isActive !== undefined) {
        admin.isActive = isActive;
      }
    }

    console.log(`💾 Saving admin with password modified: ${admin.isModified('password')}`);
    await admin.save();
    console.log(`✅ Admin saved. Password after save: ${admin.password.substring(0, 10)}...`);

    // Log activity
    const changes = [];
    if (oldData.username !== admin.username) changes.push(`username: ${oldData.username} → ${admin.username}`);
    if (oldData.name !== admin.name) changes.push(`name: ${oldData.name} → ${admin.name}`);
    if (oldData.email !== admin.email) changes.push(`email: ${oldData.email} → ${admin.email}`);
    if (oldData.role !== admin.role) changes.push(`role: ${oldData.role} → ${admin.role}`);
    if (oldData.isActive !== admin.isActive) changes.push(`status: ${oldData.isActive ? 'active' : 'inactive'} → ${admin.isActive ? 'active' : 'inactive'}`);
    if (password !== undefined && password.trim() !== '') changes.push('password updated');

    await logActivity(
      req.user.id,
      req.user.name || req.user.username,
      'UPDATED_ADMIN',
      'ADMIN',
      admin._id,
      admin.name,
      `Updated admin account: ${changes.join(', ')}`,
      { oldData, newData: { username: admin.username, name: admin.name, email: admin.email, role: admin.role, isActive: admin.isActive } },
      req.ip
    );

    const updatedAdmin = await Admin.findById(id).select('-password');
    
    res.status(StatusCodes.OK).json({
      message: 'Admin updated successfully',
      admin: updatedAdmin
    });
  } catch (error) {
    console.error(`Error updating admin ${req.params.id}:`, error);
    
    // Check for custom errors by statusCode
    if (error.statusCode === StatusCodes.NOT_FOUND) {
      return res.status(StatusCodes.NOT_FOUND).json({ message: error.message });
    }
    
    if (error.statusCode === StatusCodes.BAD_REQUEST) {
      return res.status(StatusCodes.BAD_REQUEST).json({ message: error.message });
    }
    
    // Generic error response
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error updating admin',
      error: error.message
    });
  }
};

// Delete admin (super-admin only)
export const deleteAdmin = async (req, res) => {
  try {
    // Check if user is super-admin
    if (req.user.adminRole !== 'super-admin') {
      return res.status(StatusCodes.FORBIDDEN).json({ 
        message: 'Access denied. Super-admin privileges required.' 
      });
    }

    const { id } = req.params;
    
    // Prevent deleting yourself
    if (req.user.id === id) {
      throw new BadRequestError('You cannot delete your own account');
    }

    const admin = await Admin.findById(id);
    
    if (!admin) {
      throw new NotFoundError(`No admin found with id ${id}`);
    }

    await Admin.findByIdAndDelete(id);

    // Log activity
    await logActivity(
      req.user.id,
      req.user.name || req.user.username,
      'DELETED_ADMIN',
      'ADMIN',
      admin._id,
      admin.name,
      `Deleted admin account: ${admin.username} (${admin.email})`,
      { username: admin.username, email: admin.email, role: admin.role },
      req.ip
    );
    
    res.status(StatusCodes.OK).json({
      message: 'Admin deleted successfully',
      adminId: id
    });
  } catch (error) {
    console.error(`Error deleting admin ${req.params.id}:`, error);
    
    if (error.name === 'NotFoundError') {
      res.status(StatusCodes.NOT_FOUND).json({ message: error.message });
      return;
    }
    
    if (error.name === 'BadRequestError') {
      res.status(StatusCodes.BAD_REQUEST).json({ message: error.message });
      return;
    }
    
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error deleting admin',
      error: error.message
    });
  }
};

// Toggle admin active status (super-admin only)
export const toggleAdminStatus = async (req, res) => {
  try {
    console.log('🔄 Toggle admin status request received');
    console.log('👤 Requesting user:', req.user);
    console.log('🎯 Target admin ID:', req.params.id);
    
    // Check if user is super-admin
    if (req.user.adminRole !== 'super-admin') {
      console.log('❌ Access denied - not super-admin');
      return res.status(StatusCodes.FORBIDDEN).json({ 
        message: 'Access denied. Super-admin privileges required.' 
      });
    }

    const { id } = req.params;
    
    // Prevent deactivating yourself
    if (req.user.id === id) {
      console.log('❌ Cannot deactivate own account');
      throw new BadRequestError('You cannot deactivate your own account');
    }

    const admin = await Admin.findById(id);
    
    if (!admin) {
      console.log('❌ Admin not found:', id);
      throw new NotFoundError(`No admin found with id ${id}`);
    }

    console.log('📝 Current admin status:', admin.isActive);
    admin.isActive = !admin.isActive;
    await admin.save();
    console.log('✅ New admin status:', admin.isActive);

    // Log activity
    await logActivity(
      req.user.id,
      req.user.name || req.user.username,
      admin.isActive ? 'ACTIVATED_ADMIN' : 'DEACTIVATED_ADMIN',
      'ADMIN',
      admin._id,
      admin.name,
      `${admin.isActive ? 'Activated' : 'Deactivated'} admin account: ${admin.username}`,
      { username: admin.username, email: admin.email, isActive: admin.isActive },
      req.ip
    );

    const updatedAdmin = await Admin.findById(id).select('-password');
    
    console.log('✅ Toggle admin status successful');
    res.status(StatusCodes.OK).json({
      message: `Admin ${admin.isActive ? 'activated' : 'deactivated'} successfully`,
      admin: updatedAdmin
    });
  } catch (error) {
    console.error(`❌ Error toggling admin status ${req.params.id}:`, error);
    
    if (error.name === 'NotFoundError') {
      res.status(StatusCodes.NOT_FOUND).json({ message: error.message });
      return;
    }
    
    if (error.name === 'BadRequestError') {
      res.status(StatusCodes.BAD_REQUEST).json({ message: error.message });
      return;
    }
    
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error toggling admin status',
      error: error.message
    });
  }
};

// Get all activity logs
export const getActivityLogs = async (req, res) => {
  try {
    const { action, targetType, startDate, endDate, adminId, limit = 100 } = req.query;
    const queryObject = {};
    
    // Filter by action
    if (action) {
      queryObject.action = action;
    }
    
    // Filter by target type
    if (targetType) {
      queryObject.targetType = targetType;
    }
    
    // Filter by admin
    if (adminId) {
      queryObject.admin = adminId;
    }
    
    // Filter by date range
    if (startDate || endDate) {
      queryObject.createdAt = {};
      if (startDate) {
        queryObject.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        queryObject.createdAt.$lte = new Date(endDate);
      }
    }
    
    const logs = await ActivityLog.find(queryObject)
      .populate('admin', 'name username email')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    
    res.status(StatusCodes.OK).json({
      count: logs.length,
      logs
    });
  } catch (error) {
    console.error('Error fetching activity logs:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error fetching activity logs',
      error: error.message
    });
  }
};

// Admin login with rate limiting and lockout protection
export const adminLogin = async (req, res) => {
  const ipAddress = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new BadRequestError('Please provide email and password');
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
      console.log(`⏱️ Lockout remaining: ${lockoutStatus.remainingTime} minutes`);
      
      // Record this blocked attempt
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
    // STEP 2: Find admin by email
    // ============================================
    const admin = await Admin.findOne({ email: normalizedEmail });
    
    if (!admin) {
      console.log(`❌ Login failed - Admin not found: ${normalizedEmail}`);
      
      // Record failed attempt - invalid email
      await LoginAttempt.recordAttempt({
        email: normalizedEmail,
        ipAddress,
        userAgent,
        success: false,
        failureReason: 'invalid_email',
        attemptType: 'admin'
      });
      
      // Get updated lockout status to show remaining attempts
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
    // STEP 3: Check if admin account is active
    // ============================================
    if (!admin.isActive) {
      console.log(`❌ Login failed - Account inactive: ${normalizedEmail}`);
      
      // Record failed attempt - account inactive
      await LoginAttempt.recordAttempt({
        email: normalizedEmail,
        ipAddress,
        userAgent,
        success: false,
        failureReason: 'account_inactive',
        attemptType: 'admin'
      });
      
      return res.status(StatusCodes.UNAUTHORIZED).json({
        message: 'Your account has been deactivated. Please contact a super-admin.'
      });
    }

    // ============================================
    // STEP 4: Verify password
    // ============================================
    const isPasswordCorrect = await admin.comparePassword(password);
    
    if (!isPasswordCorrect) {
      console.log(`❌ Login failed - Invalid password: ${normalizedEmail}`);
      
      // Record failed attempt - invalid password
      await LoginAttempt.recordAttempt({
        email: normalizedEmail,
        ipAddress,
        userAgent,
        success: false,
        failureReason: 'invalid_password',
        attemptType: 'admin'
      });
      
      // Get updated lockout status
      const updatedStatus = await LoginAttempt.checkLockoutStatus(
        normalizedEmail,
        LOGIN_CONFIG.MAX_ATTEMPTS,
        LOGIN_CONFIG.LOCKOUT_MINUTES
      );
      
      // Check if this attempt triggered a lockout
      if (updatedStatus.isLocked) {
        console.log(`🔒 Account now locked: ${normalizedEmail}`);
        
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
    // STEP 5: Successful login - Clear failed attempts
    // ============================================
    console.log(`✅ Login successful: ${normalizedEmail}`);
    
    // Record successful login
    await LoginAttempt.recordAttempt({
      email: normalizedEmail,
      ipAddress,
      userAgent,
      success: true,
      attemptType: 'admin'
    });
    
    // Clear all previous failed attempts on successful login
    if (LOGIN_CONFIG.CLEAR_ON_SUCCESS) {
      await LoginAttempt.clearFailedAttempts(normalizedEmail);
      console.log(`🧹 Cleared failed login attempts for: ${normalizedEmail}`);
    }

    // Update last login timestamp
    admin.lastLogin = new Date();
    await admin.save();

    // Generate tokens
    const accessToken = admin.createAccessToken();
    const refreshToken = admin.createRefreshToken();

    // Log successful login activity
    await logActivity(
      admin._id,
      admin.name || admin.username,
      'ADMIN_LOGIN',
      'ADMIN',
      admin._id,
      admin.name,
      `Admin logged in successfully from IP: ${ipAddress}`,
      { ipAddress, userAgent },
      ipAddress
    );

    // Return admin data without password
    const adminData = {
      _id: admin._id,
      username: admin.username,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      isActive: admin.isActive,
      lastLogin: admin.lastLogin
    };

    return res.status(StatusCodes.OK).json({
      message: 'Admin logged in successfully',
      user: adminData,
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (error) {
    console.error('Admin login error:', error);
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    
    // Check by statusCode first (more reliable)
    if (error.statusCode === StatusCodes.BAD_REQUEST || error.statusCode === StatusCodes.UNAUTHORIZED) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    
    // Check by error name as fallback
    if (error.name === 'BadRequestError' || error.name === 'UnauthenticatedError') {
      return res.status(StatusCodes.UNAUTHORIZED).json({ message: error.message });
    }
    
    // Generic error response
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error during login',
      error: error.message
    });
  }
};

// Get login attempts for an admin (super-admin only)
export const getLoginAttempts = async (req, res) => {
  try {
    // Check if user is super-admin
    if (req.user.adminRole !== 'super-admin') {
      return res.status(StatusCodes.FORBIDDEN).json({ 
        message: 'Access denied. Super-admin privileges required.' 
      });
    }

    const { email, limit = 20 } = req.query;
    
    if (!email) {
      throw new BadRequestError('Email is required');
    }

    const attempts = await LoginAttempt.getLoginHistory(email, parseInt(limit));
    const lockoutStatus = await LoginAttempt.checkLockoutStatus(
      email,
      LOGIN_CONFIG.MAX_ATTEMPTS,
      LOGIN_CONFIG.LOCKOUT_MINUTES
    );

    return res.status(StatusCodes.OK).json({
      email,
      lockoutStatus,
      attempts,
      config: {
        maxAttempts: LOGIN_CONFIG.MAX_ATTEMPTS,
        lockoutMinutes: LOGIN_CONFIG.LOCKOUT_MINUTES
      }
    });
  } catch (error) {
    console.error('Error fetching login attempts:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error fetching login attempts',
      error: error.message
    });
  }
};

// Manually unlock an admin account (super-admin only)
export const unlockAdminAccount = async (req, res) => {
  try {
    // Check if user is super-admin
    if (req.user.adminRole !== 'super-admin') {
      return res.status(StatusCodes.FORBIDDEN).json({ 
        message: 'Access denied. Super-admin privileges required.' 
      });
    }

    const { email } = req.body;
    
    if (!email) {
      throw new BadRequestError('Email is required');
    }

    // Clear all failed attempts for this email
    const result = await LoginAttempt.clearFailedAttempts(email);
    
    // Log activity
    await logActivity(
      req.user.id,
      req.user.name || req.user.username,
      'UNLOCKED_ADMIN_ACCOUNT',
      'ADMIN',
      null,
      email,
      `Manually unlocked admin account: ${email}`,
      { email },
      req.ip
    );

    console.log(`🔓 Admin account manually unlocked: ${email}`);

    return res.status(StatusCodes.OK).json({
      message: `Account ${email} has been unlocked successfully`,
      email
    });
  } catch (error) {
    console.error('Error unlocking admin account:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error unlocking admin account',
      error: error.message
    });
  }
};

// Check lockout status for an email (public endpoint - for login page)
export const checkLockoutStatus = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(StatusCodes.BAD_REQUEST).json({ 
        message: 'Email is required' 
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    
    const lockoutStatus = await LoginAttempt.checkLockoutStatus(
      normalizedEmail,
      LOGIN_CONFIG.MAX_ATTEMPTS,
      LOGIN_CONFIG.LOCKOUT_MINUTES
    );

    return res.status(StatusCodes.OK).json({
      email: normalizedEmail,
      isLocked: lockoutStatus.isLocked,
      remainingTime: lockoutStatus.remainingTime,
      remainingSeconds: lockoutStatus.remainingSeconds,
      lockoutEndsAt: lockoutStatus.lockoutEndsAt || null,
      attemptsRemaining: lockoutStatus.attemptsRemaining,
      failedAttempts: lockoutStatus.failedAttempts,
      maxAttempts: LOGIN_CONFIG.MAX_ATTEMPTS,
      lockoutMinutes: LOGIN_CONFIG.LOCKOUT_MINUTES
    });
  } catch (error) {
    console.error('Error checking lockout status:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error checking lockout status',
      error: error.message
    });
  }
};
