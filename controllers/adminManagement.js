import Admin from '../models/Admin.js';
import ActivityLog from '../models/ActivityLog.js';
import { StatusCodes } from 'http-status-codes';
import { BadRequestError, NotFoundError, UnauthenticatedError } from '../errors/index.js';

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

// Admin login
export const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new BadRequestError('Please provide email and password');
    }

    const admin = await Admin.findOne({ email });
    
    if (!admin) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    // Check if admin is active
    if (!admin.isActive) {
      throw new UnauthenticatedError('Your account has been deactivated. Please contact a super-admin.');
    }

    const isPasswordCorrect = await admin.comparePassword(password);
    if (!isPasswordCorrect) {
      throw new UnauthenticatedError('Invalid credentials');
    }

    // Update last login
    admin.lastLogin = new Date();
    await admin.save();

    const accessToken = admin.createAccessToken();
    const refreshToken = admin.createRefreshToken();

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
    
    if (error.name === 'BadRequestError' || error.name === 'UnauthenticatedError') {
      res.status(StatusCodes.UNAUTHORIZED).json({ message: error.message });
      return;
    }
    
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error during login',
      error: error.message
    });
  }
};
