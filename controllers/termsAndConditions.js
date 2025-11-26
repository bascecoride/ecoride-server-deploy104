import TermsAndConditions from "../models/TermsAndConditions.js";
import { StatusCodes } from "http-status-codes";
import { BadRequestError, NotFoundError } from "../errors/index.js";
import ActivityLog from "../models/ActivityLog.js";
import Admin from "../models/Admin.js";

// Helper function to get admin name
const getAdminName = async (adminId) => {
  try {
    const admin = await Admin.findById(adminId);
    return admin ? `${admin.firstName} ${admin.lastName}` : 'Unknown Admin';
  } catch (error) {
    return 'Unknown Admin';
  }
};

// Get active terms and conditions (public - no auth required)
export const getActiveTerms = async (req, res) => {
  try {
    const terms = await TermsAndConditions.findOne({ isActive: true });
    
    if (!terms) {
      // Return default terms if none exist
      return res.status(StatusCodes.OK).json({
        content: `ECORIDE-BASC TERMS AND CONDITIONS
Last Updated: October 2025

Welcome to EcoRide-BASC, a ride-sharing system developed to promote an eco-friendly and convenient transportation experience within Bulacan Agricultural State College (BASC). By creating an account and using the EcoRide-BASC application (the "Service"), you agree to comply with and be bound by these Terms and Conditions.

1. ACCOUNT REGISTRATION AND APPROVAL
1.1 Registration Through the App Only - All users must register exclusively through the official EcoRide-BASC mobile application. No other method of registration is allowed.
1.2 Account Approval Before Use - After registration, users must wait for the administrator's review and approval. Only approved and verified accounts can access and use EcoRide-BASC features such as booking rides, offering rides, viewing notifications, or managing profiles.
1.3 Verification Requirements - Drivers are required to upload a valid school ID and driver's license for verification. - Passengers must upload valid school credentials to confirm that they are official BASC students or faculty members. - Any submission of fake or tampered documents will lead to immediate disapproval or permanent account suspension.
1.4 Account Security - Users are responsible for maintaining the security of their account information. EcoRide-BASC will not be held liable for any misuse caused by user negligence.

2. USER ROLES AND RESPONSIBILITIES
2.1 Drivers - Must ensure their vehicle is in safe, clean, and roadworthy condition. - Must be sure that the passenger paid them correspondedly.
2.2 Passengers - Must verify their payment after a ride by selecting "PAID" or "UNPAID." - Are expected to respect drivers and follow ride rules. - Can only use the system for campus-related transportation or going home.
2.3 Administrators - Are responsible for reviewing, verifying, and approving user registrations. - Have the authority to manage accounts, issue disapprovals, and ensure safe operation of the platform.

3. SYSTEM USAGE POLICY
3.1 Acceptable Use - EcoRide-BASC is intended only for transportation within BASC premises or traveling home from the campus. Any other use beyond these purposes is strictly prohibited.
3.2 Payment Confirmation - After each ride, both the passenger and driver must confirm the payment status. A ride is only marked as completed when both confirmations match.
3.3 Prohibited Activities Users are prohibited from: - Sharing or selling accounts. - Submitting false information or impersonating others. - Using the system for commercial or non-campus-related transport. - Attempting to hack, alter, or exploit the platform in any way.

4. ACCOUNT VIOLATIONS AND PENALTIES
4.1 Penalty Enforcement – Disapproval Only - If a user violates the Terms and Conditions, their account will be disapproved by the administrator. Disapproval serves as the sole form of penalty in the system.
4.2 Ticket Submission for Appeal - If your account has been disapproved and you wish to appeal or clarify the reason, you must go to the designated EcoRide-BASC related office to submit a support ticket for review and resolution. Online appeals are not accepted.

5. DATA PRIVACY AND SECURITY - EcoRide-BASC values your privacy and complies with the Data Privacy Act of 2012. All information collected during registration and verification will be securely stored and used solely for system operations and user authentication.

6. MODIFICATION OF TERMS - EcoRide-BASC reserves the right to modify or update these Terms and Conditions at any time. Continued use of the app after revisions means you agree to the updated terms.

7. CONTACT INFORMATION - For assistance, verification inquiries, or ticket concerns, please visit the designated EcoRide-BASC related office.`,
        version: "1.0",
        lastUpdated: new Date(),
        isActive: true,
      });
    }
    
    res.status(StatusCodes.OK).json(terms);
  } catch (error) {
    console.error("Error fetching terms:", error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: "Failed to fetch terms and conditions" 
    });
  }
};

