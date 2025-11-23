import User from "../models/User.js";
import { StatusCodes } from "http-status-codes";
import { BadRequestError, UnauthenticatedError } from "../errors/index.js";
import jwt from "jsonwebtoken";
import { generateVerificationCode, sendVerificationEmail } from "../utils/emailService.js";
import { upload } from "../utils/cloudinary.js";

// Simple test endpoint
export const testAuth = async (req, res) => {
  res.status(StatusCodes.OK).json({ message: "Auth endpoint is working" });
};

// Login with email and password
export const login = async (req, res) => {
  const { email, password, role } = req.body;

  console.log("Login attempt:", { email, role }); // Log login attempt details

  if (!email || !password) {
    throw new BadRequestError("Please provide email and password");
  }

  if (!role || !["customer", "rider", "admin"].includes(role)) {
    throw new BadRequestError("Valid role is required (customer, rider, or admin)");
  }

  try {
    // Find user without role restriction first to debug
    const anyUser = await User.findOne({ email });
    console.log("User found with this email:", anyUser ? "Yes" : "No");
    if (anyUser) {
      console.log("User role:", anyUser.role, "Requested role:", role);
    }

    const user = await User.findOne({ email, role });
    
    if (!user) {
      console.log("User not found with email and role combination");
      throw new UnauthenticatedError("Invalid credentials");
    }

    console.log("User found, checking password");
    const isPasswordCorrect = await user.comparePassword(password);
    if (!isPasswordCorrect) {
      console.log("Password incorrect");
      throw new UnauthenticatedError("Invalid credentials");
    }

    // Check if user is approved (skip for admin users)
    if (role !== 'admin') {
      if (user.status === "disapproved") {
        console.log("User is disapproved");
        
        // Check if user has a penalty
        if (user.penaltyLiftDate) {
          const currentDate = new Date();
          const penaltyLiftDate = new Date(user.penaltyLiftDate);
          const isPenaltyActive = currentDate < penaltyLiftDate;
          
          return res.status(StatusCodes.FORBIDDEN).json({
            message: "Your account has been disapproved.",
            status: "disapproved",
            isApproved: false,
            hasPenalty: true,
            disapprovalReason: user.disapprovalReason || "No reason provided",
            penaltyComment: user.penaltyComment || "No reason provided",
            penaltyLiftDate: user.penaltyLiftDate,
            isPenaltyActive
          });
        } else {
          return res.status(StatusCodes.FORBIDDEN).json({
            message: "Your account has been disapproved.",
            status: "disapproved",
            isApproved: false,
            hasPenalty: false,
            disapprovalReason: user.disapprovalReason || "No reason provided"
          });
        }
      } else if (user.status === "pending") {
        console.log("User is pending approval");
        return res.status(StatusCodes.FORBIDDEN).json({
          message: "Your account is pending approval. Please wait for an administrator to approve your account.",
          status: "pending",
          isApproved: false
        });
      }
    }

    console.log("Password correct, generating tokens");
    const accessToken = user.createAccessToken();
    const refreshToken = user.createRefreshToken();

    return res.status(StatusCodes.OK).json({
      message: "User logged in successfully",
      user,
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch (error) {
    console.error(error);
    throw error;
  }
};

// Register a new user
export const register = async (req, res) => {
  const { 
    email, 
    password, 
    role, 
    firstName, 
    middleName, 
    lastName, 
    phone, 
    schoolId,
    licenseId,
    sex,
    userRole,
    photo,
    schoolIdDocument,
    staffFacultyIdDocument,
    cor,
    driverLicense,
    orCr,
    vehicleType,
    agreedToTerms
  } = req.body;

  if (!email || !password) {
    throw new BadRequestError("Please provide email and password");
  }

  if (!role || !["customer", "rider"].includes(role)) {
    throw new BadRequestError("Valid role is required (customer or rider)");
  }

  if (!agreedToTerms) {
    throw new BadRequestError("You must agree to the terms and conditions to register");
  }

  try {
    // Check if user already exists with same email
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      throw new BadRequestError("Email already in use");
    }

    // Check if phone number is provided and already exists with same role
    if (phone) {
      const existingPhoneUser = await User.findOne({ phone, role });
      if (existingPhoneUser) {
        throw new BadRequestError(`Phone number already registered as ${role}`);
      }
    }

    // Format licenseId if provided and user is a rider
    let formattedLicenseId = licenseId;
    if (role === "rider" && licenseId) {
      formattedLicenseId = licenseId.trim().toUpperCase();
      
      // Basic validation for license ID format
      if (formattedLicenseId.length < 4) {
        throw new BadRequestError("License ID must be at least 4 characters");
      }
    }

    // Validate required documents based on role and userRole
    if (userRole) {
      if (!photo) {
        throw new BadRequestError("Photo is required for verification");
      }
      
      if (userRole === "Student") {
        if (!schoolIdDocument || !cor) {
          throw new BadRequestError("School ID and COR are required for students");
        }
        if (role === "rider") {
          if (!driverLicense) {
            throw new BadRequestError("Driver license is required for student drivers");
          }
          if (!orCr) {
            throw new BadRequestError("OR/CR (Official Receipt/Certificate of Registration) is required for student drivers");
          }
        }
      } else if (userRole === "Faculty" || userRole === "Staff") {
        if (!staffFacultyIdDocument) {
          throw new BadRequestError("Staff/Faculty ID is required for faculty and staff");
        }
        if (role === "rider") {
          if (!driverLicense) {
            throw new BadRequestError("Driver license is required for faculty/staff drivers");
          }
          if (!orCr) {
            throw new BadRequestError("OR/CR (Official Receipt/Certificate of Registration) is required for faculty/staff drivers");
          }
        }
      }
    }

    // Create new user
    const user = new User({
      email,
      password,
      role,
      firstName,
      middleName,
      lastName,
      phone,
      schoolId,
      licenseId: formattedLicenseId,
      sex,
      userRole,
      photo,
      schoolIdDocument,
      staffFacultyIdDocument,
      cor,
      driverLicense,
      orCr,
      vehicleType,
      approved: false, // Ensure all new users start as unapproved
      status: "pending",
      agreedToTerms: true,
      termsAgreedAt: new Date()
    });

    await user.save();

    // Generate tokens but inform user that approval is pending
    const accessToken = user.createAccessToken();
    const refreshToken = user.createRefreshToken();

    res.status(StatusCodes.CREATED).json({
      message: "User registered successfully. Your account is pending approval.",
      user,
      access_token: accessToken,
      refresh_token: refreshToken,
      isApproved: false,
      status: "pending"
    });
  } catch (error) {
    console.error(error);
    throw error;
  }
};

// Legacy phone-based authentication (keeping for backward compatibility)
export const auth = async (req, res) => {
  const { phone, role } = req.body;

  if (!phone) {
    throw new BadRequestError("Phone number is required");
  }

  if (!role || !["customer", "rider"].includes(role)) {
    throw new BadRequestError("Valid role is required (customer or rider)");
  }

  try {
    // Find user with specific phone and role combination
    let user = await User.findOne({ phone, role });

    if (user) {
      // User exists with this phone and role combination

      // Check if user is approved
      if (user.status === "disapproved") {
        console.log("User is disapproved");
        
        // Check if user has a penalty
        if (user.penaltyLiftDate) {
          const currentDate = new Date();
          const penaltyLiftDate = new Date(user.penaltyLiftDate);
          const isPenaltyActive = currentDate < penaltyLiftDate;
          
          return res.status(StatusCodes.FORBIDDEN).json({
            message: "Your account has been disapproved.",
            status: "disapproved",
            isApproved: false,
            hasPenalty: true,
            penaltyComment: user.penaltyComment || "No reason provided",
            penaltyLiftDate: user.penaltyLiftDate,
            isPenaltyActive
          });
        } else {
          return res.status(StatusCodes.FORBIDDEN).json({
            message: "Your account has been disapproved. Please contact support for assistance.",
            status: "disapproved",
            isApproved: false,
            hasPenalty: false
          });
        }
      } else if (user.status === "pending") {
        console.log("User is pending approval");
        return res.status(StatusCodes.FORBIDDEN).json({
          message: "Your account is pending approval. Please wait for an administrator to approve your account.",
          status: "pending",
          isApproved: false
        });
      }

      const accessToken = user.createAccessToken();
      const refreshToken = user.createRefreshToken();

      return res.status(StatusCodes.OK).json({
        message: "User logged in successfully",
        user,
        access_token: accessToken,
        refresh_token: refreshToken,
      });
    }

    // Check if phone exists with different role to create unique email
    const existingPhoneUser = await User.findOne({ phone });
    let tempEmail;
    
    if (existingPhoneUser) {
      // Phone exists with different role, create unique email
      tempEmail = `${phone}-${role}@temp.ecoride.com`;
    } else {
      // Phone doesn't exist, use standard format
      tempEmail = `${phone}@temp.ecoride.com`;
    }

    user = new User({
      phone,
      role,
      // Set a temporary email and password for legacy users
      email: tempEmail,
      password: Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8),
      // Set approved to false by default
      approved: false,
      status: "pending"
    });

    await user.save();

    // Return pending status for new users
    return res.status(StatusCodes.FORBIDDEN).json({
      message: "Account pending approval",
      status: "pending",
      isApproved: false,
      user: {
        _id: user._id,
        phone: user.phone,
        role: user.role
      }
    });
  } catch (error) {
    console.error(error);
    throw error;
  }
};

export const refreshToken = async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    throw new BadRequestError("Refresh token is required");
  }

  try {
    const payload = jwt.verify(refresh_token, process.env.REFRESH_TOKEN_SECRET);
    const user = await User.findById(payload.id);

    if (!user) {
      throw new UnauthenticatedError("Invalid refresh token");
    }

    const newAccessToken = user.createAccessToken();
    const newRefreshToken = user.createRefreshToken();

    res.status(StatusCodes.OK).json({
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
    });
  } catch (error) {
    console.error(error);
    throw new UnauthenticatedError("Invalid refresh token");
  }
};

