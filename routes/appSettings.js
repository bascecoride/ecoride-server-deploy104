import express from "express";
import {
  getAllSettings,
  getSettingByKey,
  getDistanceRadius,
  updateSetting,
  bulkUpdateSettings,
} from "../controllers/appSettings.js";
import auth from "../middleware/authentication.js";
import isAdmin from "../middleware/admin.js";

const router = express.Router();

// Public routes (for mobile app)
router.get("/distance-radius", getDistanceRadius);

// Admin protected routes
router.get("/", auth, isAdmin, getAllSettings);
router.get("/:key", auth, isAdmin, getSettingByKey);
router.put("/", auth, isAdmin, updateSetting);
router.put("/bulk", auth, isAdmin, bulkUpdateSettings);

export default router;
