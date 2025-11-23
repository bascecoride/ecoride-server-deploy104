import User from '../models/User.js';
import Ride from '../models/Ride.js';
import { StatusCodes } from 'http-status-codes';
import { BadRequestError, NotFoundError } from '../errors/index.js';
import { logActivity } from './adminManagement.js';
import { sendApprovalEmail, sendDisapprovalEmail } from '../utils/emailService.js';

// Get all users
export const getAllUsers = async (req, res) => {
  try {
    // Support filtering by role, status, sex, etc.
    const { role, status, search, sex, userRole, vehicleType, hasDocuments } = req.query;
    const queryObject = {};
    
    // Handle role filter
    if (role) {
      queryObject.role = role;
    }
    
    // Handle status filter
    if (status) {
      queryObject.status = status;
    }
    
    // Handle sex filter
    if (sex) {
      queryObject.sex = sex;
    }
    
    // Handle userRole filter (for customers)
    if (userRole) {
      queryObject.userRole = userRole;
    }
    
    // Handle vehicleType filter (for riders)
    if (vehicleType) {
      queryObject.vehicleType = vehicleType;
    }
    
    // Handle document filter
    if (hasDocuments === 'true') {
      queryObject.$or = [
        { photo: { $exists: true, $ne: null } },
        { schoolIdDocument: { $exists: true, $ne: null } },
        { staffFacultyIdDocument: { $exists: true, $ne: null } },
        { driverLicense: { $exists: true, $ne: null } },
        { cor: { $exists: true, $ne: null } }
      ];
    } else if (hasDocuments === 'false') {
      queryObject.$and = [
        { photo: { $in: [null, undefined, ''] } },
        { schoolIdDocument: { $in: [null, undefined, ''] } },
        { staffFacultyIdDocument: { $in: [null, undefined, ''] } },
        { driverLicense: { $in: [null, undefined, ''] } },
        { cor: { $in: [null, undefined, ''] } }
      ];
    }
    
    // Handle search filter
    if (search) {
      // If we already have $or or $and, we need to use $and to combine with search
      const searchCondition = {
        $or: [
          { firstName: { $regex: search, $options: 'i' } },
          { lastName: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { phone: { $regex: search, $options: 'i' } }
        ]
      };
      
      if (queryObject.$or || queryObject.$and) {
        // Create an $and condition if it doesn't exist
        queryObject.$and = queryObject.$and || [];
        // Add the search condition to the $and array
        queryObject.$and.push(searchCondition);
        
        // If we have an $or condition but not in $and, move it to $and
        if (queryObject.$or && !queryObject.$and.includes(queryObject.$or)) {
          queryObject.$and.push({ $or: queryObject.$or });
          delete queryObject.$or;
        }
      } else {
        // Simple case: just add the $or for search
        queryObject.$or = searchCondition.$or;
      }
    }
    
    console.log('Fetching users with query:', JSON.stringify(queryObject, null, 2));
    
    // Exclude admin users from the results
    if (queryObject.$and) {
      queryObject.$and.push({ role: { $ne: 'admin' } });
    } else {
      queryObject.role = { $ne: 'admin' };
    }
    
    const users = await User.find(queryObject).select('-password').sort({ createdAt: -1 });
    
    console.log(`Found ${users.length} users`);
    
    res.status(StatusCodes.OK).json({
      count: users.length,
      users
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error fetching users',
      error: error.message
    });
  }
};

// Get user by ID
export const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id).select('-password');
    
    if (!user) {
      throw new NotFoundError(`No user found with id ${id}`);
    }
    
    res.status(StatusCodes.OK).json({ user });
  } catch (error) {
    console.error(`Error fetching user ${req.params.id}:`, error);
    
    if (error.name === 'NotFoundError') {
      res.status(StatusCodes.NOT_FOUND).json({ message: error.message });
      return;
    }
    
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error fetching user',
      error: error.message
    });
  }
};