// Get user profile information
export const getUserProfile = async (req, res) => {
  console.log('📝 getUserProfile called');
  console.log('📝 req.user:', req.user);
  
  try {
    // Check if req.user exists
    if (!req.user || !req.user.id) {
      console.log('❌ No req.user or req.user.id found');
      return res.status(StatusCodes.UNAUTHORIZED).json({
        message: "Authentication required. Please log in again."
      });
    }

    console.log('🔍 Looking for user with ID:', req.user.id);
    const user = await User.findById(req.user.id).select('-password');
    
    if (!user) {
      console.log('❌ User not found in database');
      return res.status(StatusCodes.NOT_FOUND).json({
        message: "User not found. Please log in again."
      });
    }

    console.log('✅ User found:', user.email);
    res.status(StatusCodes.OK).json({
      user
    });
  } catch (error) {
    console.error('❌ Error fetching profile:', error);
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: "Error fetching profile",
      error: error.message
    });
  }
};

// Update user profile information
export const updateUserProfile = async (req, res) => {
  const { name, firstName, middleName, lastName, phone, schoolId, licenseId, email, sex, vehicleType } = req.body;

  try {
    // Check if req.user exists
    if (!req.user || !req.user.id) {
      return res.status(StatusCodes.UNAUTHORIZED).json({
        message: "Authentication required. Please log in again."
      });
    }

    const user = await User.findById(req.user.id);
    
    if (!user) {
      return res.status(StatusCodes.NOT_FOUND).json({
        message: "User not found. Please log in again."
      });
    }

    // Handle single name field (split into firstName and lastName)
    if (name) {
      const nameParts = name.trim().split(/\s+/);
      if (nameParts.length === 1) {
        user.firstName = nameParts[0];
        user.middleName = '';
        user.lastName = '';
      } else if (nameParts.length === 2) {
        user.firstName = nameParts[0];
        user.middleName = '';
        user.lastName = nameParts[1];
      } else {
        user.firstName = nameParts[0];
        user.middleName = nameParts.slice(1, -1).join(' ');
        user.lastName = nameParts[nameParts.length - 1];
      }
    }

    // Update fields if provided (legacy support)
    if (firstName && !name) user.firstName = firstName;
    if (middleName !== undefined && !name) user.middleName = middleName;
    if (lastName && !name) user.lastName = lastName;
    // Phone update removed for admin users
    if (phone && user.role !== 'admin') {
      // Check if phone is already in use by another user with same role
      const existingPhoneUser = await User.findOne({ 
        phone, 
        role: user.role, 
        _id: { $ne: req.user.id } 
      });
      if (existingPhoneUser) {
        throw new BadRequestError(`Phone number already in use by another ${user.role}`);
      }
      user.phone = phone;
    }
    if (schoolId !== undefined) user.schoolId = schoolId;
    
    // Format and validate licenseId if provided and user is a rider
    if (licenseId !== undefined) {
      if (user.role === "rider" && licenseId) {
        const formattedLicenseId = licenseId.trim().toUpperCase();
        
        // Basic validation for license ID format
        if (formattedLicenseId.length < 4) {
          throw new BadRequestError("License ID must be at least 4 characters");
        }
        
        user.licenseId = formattedLicenseId;
      } else {
        user.licenseId = licenseId;
      }
    }
    
    if (sex) user.sex = sex;
    
    // Update vehicle type if provided and user is a rider
    if (vehicleType !== undefined && user.role === "rider") {
      const validVehicleTypes = ["Single Motorcycle", "Tricycle", "Cab"];
      if (vehicleType && !validVehicleTypes.includes(vehicleType)) {
        throw new BadRequestError("Invalid vehicle type. Must be Single Motorcycle, Tricycle, or Cab");
      }
      user.vehicleType = vehicleType;
      console.log(`✅ Updated vehicle type for rider ${user._id} to: ${vehicleType}`);
    }

    await user.save();

    // Return user without password
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(StatusCodes.OK).json({
      message: "Profile updated successfully",
      user: userResponse
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    
    // Handle specific error types
    if (error.name === 'ValidationError') {
      return res.status(StatusCodes.BAD_REQUEST).json({
        message: "Validation error",
        errors: Object.values(error.errors).map(err => err.message)
      });
    }
    
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        message: error.message
      });
    }
    
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      message: "Error updating profile",
      error: error.message
    });
  }
};

