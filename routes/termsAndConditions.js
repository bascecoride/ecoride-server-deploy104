import express from "express";
import {
  getActiveTerms,
  getAllTerms,
  updateTerms,
  deleteTerms,
} from "../controllers/termsAndConditions.js";
import authMiddleware from "../middleware/authentication.js";
import adminMiddleware from "../middleware/admin.js";

const router = express.Router();

// Public route - no authentication required
router.get("/active", getActiveTerms);

// Admin only routes
router.get("/all", authMiddleware, adminMiddleware, getAllTerms);
router.post("/update", authMiddleware, adminMiddleware, updateTerms);
router.delete("/:id", authMiddleware, adminMiddleware, deleteTerms);

export default router;
