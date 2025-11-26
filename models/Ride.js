import mongoose from 'mongoose';

const { Schema } = mongoose;

const rideSchema = new Schema(
  {
    vehicle: {
      type: String,
      enum: ["Single Motorcycle", "Tricycle", "Cab"],
      required: true,
    },
    distance: {
      type: Number,
      required: true,
    },
    pickup: {
      address: { type: String, required: true },
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
      landmark: { type: String, default: null }, // Landmark description to help driver find pickup location
    },
    drop: {
      address: { type: String, required: true },
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
      landmark: { type: String, default: null }, // Landmark description to help driver find passenger
    },
    // Number of passengers joining the ride (including the person booking)
    passengerCount: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
      max: 4, // Max 4 passengers for Cab
    },
    fare: {
      type: Number,
      required: true,
    },
    customer: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    rider: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    status: {
      type: String,
      enum: ["SEARCHING_FOR_RIDER", "START", "ARRIVED", "COMPLETED", "CANCELLED", "TIMEOUT"],
      default: "SEARCHING_FOR_RIDER",
    },
    otp: {
      type: String,
      default: null,
    },
    cancelledBy: {
      type: String,
      enum: ["customer", "rider"],
      default: null,
    },
    cancelledByName: {
      type: String,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancellationReason: {
      type: String,
      default: null,
    },
    blacklistedRiders: {
      type: [Schema.Types.ObjectId],
      ref: "User",
      default: [],
      // Array of rider IDs who have cancelled this ride - they won't see it again
    },
    paymentMethod: {
      type: String,
      enum: ["CASH", "GCASH"],
      default: null,
    },
    paymentConfirmedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const Ride = mongoose.model("Ride", rideSchema);
export default Ride;