// Send password reset verification code
export const forgotPassword = async (req, res) => {
  const { email, role } = req.body;

  if (!email || !role) {
    throw new BadRequestError("Please provide email and role");
  }

  if (!['customer', 'rider'].includes(role)) {
    throw new BadRequestError("Valid role is required (customer or rider)");
  }

  try {
    // Find user by email and role
    const user = await User.findOne({ email, role });
    
    if (!user) {
      // Don't reveal if user exists or not for security
      return res.status(StatusCodes.OK).json({
        message: "If an account with this email exists, a verification code has been sent."
      });
    }

    // Generate verification code
    const verificationCode = generateVerificationCode();
    const expirationTime = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Save verification code to user
    user.resetPasswordCode = verificationCode;
    user.resetPasswordExpires = expirationTime;
    await user.save();

    // Send verification email
    const emailSent = await sendVerificationEmail(email, verificationCode);
    
    if (!emailSent) {
      throw new Error("Failed to send verification email");
    }

    console.log(`Password reset code sent to ${email}`);
    
    res.status(StatusCodes.OK).json({
      message: "Verification code sent to your email address"
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    throw new BadRequestError("Failed to process password reset request");
  }
};

// Verify reset code without updating password
export const verifyCode = async (req, res) => {
  const { email, role, verificationCode } = req.body;

  if (!email || !role || !verificationCode) {
    throw new BadRequestError("All fields are required");
  }

  if (!['customer', 'rider'].includes(role)) {
    throw new BadRequestError("Valid role is required (customer or rider)");
  }

  try {
    // Find user by email and role
    const user = await User.findOne({ email, role });
    
    if (!user) {
      throw new BadRequestError("Invalid verification code or user not found");
    }

    // Check if verification code is valid and not expired
    console.log("Verification code validation:");
    console.log(`Stored code: ${user.resetPasswordCode} ${typeof user.resetPasswordCode}`);
    console.log(`Received code: ${verificationCode} ${typeof verificationCode}`);
    console.log(`Match? ${user.resetPasswordCode === verificationCode}`);
    
    if (!user.resetPasswordCode || user.resetPasswordCode !== verificationCode) {
      throw new BadRequestError("Invalid verification code");
    }

    if (!user.resetPasswordExpires || user.resetPasswordExpires < new Date()) {
      throw new BadRequestError("Verification code has expired");
    }

    // Code is valid, but we don't reset the password or clear the code yet
    console.log(`Verification code valid for ${email}`);
    
    res.status(StatusCodes.OK).json({
      message: "Verification code is valid"
    });
  } catch (error) {
    console.error('Verify code error:', error);
    if (error instanceof BadRequestError) {
      throw error;
    }
    throw new BadRequestError("Failed to verify code");
  }
};

// Verify reset code and update password
export const resetPassword = async (req, res) => {
  const { email, role, verificationCode, newPassword, confirmPassword } = req.body;

  if (!email || !role || !verificationCode || !newPassword || !confirmPassword) {
    throw new BadRequestError("All fields are required");
  }

  if (!['customer', 'rider'].includes(role)) {
    throw new BadRequestError("Valid role is required (customer or rider)");
  }

  if (newPassword !== confirmPassword) {
    throw new BadRequestError("Passwords do not match");
  }

  // Password validation
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  if (!passwordRegex.test(newPassword)) {
    throw new BadRequestError(
      "Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character"
    );
  }

  try {
    // Find user by email and role
    const user = await User.findOne({ email, role });
    
    if (!user) {
      throw new BadRequestError("Invalid verification code or user not found");
    }

    // Check if verification code is valid and not expired
    if (!user.resetPasswordCode || user.resetPasswordCode !== verificationCode) {
      throw new BadRequestError("Invalid verification code");
    }

    if (!user.resetPasswordExpires || user.resetPasswordExpires < new Date()) {
      throw new BadRequestError("Verification code has expired");
    }

    // Update password
    user.password = newPassword;
    user.resetPasswordCode = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    console.log(`Password reset successful for ${email}`);
    
    res.status(StatusCodes.OK).json({
      message: "Password reset successful. You can now login with your new password."
    });
  } catch (error) {
    console.error('Reset password error:', error);
    if (error instanceof BadRequestError) {
      throw error;
    }
    throw new BadRequestError("Failed to reset password");
  }
};

// Upload documents for verification
export const uploadDocuments = async (req, res) => {
  try {
    console.log('\n==== DOCUMENT UPLOAD REQUEST ====');
    console.log('Request body:', req.body);
    const { userRole, role } = req.body;
    const files = req.files;

    console.log('Upload documents request:', { userRole, role });
    console.log('Files received:', files ? Object.keys(files) : 'No files');
    
    // Log the environment variables for Cloudinary (without revealing secrets)
    console.log('Cloudinary Environment Variables:', {
      CLOUDINARY_API_NAME: process.env.CLOUDINARY_API_NAME ? 'Set' : 'Not set',
      CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY ? 'Set' : 'Not set',
      CLOUDINARY_SECRET_KEY: process.env.CLOUDINARY_SECRET_KEY ? 'Set' : 'Not set',
    });

    if (!userRole || !role) {
      throw new BadRequestError("User role and account role are required");
    }

    if (!files || Object.keys(files).length === 0) {
      throw new BadRequestError("No files uploaded");
    }

    // Validate required documents based on role
    const requiredDocs = [];
    
    // Photo is always required
    requiredDocs.push('photo');
    
    if (userRole === 'Student') {
      requiredDocs.push('schoolIdDocument', 'cor');
      if (role === 'rider') {
        requiredDocs.push('driverLicense', 'orCr');
      }
    } else if (userRole === 'Faculty' || userRole === 'Staff') {
      requiredDocs.push('staffFacultyIdDocument');
      if (role === 'rider') {
        requiredDocs.push('driverLicense', 'orCr');
      }
    }

    console.log('Required documents:', requiredDocs);

    // Check if all required documents are uploaded
    const missingDocs = [];
    for (const doc of requiredDocs) {
      if (!files[doc]) {
        missingDocs.push(doc);
      }
    }

    if (missingDocs.length > 0) {
      throw new BadRequestError(`Missing required documents: ${missingDocs.join(', ')} for ${userRole} ${role}`);
    }

    // Log file details for debugging
    for (const [key, fileArray] of Object.entries(files)) {
      if (fileArray && fileArray[0]) {
        console.log(`File details for ${key}:`, {
          filename: fileArray[0].originalname || fileArray[0].name,
          mimetype: fileArray[0].mimetype,
          size: fileArray[0].size,
          fieldname: fileArray[0].fieldname
        });
      }
    }

    // Prepare document URLs
    const documentUrls = {};
    for (const [key, fileArray] of Object.entries(files)) {
      if (fileArray && fileArray[0]) {
        // Check if path exists (Cloudinary storage) or use the file directly (memory storage)
        if (fileArray[0].path) {
          documentUrls[key] = fileArray[0].path;
          console.log(`Document uploaded to Cloudinary: ${key} -> ${fileArray[0].path}`);
        } else {
          // For memory storage fallback, we'd need to handle file upload differently
          // This is a placeholder for now
          console.log(`Document in memory storage: ${key}`);
          documentUrls[key] = `memory-storage-${key}`;
        }
      }
    }

    console.log('Document URLs prepared:', Object.keys(documentUrls));
    console.log('==== END DOCUMENT UPLOAD REQUEST ====\n');

    res.status(StatusCodes.OK).json({
      message: "Documents uploaded successfully",
      documents: documentUrls
    });
  } catch (error) {
    console.error('\n==== DOCUMENT UPLOAD ERROR ====');
    console.error('Upload documents error:', error);
    console.error('Error stack:', error.stack);
    console.error('==== END DOCUMENT UPLOAD ERROR ====\n');
    
    if (error instanceof BadRequestError) {
      throw error;
    }
    
    // Provide more specific error message if possible
    if (error.message && error.message.includes('Cloudinary')) {
      throw new BadRequestError(`Cloudinary error: ${error.message}`);
    }
    
    throw new BadRequestError("Failed to upload documents: " + (error.message || 'Unknown error'));
  }
};
