import mongoose from 'mongoose';

const { Schema } = mongoose;

const appSettingsSchema = new Schema(
  {
    settingKey: {
      type: String,
      required: true,
      unique: true,
      enum: ["DISTANCE_RADIUS"], // Can add more settings in the future
    },
    value: {
      type: Number,
      required: true,
      min: 0,
    },
    unit: {
      type: String,
      default: "km",
    },
    description: {
      type: String,
      required: false,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

const AppSettings = mongoose.model("AppSettings", appSettingsSchema);
export default AppSettings;
