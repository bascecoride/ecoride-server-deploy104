import FareRate from '../models/FareRate.js';
import { StatusCodes } from 'http-status-codes';
import { BadRequestError, NotFoundError } from '../errors/index.js';
import ActivityLog from '../models/ActivityLog.js';
import Admin from '../models/Admin.js';

// Helper function to get admin name
const getAdminName = async (adminId) => {
  try {
    const admin = await Admin.findById(adminId);
    return admin ? `${admin.firstName} ${admin.lastName}` : 'Unknown Admin';
  } catch (error) {
    return 'Unknown Admin';
  }
};

// Get all fare rates
export const getAllFareRates = async (req, res) => {
  try {
    const fareRates = await FareRate.find().populate('updatedBy', 'firstName lastName email');
    
    // If no fare rates exist, create default ones
    if (fareRates.length === 0) {
      const defaultRates = [
        { vehicleType: "Single Motorcycle", minimumRate: 15, perKmRate: 2.5 },
        { vehicleType: "Tricycle", minimumRate: 20, perKmRate: 2.8 },
        { vehicleType: "Cab", minimumRate: 30, perKmRate: 3 },
      ];
      
      const createdRates = await FareRate.insertMany(defaultRates);
      return res.status(StatusCodes.OK).json({ fareRates: createdRates });
    }
    
    res.status(StatusCodes.OK).json({ fareRates });
  } catch (error) {
    console.error('Error fetching fare rates:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Failed to fetch fare rates',
      error: error.message 
    });
  }
};

// Get fare rate by vehicle type
export const getFareRateByVehicle = async (req, res) => {
  try {
    const { vehicleType } = req.params;
    
    const fareRate = await FareRate.findOne({ vehicleType }).populate('updatedBy', 'firstName lastName email');
    
    if (!fareRate) {
      throw new NotFoundError(`Fare rate not found for vehicle type: ${vehicleType}`);
    }
    
    res.status(StatusCodes.OK).json({ fareRate });
  } catch (error) {
    console.error('Error fetching fare rate:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Failed to fetch fare rate',
      error: error.message 
    });
  }
};

// Update fare rate (Admin/SuperAdmin only)
export const updateFareRate = async (req, res) => {
  try {
    const { vehicleType } = req.params;
    const { minimumRate, perKmRate } = req.body;
    const adminId = req.user.id;
    
    // Validation
    if (minimumRate !== undefined && (minimumRate < 0 || isNaN(minimumRate))) {
      throw new BadRequestError('Minimum rate must be a positive number');
    }
    
    if (perKmRate !== undefined && (perKmRate < 0 || isNaN(perKmRate))) {
      throw new BadRequestError('Per km rate must be a positive number');
    }
    
    // Find and update fare rate
    let fareRate = await FareRate.findOne({ vehicleType });
    
    if (!fareRate) {
      // Create new fare rate if it doesn't exist
      fareRate = await FareRate.create({
        vehicleType,
        minimumRate: minimumRate || 0,
        perKmRate: perKmRate || 0,
        updatedBy: adminId,
      });
    } else {
      // Update existing fare rate
      if (minimumRate !== undefined) fareRate.minimumRate = minimumRate;
      if (perKmRate !== undefined) fareRate.perKmRate = perKmRate;
      fareRate.updatedBy = adminId;
      
      await fareRate.save();
    }
    
    // Populate updatedBy field
    await fareRate.populate('updatedBy', 'firstName lastName email');
    
    console.log(`✅ Fare rate updated for ${vehicleType} by admin ${adminId}`);
    
    res.status(StatusCodes.OK).json({ 
      message: 'Fare rate updated successfully',
      fareRate 
    });
  } catch (error) {
    console.error('Error updating fare rate:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Failed to update fare rate',
      error: error.message 
    });
  }
};