// Approve user
export const approveUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    
    if (!user) {
      throw new NotFoundError(`No user found with id ${id}`);
    }
    
    user.status = "approved";
    await user.save();
    
    const updatedUser = await User.findById(id).select('-password');
    
    // Log activity
    await logActivity(
      req.user?.id,
      req.user?.name || req.user?.username || 'Admin',
      'APPROVED_USER',
      'USER',
      user._id,
      `${user.firstName} ${user.lastName}`,
      `Approved ${user.role} account: ${user.firstName} ${user.lastName} (${user.email})`,
      { userId: user._id, email: user.email, role: user.role },
      req.ip
    );
    
    // Send approval email notification
    if (user.email) {
      const userName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'User';
      const emailSent = await sendApprovalEmail(user.email, userName, user.role);
      
      if (emailSent) {
        console.log(`✅ Approval notification email sent to ${user.email}`);
      } else {
        console.log(`⚠️ Failed to send approval email to ${user.email}, but user was approved`);
      }
    }
    
    res.status(StatusCodes.OK).json({
      message: 'User approved successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error(`Error approving user ${req.params.id}:`, error);
    
    if (error.name === 'NotFoundError') {
      res.status(StatusCodes.NOT_FOUND).json({ message: error.message });
      return;
    }
    
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error approving user',
      error: error.message
    });
  }
};

// Disapprove user
export const disapproveUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, rejectionDeadline } = req.body;
    const user = await User.findById(id);
    
    if (!user) {
      throw new NotFoundError(`No user found with id ${id}`);
    }
    
    user.status = "disapproved";
    user.disapprovalReason = reason || 'No reason provided';
    
    // Set rejection deadline if provided
    if (rejectionDeadline) {
      user.rejectionDeadline = new Date(rejectionDeadline);
      console.log(`📅 Rejection deadline set for user ${id}: ${user.rejectionDeadline}`);
    }
    
    await user.save();
    
    const updatedUser = await User.findById(id).select('-password');
    
    // Log activity
    await logActivity(
      req.user?.id,
      req.user?.name || req.user?.username || 'Admin',
      'DISAPPROVED_USER',
      'USER',
      user._id,
      `${user.firstName} ${user.lastName}`,
      `Disapproved ${user.role} account: ${user.firstName} ${user.lastName}. Reason: ${reason || 'No reason provided'}`,
      { userId: user._id, email: user.email, role: user.role, reason, rejectionDeadline },
      req.ip
    );
    
    // Send disapproval email notification
    if (user.email) {
      const userName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'User';
      const disapprovalReason = reason || 'No specific reason provided';
      const emailSent = await sendDisapprovalEmail(user.email, userName, user.role, disapprovalReason);
      
      if (emailSent) {
        console.log(`📧 Disapproval notification email sent to ${user.email}`);
      } else {
        console.log(`⚠️ Failed to send disapproval email to ${user.email}, but user was disapproved`);
      }
    }
    
    // Emit real-time socket event to notify user of disapproval
    if (req.io) {
      try {
        // Find all sockets for this user and emit disapproval event
        const sockets = await req.io.fetchSockets();
        const userSocket = sockets.find(s => s.user?.id === id);
        
        if (userSocket) {
          console.log(`🔔 Emitting accountDisapproved event to user ${id} (socket: ${userSocket.id})`);
          userSocket.emit('accountDisapproved', {
            reason: reason || 'Your account has been disapproved by an administrator',
            timestamp: new Date().toISOString()
          });
        } else {
          console.log(`⚠️ User ${id} is not currently connected via socket`);
        }
      } catch (socketError) {
        console.error(`⚠️ Error emitting disapproval socket event:`, socketError.message);
        // Don't fail the request if socket emission fails
      }
    }
    
    res.status(StatusCodes.OK).json({
      message: 'User disapproved successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error(`Error disapproving user ${req.params.id}:`, error);
    
    if (error.name === 'NotFoundError') {
      res.status(StatusCodes.NOT_FOUND).json({ message: error.message });
      return;
    }
    
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error disapproving user',
      error: error.message
    });
  }
};