// Get all terms history (admin only)
export const getAllTerms = async (req, res) => {
  try {
    const terms = await TermsAndConditions.find()
      .populate("updatedBy", "firstName lastName email")
      .sort({ lastUpdated: -1 });
    
    res.status(StatusCodes.OK).json({ terms });
  } catch (error) {
    console.error("Error fetching terms history:", error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: "Failed to fetch terms history" 
    });
  }
};

// Create or update terms and conditions (admin only)
export const updateTerms = async (req, res) => {
  try {
    const { content, version, isReset } = req.body;
    const adminId = req.user.userId;
    
    if (!content || !content.trim()) {
      throw new BadRequestError("Terms and conditions content is required");
    }
    
    // Get old version for logging
    const oldTerms = await TermsAndConditions.findOne({ isActive: true });
    const oldVersion = oldTerms?.version || 'None';
    
    // Deactivate all existing terms
    await TermsAndConditions.updateMany({}, { isActive: false });
    
    // Create new active terms
    const newTerms = await TermsAndConditions.create({
      content: content.trim(),
      version: version || "1.0",
      lastUpdated: new Date(),
      updatedBy: adminId,
      isActive: true,
    });
    
    const populatedTerms = await TermsAndConditions.findById(newTerms._id)
      .populate("updatedBy", "firstName lastName email");
    
    // Log activity
    try {
      const adminName = await getAdminName(adminId);
      const action = isReset ? 'RESET_TERMS' : 'UPDATED_TERMS';
      const description = isReset 
        ? `Reset Terms and Conditions to default (Version ${version || '1.0'})`
        : `Updated Terms and Conditions from Version ${oldVersion} to Version ${version || '1.0'}`;
      
      await ActivityLog.create({
        admin: adminId,
        adminName: adminName,
        action: action,
        targetType: 'TERMS',
        targetId: newTerms._id,
        targetName: 'Terms and Conditions',
        description: description,
        metadata: {
          oldVersion: oldVersion,
          newVersion: version || '1.0',
          isReset: isReset || false,
          contentLength: content.trim().length
        },
        ipAddress: req.ip
      });
      console.log(`📝 Activity logged: ${action} by ${adminName}`);
    } catch (logError) {
      console.error('⚠️ Failed to log activity (non-critical):', logError.message);
    }
    
    console.log(`✅ Terms and conditions updated by admin ${adminId}`);
    
    res.status(StatusCodes.OK).json({
      message: "Terms and conditions updated successfully",
      terms: populatedTerms,
    });
  } catch (error) {
    console.error("Error updating terms:", error);
    if (error instanceof BadRequestError) {
      throw error;
    }
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: "Failed to update terms and conditions" 
    });
  }
};

// Delete terms (admin only - for cleanup)
export const deleteTerms = async (req, res) => {
  try {
    const { id } = req.params;
    
    const terms = await TermsAndConditions.findById(id);
    
    if (!terms) {
      throw new NotFoundError("Terms and conditions not found");
    }
    
    if (terms.isActive) {
      throw new BadRequestError("Cannot delete active terms and conditions");
    }
    
    await terms.deleteOne();
    
    console.log(`🗑️ Terms and conditions deleted by admin ${req.user.userId}`);
    
    res.status(StatusCodes.OK).json({
      message: "Terms and conditions deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting terms:", error);
    if (error instanceof BadRequestError || error instanceof NotFoundError) {
      throw error;
    }
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      message: "Failed to delete terms and conditions" 
    });
  }
};