// Bulk update all fare rates
export const bulkUpdateFareRates = async (req, res) => {
  try {
    const { fareRates, isReset } = req.body;
    const adminId = req.user.id;
    
    if (!Array.isArray(fareRates) || fareRates.length === 0) {
      throw new BadRequestError('Fare rates array is required');
    }
    
    const updatedRates = [];
    const changeDetails = [];
    
    for (const rate of fareRates) {
      const { vehicleType, minimumRate, perKmRate } = rate;
      
      // Validation
      if (!vehicleType) continue;
      if (minimumRate < 0 || perKmRate < 0) continue;
      
      let fareRate = await FareRate.findOne({ vehicleType });
      const oldMinRate = fareRate?.minimumRate || 0;
      const oldPerKmRate = fareRate?.perKmRate || 0;
      
      if (!fareRate) {
        fareRate = await FareRate.create({
          vehicleType,
          minimumRate,
          perKmRate,
          updatedBy: adminId,
        });
        changeDetails.push(`${vehicleType}: Created with ₱${minimumRate} min, ₱${perKmRate}/km`);
      } else {
        if (oldMinRate !== minimumRate || oldPerKmRate !== perKmRate) {
          changeDetails.push(`${vehicleType}: ₱${oldMinRate}→₱${minimumRate} min, ₱${oldPerKmRate}→₱${perKmRate}/km`);
        }
        fareRate.minimumRate = minimumRate;
        fareRate.perKmRate = perKmRate;
        fareRate.updatedBy = adminId;
        await fareRate.save();
      }
      
      await fareRate.populate('updatedBy', 'firstName lastName email');
      updatedRates.push(fareRate);
    }
    
    // Log activity
    try {
      const adminName = await getAdminName(adminId);
      const action = isReset ? 'RESET_FARE_RATES' : 'UPDATED_FARE_RATE';
      const description = isReset 
        ? `Reset all fare rates to default values: ${changeDetails.join('; ')}`
        : `Updated fare rates: ${changeDetails.join('; ')}`;
      
      await ActivityLog.create({
        admin: adminId,
        adminName: adminName,
        action: action,
        targetType: 'FARE_RATE',
        targetId: updatedRates[0]?._id || adminId, // Use first rate ID or admin ID as fallback
        targetName: 'Fare Rates',
        description: description,
        metadata: {
          updatedRates: fareRates,
          isReset: isReset || false
        },
        ipAddress: req.ip
      });
      console.log(`📝 Activity logged: ${action} by ${adminName}`);
    } catch (logError) {
      console.error('⚠️ Failed to log activity (non-critical):', logError.message);
    }
    
    console.log(`✅ Bulk fare rates updated by admin ${adminId}`);
    
    res.status(StatusCodes.OK).json({ 
      message: 'Fare rates updated successfully',
      fareRates: updatedRates 
    });
  } catch (error) {
    console.error('Error bulk updating fare rates:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Failed to update fare rates',
      error: error.message 
    });
  }
};

// Initialize default fare rates (for setup)
export const initializeFareRates = async (req, res) => {
  try {
    const existingRates = await FareRate.find();
    
    if (existingRates.length > 0) {
      return res.status(StatusCodes.OK).json({ 
        message: 'Fare rates already initialized',
        fareRates: existingRates 
      });
    }
    
    const defaultRates = [
      { vehicleType: "Single Motorcycle", minimumRate: 15, perKmRate: 2.5 },
      { vehicleType: "Tricycle", minimumRate: 20, perKmRate: 2.8 },
      { vehicleType: "Cab", minimumRate: 30, perKmRate: 3 },
    ];
    
    const createdRates = await FareRate.insertMany(defaultRates);
    
    console.log('✅ Default fare rates initialized');
    
    res.status(StatusCodes.CREATED).json({ 
      message: 'Default fare rates initialized successfully',
      fareRates: createdRates 
    });
  } catch (error) {
    console.error('Error initializing fare rates:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: 'Failed to initialize fare rates',
      error: error.message 
    });
  }
};
