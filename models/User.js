import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    role: {
      type: String,
      enum: ["customer", "rider", "admin"],
      required: true,
    },
    phone: {
      type: String,
      required: false,
      // Removed unique constraint to allow same phone for different roles
      sparse: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      match: [
        /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
        'Please provide a valid email',
      ],
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    firstName: {
      type: String,
      required: false,
      trim: true,
    },
    middleName: {
      type: String,
      required: false,
      trim: true,
    },
    lastName: {
      type: String,
      required: false,
      trim: true,
    },
    schoolId: {
      type: String,
      required: false,
    },
    licenseId: {
      type: String,
      required: false,
    },
    sex: {
      type: String,
      enum: ["male", "female"],
      required: false,
    },
    vehicleType: {
      type: String,
      enum: ["Single Motorcycle", "Tricycle", "Cab"],
      required: false,
    },
    // Role-based verification fields
    userRole: {
      type: String,
      enum: ["Student", "Faculty", "Staff"],
      required: false,
    },
    // Document verification URLs
    photo: {
      type: String,
      required: false,
    },
    schoolIdDocument: {
      type: String,
      required: false,
    },
    staffFacultyIdDocument: {
      type: String,
      required: false,
    },
    cor: {
      type: String,
      required: false,
    },
    driverLicense: {
      type: String,
      required: false,
    },
    orCr: {
      type: String,
      required: false,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "disapproved"],
      default: "pending"
    },
    disapprovalReason: {
      type: String,
      default: '',
    },
    penaltyComment: {
      type: String,
      default: '',
    },
    penaltyLiftDate: {
      type: Date,
      required: false,
    },
    rejectionDeadline: {
      type: Date,
      required: false,
    },
    resetPasswordCode: {
      type: String,
      required: false,
    },
    resetPasswordExpires: {
      type: Date,
      required: false,
    },
    agreedToTerms: {
      type: Boolean,
      default: false,
    },
    termsAgreedAt: {
      type: Date,
      required: false,
    }
  },
  {
    timestamps: true,
  }
);

// Create compound unique index for phone + role combination
// This allows same phone for different roles but prevents duplicates within same role
userSchema.index({ phone: 1, role: 1 }, { unique: true, sparse: true });

// Hash password before saving
userSchema.pre('save', async function() {
  if (this.isModified('password')) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.createAccessToken = function () {
  return jwt.sign(
    {
      id: this._id,
      email: this.email,
      role: this.role,
    },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: process.env.ACCESS_TOKEN_EXPIRY }
  );
};

userSchema.methods.createRefreshToken = function () {
  return jwt.sign(
    { id: this._id, email: this.email, role: this.role },
    process.env.REFRESH_TOKEN_SECRET,
    {
      expiresIn: process.env.REFRESH_TOKEN_EXPIRY,
    }
  );
};

const User = mongoose.model("User", userSchema);
export default User;
