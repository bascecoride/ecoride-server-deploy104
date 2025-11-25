import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * LoginAttempt Model
 * Tracks failed login attempts for rate limiting and account lockout
 * Industry standard: 5 failed attempts = 30 minute lockout
 */
const loginAttemptSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true
    },
    ipAddress: {
      type: String,
      required: false
    },
    userAgent: {
      type: String,
      required: false
    },
    attemptType: {
      type: String,
      enum: ['admin', 'user'],
      default: 'admin'
    },
    success: {
      type: Boolean,
      default: false
    },
    failureReason: {
      type: String,
      enum: ['invalid_email', 'invalid_password', 'account_locked', 'account_inactive'],
      required: false
    }
  },
  {
    timestamps: true,
    // Auto-expire documents after 24 hours to keep collection clean
    expireAfterSeconds: 86400
  }
);

// Index for efficient queries
loginAttemptSchema.index({ email: 1, createdAt: -1 });
loginAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

/**
 * Static method to count recent failed attempts for an email
 * @param {string} email - The email to check
 * @param {number} windowMinutes - Time window in minutes (default: 30)
 * @returns {number} - Count of failed attempts
 */
loginAttemptSchema.statics.countRecentFailedAttempts = async function(email, windowMinutes = 30) {
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);
  
  // Only count actual login failures, not 'account_locked' or 'account_inactive'
  return await this.countDocuments({
    email: email.toLowerCase(),
    success: false,
    failureReason: { $in: ['invalid_email', 'invalid_password'] },
    createdAt: { $gte: windowStart }
  });
};

/**
 * Static method to check if an email is currently locked out
 * @param {string} email - The email to check
 * @param {number} maxAttempts - Maximum allowed attempts (default: 5)
 * @param {number} lockoutMinutes - Lockout duration in minutes (default: 30)
 * @returns {Object} - { isLocked, remainingTime, failedAttempts }
 */
loginAttemptSchema.statics.checkLockoutStatus = async function(email, maxAttempts = 5, lockoutMinutes = 30) {
  const windowStart = new Date(Date.now() - lockoutMinutes * 60 * 1000);
  
  // Get all failed attempts in the lockout window
  // IMPORTANT: Only count actual login failures (invalid_email, invalid_password)
  // Do NOT count 'account_locked' attempts as they happen after lockout is triggered
  const failedAttempts = await this.find({
    email: email.toLowerCase(),
    success: false,
    failureReason: { $in: ['invalid_email', 'invalid_password'] }, // Only count real failures
    createdAt: { $gte: windowStart }
  }).sort({ createdAt: -1 });
  
  const attemptCount = failedAttempts.length;
  
  if (attemptCount >= maxAttempts) {
    // Calculate remaining lockout time from the most recent failed attempt
    const mostRecentAttempt = failedAttempts[0];
    const lockoutEndsAt = new Date(mostRecentAttempt.createdAt.getTime() + lockoutMinutes * 60 * 1000);
    const remainingMs = lockoutEndsAt.getTime() - Date.now();
    
    if (remainingMs > 0) {
      return {
        isLocked: true,
        remainingTime: Math.ceil(remainingMs / 1000 / 60), // in minutes
        remainingSeconds: Math.ceil(remainingMs / 1000),
        failedAttempts: attemptCount,
        lockoutEndsAt
      };
    }
  }
  
  return {
    isLocked: false,
    remainingTime: 0,
    remainingSeconds: 0,
    failedAttempts: attemptCount,
    attemptsRemaining: maxAttempts - attemptCount
  };
};

/**
 * Static method to record a login attempt
 * @param {Object} attemptData - { email, ipAddress, userAgent, success, failureReason, attemptType }
 */
loginAttemptSchema.statics.recordAttempt = async function(attemptData) {
  return await this.create({
    email: attemptData.email.toLowerCase(),
    ipAddress: attemptData.ipAddress || 'unknown',
    userAgent: attemptData.userAgent || 'unknown',
    success: attemptData.success || false,
    failureReason: attemptData.failureReason || null,
    attemptType: attemptData.attemptType || 'admin'
  });
};

/**
 * Static method to clear failed attempts after successful login
 * @param {string} email - The email to clear attempts for
 */
loginAttemptSchema.statics.clearFailedAttempts = async function(email) {
  return await this.deleteMany({
    email: email.toLowerCase(),
    success: false
  });
};

/**
 * Static method to get login history for an email
 * @param {string} email - The email to get history for
 * @param {number} limit - Number of records to return (default: 10)
 */
loginAttemptSchema.statics.getLoginHistory = async function(email, limit = 10) {
  return await this.find({ email: email.toLowerCase() })
    .sort({ createdAt: -1 })
    .limit(limit);
};

const LoginAttempt = mongoose.model('LoginAttempt', loginAttemptSchema);
export default LoginAttempt;
