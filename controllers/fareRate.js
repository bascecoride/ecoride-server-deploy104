import FareRate from '../models/FareRate.js';
import { StatusCodes } from 'http-status-codes';
import { BadRequestError, NotFoundError } from '../errors/index.js';

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
    const { fareRates } = req.body;
    const adminId = req.user.id;
    
    if (!Array.isArray(fareRates) || fareRates.length === 0) {
      throw new BadRequestError('Fare rates array is required');
    }
    
    const updatedRates = [];
    
    for (const rate of fareRates) {
      const { vehicleType, minimumRate, perKmRate } = rate;
      
      // Validation
      if (!vehicleType) continue;
      if (minimumRate < 0 || perKmRate < 0) continue;
      
      let fareRate = await FareRate.findOne({ vehicleType });
      
      if (!fareRate) {
        fareRate = await FareRate.create({
          vehicleType,
          minimumRate,
          perKmRate,
          updatedBy: adminId,
        });
      } else {
        fareRate.minimumRate = minimumRate;
        fareRate.perKmRate = perKmRate;
        fareRate.updatedBy = adminId;
        await fareRate.save();
      }
      
      await fareRate.populate('updatedBy', 'firstName lastName email');
      updatedRates.push(fareRate);
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