// Update user
export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      firstName, 
      middleName, 
      lastName, 
      email, 
      phone, 
      role, 
      sex, 
      schoolId, 
      licenseId, 
      approved,
      vehicleType,
      userRole
    } = req.body;
    
    console.log('📥 Update user request received for ID:', id);
    console.log('📦 Request body:', req.body);
    
    const user = await User.findById(id);
    
    if (!user) {
      throw new NotFoundError(`No user found with id ${id}`);
    }
    
    console.log('👤 Current user role:', user.role);
    console.log('📝 Current user data:', {
      firstName: user.firstName,
      lastName: user.lastName,
      userRole: user.userRole,
      schoolId: user.schoolId,
      vehicleType: user.vehicleType,
      licenseId: user.licenseId
    });
    
    // Update fields if provided (skip empty strings for enum fields)
    if (firstName !== undefined) user.firstName = firstName;
    if (middleName !== undefined) user.middleName = middleName;
    if (lastName !== undefined) user.lastName = lastName;
    if (phone !== undefined) user.phone = phone;
    if (schoolId !== undefined) user.schoolId = schoolId;
    if (licenseId !== undefined) user.licenseId = licenseId;
    if (sex !== undefined && sex !== '') user.sex = sex;
    if (approved !== undefined) user.approved = approved;
    // Only update vehicleType if it's a valid value (not empty string)
    if (vehicleType !== undefined && vehicleType !== '') user.vehicleType = vehicleType;
    if (userRole !== undefined && userRole !== '') user.userRole = userRole;
    
    console.log('📝 Updated user data before save:', {
      firstName: user.firstName,
      lastName: user.lastName,
      userRole: user.userRole,
      schoolId: user.schoolId,
      vehicleType: user.vehicleType,
      licenseId: user.licenseId
    });
    
    // Email update requires special handling to check for duplicates
    if (email !== undefined && email !== user.email) {
      const existingUser = await User.findOne({ email, _id: { $ne: id } });
      if (existingUser) {
        throw new BadRequestError('Email already in use');
      }
      user.email = email;
    }
    
    // Role change requires validation
    if (role !== undefined && role !== user.role) {
      if (!['customer', 'rider'].includes(role)) {
        throw new BadRequestError('Invalid role. Must be customer or rider');
      }
      user.role = role;
    }
    
    await user.save();
    console.log('💾 User saved successfully');
    
    const updatedUser = await User.findById(id).select('-password');
    console.log('✅ Updated user data after save:', {
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      userRole: updatedUser.userRole,
      schoolId: updatedUser.schoolId,
      vehicleType: updatedUser.vehicleType,
      licenseId: updatedUser.licenseId
    });
    
    // Log activity
    const changedFields = [];
    if (firstName !== undefined) changedFields.push('firstName');
    if (middleName !== undefined) changedFields.push('middleName');
    if (lastName !== undefined) changedFields.push('lastName');
    if (email !== undefined) changedFields.push('email');
    if (phone !== undefined) changedFields.push('phone');
    if (role !== undefined) changedFields.push('role');
    if (sex !== undefined) changedFields.push('sex');
    if (schoolId !== undefined) changedFields.push('schoolId');
    if (licenseId !== undefined) changedFields.push('licenseId');
    if (vehicleType !== undefined) changedFields.push('vehicleType');
    if (userRole !== undefined) changedFields.push('userRole');
    
    await logActivity(
      req.user?.id,
      req.user?.name || req.user?.username || 'Admin',
      'EDITED_USER',
      'USER',
      user._id,
      `${user.firstName} ${user.lastName}`,
      `Edited ${user.role} account: ${user.firstName} ${user.lastName}. Updated fields: ${changedFields.join(', ')}`,
      { userId: user._id, email: user.email, role: user.role, updatedFields: changedFields },
      req.ip
    );
    
    res.status(StatusCodes.OK).json({
      message: 'User updated successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error(`Error updating user ${req.params.id}:`, error);
    
    if (error.name === 'NotFoundError') {
      res.status(StatusCodes.NOT_FOUND).json({ message: error.message });
      return;
    }
    
    if (error.name === 'BadRequestError') {
      res.status(StatusCodes.BAD_REQUEST).json({ message: error.message });
      return;
    }
    
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error updating user',
      error: error.message
    });
  }
};

