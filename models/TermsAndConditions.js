import mongoose from "mongoose";

const termsAndConditionsSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: [true, "Terms and conditions content is required"],
    },
    version: {
      type: String,
      required: true,
      default: "1.0",
    },
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Only one active terms and conditions at a time
termsAndConditionsSchema.index({ isActive: 1 }, { unique: true, partialFilterExpression: { isActive: true } });

export default mongoose.model("TermsAndConditions", termsAndConditionsSchema);
