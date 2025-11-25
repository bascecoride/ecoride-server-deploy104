import express from 'express';
import { createRide, updateRideStatus, acceptRide, getMyRides, cancelRide, getSearchingRides, updatePaymentMethod } from '../controllers/ride.js';

const router = express.Router();

// The io instance is already attached to req in app.js, so no need for additional middleware

router.post('/create', createRide);
router.patch('/accept/:rideId', acceptRide);
router.patch('/update/:rideId', updateRideStatus);
router.patch('/payment/:rideId', updatePaymentMethod);
router.delete('/cancel/:rideId', cancelRide);
router.get('/rides', getMyRides);
router.get('/searching', getSearchingRides);

export default router;
