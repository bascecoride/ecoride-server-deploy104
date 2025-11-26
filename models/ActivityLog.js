import mongoose from 'mongoose';

const { Schema } = mongoose;

const activityLogSchema = new Schema(
  {
    admin: {
      type: Schema.Types.ObjectId,
      ref: 'Admin',
      required: true
    },
    adminName: {
      type: String,
      required: true
    },
    action: {
      type: String,
      required: true,
      enum: [
        'APPROVED_USER',
        'DISAPPROVED_USER',
        'DELETED_USER',
        'EDITED_USER',
        'ADDED_PENALTY',
        'REMOVED_PENALTY',
        'CREATED_ADMIN',
        'UPDATED_ADMIN',
        'DELETED_ADMIN',
        'DEACTIVATED_ADMIN',
        'ACTIVATED_ADMIN',
        // Settings-related actions
        'UPDATED_FARE_RATE',
        'RESET_FARE_RATES',
        'UPDATED_TERMS',
        'RESET_TERMS',
        'UPDATED_DISTANCE_RADIUS',
        'RESET_DISTANCE_RADIUS',
        'UPDATED_SETTING'
      ]
    },
    targetType: {
      type: String,
      required: true,
      enum: ['USER', 'ADMIN', 'RIDE', 'SETTING', 'FARE_RATE', 'TERMS']
    },
    targetId: {
      type: Schema.Types.ObjectId,
      required: true
    },
    targetName: {
      type: String,
      required: true
    },
    description: {
      type: String,
      required: true
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {}
    },
    ipAddress: {
      type: String
    }
  },
  {
    timestamps: true,
  }
);

// Index for efficient querying
activityLogSchema.index({ admin: 1, createdAt: -1 });
activityLogSchema.index({ action: 1, createdAt: -1 });
activityLogSchema.index({ targetType: 1, targetId: 1 });

const ActivityLog = mongoose.model("ActivityLog", activityLogSchema);
export default ActivityLog;
