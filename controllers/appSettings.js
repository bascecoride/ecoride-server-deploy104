import { StatusCodes } from "http-status-codes";
import AppSettings from "../models/AppSettings.js";
import ActivityLog from "../models/ActivityLog.js";
import Admin from "../models/Admin.js";
import { invalidateDistanceRadiusCache } from "./sockets.js";

// Helper function to get admin name
const getAdminName = async (adminId) => {
  try {
    const admin = await Admin.findById(adminId);
    return admin ? admin.name : 'Unknown Admin';
  } catch (error) {
    return 'Unknown Admin';
  }
};

// Get all app settings
export const getAllSettings = async (req, res) => {
  try {
    const settings = await AppSettings.find().populate("updatedBy", "firstName lastName email");
    res.status(StatusCodes.OK).json({ settings });
  } catch (error) {
    console.error("Error fetching app settings:", error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: "Failed to fetch app settings",
      error: error.message 
    });
  }
};

// Get specific setting by key
export const getSettingByKey = async (req, res) => {
  try {
    const { key } = req.params;
    const setting = await AppSettings.findOne({ settingKey: key });
    
    if (!setting) {
      return res.status(StatusCodes.NOT_FOUND).json({ 
        message: "Setting not found" 
      });
    }
    
    res.status(StatusCodes.OK).json({ setting });
  } catch (error) {
    console.error("Error fetching setting:", error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: "Failed to fetch setting",
      error: error.message 
    });
  }
};

// Get distance radius setting (public endpoint for mobile app)
export const getDistanceRadius = async (req, res) => {
  try {
    let setting = await AppSettings.findOne({ settingKey: "DISTANCE_RADIUS" });
    
    // If setting doesn't exist, create default (3km = 3000 meters)
    if (!setting) {
      setting = await AppSettings.create({
        settingKey: "DISTANCE_RADIUS",
        value: 3,
        unit: "km",
        description: "Maximum distance radius for showing nearby riders/bookings"
      });
      console.log("✅ Created default distance radius setting: 3km");
    }
    
    res.status(StatusCodes.OK).json({ 
      distanceRadius: setting.value,
      unit: setting.unit,
      meters: setting.value * 1000 // Convert to meters for calculations
    });
  } catch (error) {
    console.error("Error fetching distance radius:", error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: "Failed to fetch distance radius",
      error: error.message 
    });
  }
};

// Update or create setting (Admin only)
export const updateSetting = async (req, res) => {
  try {
    console.log("📝 Update setting request:", req.body);
    console.log("👤 User info:", req.user);
    
    const { settingKey, value, description, isReset } = req.body;
    const adminId = req.user?.userId || req.user?.id;
    
    console.log("📝 Parsed values - settingKey:", settingKey, "value:", value, "adminId:", adminId);

    // Validate input
    if (!settingKey || value === undefined || value === null) {
      return res.status(StatusCodes.BAD_REQUEST).json({ 
        message: "Setting key and value are required" 
      });
    }

    // Validate value is positive number
    if (typeof value !== 'number' || value < 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({ 
        message: "Value must be a positive number" 
      });
    }

    // For distance radius, validate reasonable range (0.5km to 50km)
    if (settingKey === "DISTANCE_RADIUS") {
      if (value < 0.5 || value > 50) {
        return res.status(StatusCodes.BAD_REQUEST).json({ 
          message: "Distance radius must be between 0.5 km and 50 km" 
        });
      }
    }

    // Get old value for logging
    const oldSetting = await AppSettings.findOne({ settingKey });
    const oldValue = oldSetting?.value || 'None';

    // Update or create setting
    const setting = await AppSettings.findOneAndUpdate(
      { settingKey },
      { 
        value, 
        description,
        updatedBy: adminId 
      },
      { 
        new: true, 
        upsert: true,
        runValidators: true 
      }
    ).populate("updatedBy", "firstName lastName email");

    // Log activity with proper format
    try {
      if (adminId) {
        const adminName = await getAdminName(adminId);
        let action, logDescription;
        
        if (settingKey === "DISTANCE_RADIUS") {
          action = isReset ? 'RESET_DISTANCE_RADIUS' : 'UPDATED_DISTANCE_RADIUS';
          logDescription = isReset 
            ? `Reset Distance Radius to default (${value} km)`
            : `Updated Distance Radius from ${oldValue} km to ${value} km`;
        } else {
          action = 'UPDATED_SETTING';
          logDescription = `Updated ${settingKey} from ${oldValue} to ${value}`;
        }
        
        await ActivityLog.create({
          admin: adminId,
          adminName: adminName,
          action: action,
          targetType: 'SETTING',
          targetId: setting._id,
          targetName: settingKey === "DISTANCE_RADIUS" ? 'Distance Radius' : settingKey,
          description: logDescription,
          metadata: {
            settingKey: settingKey,
            oldValue: oldValue,
            newValue: value,
            isReset: isReset || false
          },
          ipAddress: req.ip
        });
        console.log(`📝 Activity logged: ${action} by ${adminName}`);
      }
    } catch (logError) {
      console.error("⚠️ Failed to log activity (non-critical):", logError.message);
    }

    console.log(`✅ Admin ${adminId} updated ${settingKey} to ${value} km`);

    // Invalidate cache if distance radius was updated
    if (settingKey === "DISTANCE_RADIUS") {
      invalidateDistanceRadiusCache();
      console.log(`🔄 Distance radius cache invalidated after update to ${value} km`);
    }

    res.status(StatusCodes.OK).json({ 
      message: "Setting updated successfully",
      setting 
    });
  } catch (error) {
    console.error("Error updating setting:", error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: "Failed to update setting",
      error: error.message 
    });
  }
};

// Bulk update settings (Admin only)
export const bulkUpdateSettings = async (req, res) => {
  try {
    const { settings } = req.body;
    const adminId = req.user.userId;

    if (!Array.isArray(settings) || settings.length === 0) {
      return res.status(StatusCodes.BAD_REQUEST).json({ 
        message: "Settings array is required" 
      });
    }

    const updatedSettings = [];
    const errors = [];

    for (const setting of settings) {
      try {
        const { settingKey, value, description } = setting;

        // Validate
        if (!settingKey || value === undefined) {
          errors.push({ settingKey, error: "Missing key or value" });
          continue;
        }

        if (typeof value !== 'number' || value < 0) {
          errors.push({ settingKey, error: "Value must be positive number" });
          continue;
        }

        // Update
        const updated = await AppSettings.findOneAndUpdate(
          { settingKey },
          { 
            value, 
            description,
            updatedBy: adminId 
          },
          { 
            new: true, 
            upsert: true,
            runValidators: true 
          }
        );

        updatedSettings.push(updated);

        // Log activity
        await ActivityLog.create({
          admin: adminId,
          action: "UPDATE_SETTING",
          targetModel: "AppSettings",
          targetId: updated._id,
          details: `Updated ${settingKey} to ${value}`,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });
      } catch (error) {
        errors.push({ settingKey: setting.settingKey, error: error.message });
      }
    }

    res.status(StatusCodes.OK).json({ 
      message: "Bulk update completed",
      updated: updatedSettings.length,
      errors: errors.length > 0 ? errors : undefined,
      settings: updatedSettings
    });
  } catch (error) {
    console.error("Error bulk updating settings:", error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: "Failed to bulk update settings",
      error: error.message 
    });
  }
};