// Add penalty comment to user
export const addPenaltyComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { penaltyComment, penaltyLiftDate } = req.body;
    
    const user = await User.findById(id);
    
    if (!user) {
      throw new NotFoundError(`No user found with id ${id}`);
    }
    
    // Check if this is a penalty removal (empty comment or past date)
    const isRemoval = !penaltyComment || penaltyComment.trim() === '' || 
                      (penaltyLiftDate && new Date(penaltyLiftDate) < new Date());
    
    if (isRemoval) {
      // Remove penalty
      user.penaltyComment = '';
      user.penaltyLiftDate = null;
      await user.save();
      
      const updatedUser = await User.findById(id).select('-password');
      
      return res.status(StatusCodes.OK).json({
        message: 'Penalty removed successfully',
        user: updatedUser
      });
    }
    
    // Adding/updating penalty - validate required fields
    if (!penaltyComment || penaltyComment.trim() === '') {
      throw new BadRequestError('Penalty comment is required');
    }
    
    if (!penaltyLiftDate) {
      throw new BadRequestError('Penalty lift date is required');
    }
    
    // Check if user is disapproved
    if (user.status !== 'disapproved') {
      throw new BadRequestError('User must be disapproved before adding a penalty');
    }
    
    user.penaltyComment = penaltyComment;
    user.penaltyLiftDate = new Date(penaltyLiftDate);
    await user.save();
    
    const updatedUser = await User.findById(id).select('-password');
    
    // Log activity
    await logActivity(
      req.user?.id,
      req.user?.name || req.user?.username || 'Admin',
      'ADDED_PENALTY',
      'USER',
      user._id,
      `${user.firstName} ${user.lastName}`,
      `Added penalty to ${user.role} account: ${user.firstName} ${user.lastName}. Reason: ${penaltyComment}. Lift date: ${penaltyLiftDate}`,
      { userId: user._id, email: user.email, role: user.role, penaltyComment, penaltyLiftDate },
      req.ip
    );
    
    res.status(StatusCodes.OK).json({
      message: 'Penalty added successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error(`Error adding penalty comment to user ${req.params.id}:`, error);
    
    if (error.name === 'NotFoundError') {
      res.status(StatusCodes.NOT_FOUND).json({ message: error.message });
      return;
    }
    
    if (error.name === 'BadRequestError') {
      res.status(StatusCodes.BAD_REQUEST).json({ message: error.message });
      return;
    }
    
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: 'Error adding penalty comment',
      error: error.message
    });
  }
};

// Delete user
export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    
    if (!user) {
      throw new NotFoundError(`No user found with id ${id}`);
    }
    
    // Store user data before deletion for logging
    const userData = {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role
    };
    
    await User.findByIdAndDelete(id);
    
    // Log activity
    await logActivity(
      req.user?.id,
      req.user?.name || req.user?.username || 'Admin',
      'DELETED_USER',
      'USER',
      id,
      `${userData.firstName} ${userData.lastName}`,
      `Deleted ${userData.role} account: ${userData.firstName} ${userData.lastName} (${userData.email})`,
      { userId: id, email: userData.email, role: userData.role },
      req.ip
    );
    
    res.status(StatusCodes.OK).json({
      message: 'User deleted successfully',
      userId: id
    });
  } catch (error) {
    console.error(`Error deleting user ${req.params.id}:`, error);
    
    if (error.name === 'NotFoundError') {
      res.status(StatusCodes.NOT_FOUND).json({ message: error.message });
      return;
    }
    
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error deleting user',
      error: error.message
    });
  }
};

// Get all rides for admin
export const getAllRides = async (req, res) => {
  try {
    const { status, vehicle, search, startDate, endDate } = req.query;
    const queryObject = {};
    
    // Filter by status
    if (status) {
      queryObject.status = status;
    }
    
    // Filter by vehicle type
    if (vehicle) {
      queryObject.vehicle = vehicle;
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
    
    console.log('Fetching rides with query:', JSON.stringify(queryObject, null, 2));
    
    // Fetch rides with populated customer and rider data
    let rides = await Ride.find(queryObject)
      .populate('customer', 'firstName lastName phone email')
      .populate('rider', 'firstName lastName phone email vehicleType')
      .sort({ createdAt: -1 });
    
    // Apply search filter if provided (search in customer/rider names, OTP, addresses)
    if (search) {
      const searchLower = search.toLowerCase();
      rides = rides.filter(ride => {
        const customerName = `${ride.customer?.firstName || ''} ${ride.customer?.lastName || ''}`.toLowerCase();
        const riderName = `${ride.rider?.firstName || ''} ${ride.rider?.lastName || ''}`.toLowerCase();
        const otp = ride.otp || '';
        const pickupAddress = ride.pickup?.address?.toLowerCase() || '';
        const dropAddress = ride.drop?.address?.toLowerCase() || '';
        
        return customerName.includes(searchLower) ||
               riderName.includes(searchLower) ||
               otp.includes(searchLower) ||
               pickupAddress.includes(searchLower) ||
               dropAddress.includes(searchLower);
      });
    }
    
    console.log(`Found ${rides.length} rides`);
    
    res.status(StatusCodes.OK).json({
      count: rides.length,
      rides
    });
  } catch (error) {
    console.error('Error fetching rides:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Error fetching rides',
      error: error.message
    });
  }
};
