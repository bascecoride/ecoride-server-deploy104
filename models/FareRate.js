import mongoose from 'mongoose';

const { Schema } = mongoose;

const fareRateSchema = new Schema(
  {
    vehicleType: {
      type: String,
      enum: ["Single Motorcycle", "Tricycle", "Cab"],
      required: true,
      unique: true,
    },
    minimumRate: {
      type: Number,
      required: true,
      min: 0,
    },
    perKmRate: {
      type: Number,
      required: true,
      min: 0,
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

const FareRate = mongoose.model("FareRate", fareRateSchema);
export default FareRate;
