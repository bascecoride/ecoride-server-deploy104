import Ride from "../models/Ride.js";
import { BadRequestError, NotFoundError } from "../errors/index.js";
import { StatusCodes } from "http-status-codes";
import {
  calculateDistance,
  calculateFare,
  generateOTP,
} from "../utils/mapUtils.js";
import { broadcastNewRideRequest, broadcastRideAccepted } from "./sockets.js";


export const acceptRide = async (req, res) => {
  const riderId = req.user.id;
  const { rideId } = req.params;

  if (!rideId) {
    throw new BadRequestError("Ride ID is required");
  }

  try {
    let ride = await Ride.findById(rideId).populate("customer", "firstName lastName phone");

    if (!ride) {
      throw new NotFoundError("Ride not found");
    }

    if (ride.status !== "SEARCHING_FOR_RIDER") {
      throw new BadRequestError("Ride is no longer available for assignment");
    }

    // Get rider details to check vehicle type
    const User = (await import('../models/User.js')).default;
    const rider = await User.findById(riderId);
    
    if (!rider) {
      throw new NotFoundError("Rider not found");
    }

    // Check if rider's vehicle type matches the ride's requested vehicle type
    if (rider.vehicleType !== ride.vehicle) {
      console.log(`❌ Vehicle type mismatch: Rider has ${rider.vehicleType}, but ride requires ${ride.vehicle}`);
      throw new BadRequestError(`This ride requires a ${ride.vehicle}. Your vehicle type is ${rider.vehicleType}. Please update your profile to match the ride requirements.`);
    }

    console.log(`✅ Vehicle type match: Rider ${riderId} with ${rider.vehicleType} accepting ${ride.vehicle} ride`);

    ride.rider = riderId;
    ride.status = "START";
    await ride.save();

    ride = await ride.populate("rider", "firstName lastName phone vehicleType");

    // Broadcast to the specific ride room
    if (req.io) {
      console.log(`Broadcasting ride acceptance for ride ${rideId}`);
      console.log(`Ride status: ${ride.status}, OTP: ${ride.otp}`);
      console.log(`Customer ID: ${ride.customer}, Rider ID: ${riderId}`);
      
      // Send updated ride data to the ride room
      req.io.to(`ride_${rideId}`).emit("rideUpdate", ride);
      req.io.to(`ride_${rideId}`).emit("rideAccepted", ride);
      
      // Also try to find and directly notify the customer
      const customerSocket = [...req.io.sockets.sockets.values()].find(
        socket => socket.user?.id === ride.customer.toString()
      );
      if (customerSocket) {
        console.log(`Found customer socket, directly notifying customer ${ride.customer}`);
        customerSocket.emit("rideUpdate", ride);
        customerSocket.emit("rideAccepted", ride);
        customerSocket.emit("rideData", ride); // Also send as rideData to force update
      } else {
        console.log(`Customer socket not found for customer ${ride.customer}`);
      }
      
      // Send ride data with OTP to the rider who accepted
      const riderSocket = [...req.io.sockets.sockets.values()].find(
        socket => socket.user?.id === riderId
      );
      if (riderSocket) {
        console.log(`Found rider socket, notifying rider ${riderId}`);
        riderSocket.emit("rideAccepted", ride);
      } else {
        console.log(`Rider socket not found for rider ${riderId}`);
      }
      
      // Broadcast to all on-duty riders that this ride is no longer available
      broadcastRideAccepted(req.io, rideId);
      
      console.log(`Ride ${rideId} acceptance broadcast completed`);
    }

    res.status(StatusCodes.OK).json({
      message: "Ride accepted successfully",
      ride,
    });
  } catch (error) {
    console.error("Error accepting ride:", error);
    throw new BadRequestError("Failed to accept ride");
  }
};

export const updateRideStatus = async (req, res) => {
  const { rideId } = req.params;
  const { status } = req.body;

  if (!rideId || !status) {
    throw new BadRequestError("Ride ID and status are required");
  }

  try {
    let ride = await Ride.findById(rideId).populate("customer", "firstName lastName phone").populate("rider", "firstName lastName phone vehicleType");

    if (!ride) {
      throw new NotFoundError("Ride not found");
    }

    if (!["START", "ARRIVED", "COMPLETED"].includes(status)) {
      throw new BadRequestError("Invalid ride status");
    }
    
    // CRITICAL: Never allow changing status of a COMPLETED ride
    if (ride.status === "COMPLETED") {
      console.log(`🔒 Protected: Ride ${rideId} is already COMPLETED - status change to ${status} rejected`);
      
      // Return the ride without changing it
      return res.status(StatusCodes.OK).json({
        message: `Ride is already completed and cannot be changed`,
        ride,
      });
    }
    
    // Log the status change with detailed information
    console.log(`📝 Ride ${rideId} status change: ${ride.status} → ${status}`);
    console.log(`📍 Ride details: Customer=${ride.customer._id}, Rider=${ride.rider?._id || 'None'}, OTP=${ride.otp}`);
    
    // Update the status
    ride.status = status;
    await ride.save();
    
    // Log confirmation of successful update
    console.log(`✅ Ride ${rideId} status successfully updated to ${status}`);

    // Broadcast to ride room
    if (req.io) {
      console.log(`Broadcasting ride status update: ${status} for ride ${rideId}`);
      req.io.to(`ride_${rideId}`).emit("rideUpdate", ride);
      
      // Also directly notify the customer
      const customerSocket = [...req.io.sockets.sockets.values()].find(
        socket => socket.user?.id === ride.customer._id.toString()
      );
      if (customerSocket) {
        console.log(`Directly notifying customer ${ride.customer._id} about status update`);
        customerSocket.emit("rideUpdate", ride);
        customerSocket.emit("rideData", ride);
      }
      
      // If completed, send completion event and remove from riders' lists
      if (status === "COMPLETED") {
        req.io.to(`ride_${rideId}`).emit("rideCompleted", ride);
        if (customerSocket) {
          customerSocket.emit("rideCompleted", ride);
        }
        
        // Remove from all on-duty riders' lists (in case it's still showing)
        req.io.to("onDuty").emit("rideCompleted", { 
          _id: rideId,
          rideId: rideId,
          ride: ride
        });
        
        console.log(`🎉 Ride ${rideId} completed - removed from all riders' lists`);
      }
    }

    res.status(StatusCodes.OK).json({
      message: `Ride status updated to ${status}`,
      ride,
    });
  } catch (error) {
    console.error("Error updating ride status:", error);
    throw new BadRequestError("Failed to update ride status");
  }
};

export const cancelRide = async (req, res) => {
  const { rideId } = req.params;
  const { reason } = req.body;
  const userId = req.user.id;

  if (!rideId) {
    throw new BadRequestError("Ride ID is required");
  }

  try {
    const ride = await Ride.findById(rideId)
      .populate("customer", "firstName lastName phone")
      .populate("rider", "firstName lastName phone");

    if (!ride) {
      throw new NotFoundError("Ride not found");
    }

    // Check if the user is authorized to cancel this ride
    if (ride.customer._id.toString() !== userId && ride.rider?._id.toString() !== userId) {
      throw new BadRequestError("You are not authorized to cancel this ride");
    }

    // CRITICAL: Never allow cancellation of a COMPLETED ride
    if (ride.status === "COMPLETED") {
      console.log(`🔒 Protected: Ride ${rideId} is already COMPLETED - cancellation rejected`);
      return res.status(StatusCodes.BAD_REQUEST).json({
        message: "Ride is already completed and cannot be cancelled",
      });
    }
    
    // Only allow cancellation if ride is still searching or just started
    if (!["SEARCHING_FOR_RIDER", "START", "ARRIVED"].includes(ride.status)) {
      throw new BadRequestError("Ride cannot be cancelled at this stage");
    }

    // Determine who cancelled the ride
    const cancelledBy = ride.customer._id.toString() === userId ? "customer" : "rider";
    const cancellerName = cancelledBy === "customer" 
      ? `${ride.customer.firstName} ${ride.customer.lastName}` 
      : `${ride.rider?.firstName} ${ride.rider?.lastName}`;
    
    // Save cancellation reason
    if (reason) {
      ride.cancellationReason = reason;
      console.log(`📝 Cancellation reason saved: "${reason}" by ${cancelledBy}`);
    }

    // If rider cancelled, add them to blacklist so they never see this ride again
    if (cancelledBy === "rider") {
      if (!ride.blacklistedRiders) {
        ride.blacklistedRiders = [];
      }
      if (!ride.blacklistedRiders.includes(userId)) {
        ride.blacklistedRiders.push(userId);
        console.log(`🚫 Rider ${userId} added to blacklist for ride ${rideId} - they will not see this ride again`);
      }
      
      // If ride was still searching, reset it so other riders can accept
      if (ride.status === "SEARCHING_FOR_RIDER") {
        ride.rider = null;
        console.log(`♻️ Ride ${rideId} reset to SEARCHING_FOR_RIDER for other riders (excluding blacklisted rider ${userId})`);
      } else {
        // If ride was already accepted (START/ARRIVED), mark as CANCELLED
        ride.status = "CANCELLED";
        ride.cancelledBy = cancelledBy;
        ride.cancelledByName = cancellerName;
        ride.cancelledAt = new Date();
        console.log(`🚫 Ride ${rideId} marked as CANCELLED by rider ${userId}`);
      }
    } else {
      // Customer cancelled - mark ride as CANCELLED
      ride.status = "CANCELLED";
      ride.cancelledBy = cancelledBy;
      ride.cancelledByName = cancellerName;
      ride.cancelledAt = new Date();
      console.log(`🚫 Ride ${rideId} cancelled by customer ${userId}, status updated to CANCELLED`);
    }
    
    await ride.save();

    // Broadcast cancellation to all relevant parties
    if (req.io) {
      console.log(`📢 Broadcasting cancellation for ride ${rideId} to all connected parties`);
      
      // Emit to ride room
      req.io.to(`ride_${rideId}`).emit("rideCanceled", { 
        message: "Ride has been cancelled",
        ride: ride,
        cancelledBy: cancelledBy,
        cancellerName: cancellerName
      });
      
      console.log(`✅ Emitted rideCanceled to ride room: ride_${rideId}`);
      
      // If passenger cancelled after driver accepted, send alert to driver
      if (cancelledBy === "customer" && ride.rider && ride.status !== "SEARCHING_FOR_RIDER") {
        const riderSocket = [...req.io.sockets.sockets.values()].find(
          socket => socket.user?.id === ride.rider._id.toString()
        );
        
        if (riderSocket) {
          console.log(`🚨 Sending cancellation alert to rider ${ride.rider._id}`);
          riderSocket.emit("passengerCancelledRide", {
            rideId: rideId,
            message: `${cancellerName} has cancelled the ride`,
            passengerName: cancellerName,
            ride: ride
          });
        }
      }
      
      // If driver cancelled, send alert to passenger
      if (cancelledBy === "rider" && ride.customer) {
        const customerSocket = [...req.io.sockets.sockets.values()].find(
          socket => socket.user?.id === ride.customer._id.toString()
        );
        
        if (customerSocket) {
          console.log(`🚨 Sending cancellation alert to customer ${ride.customer._id}`);
          customerSocket.emit("riderCancelledRide", {
            rideId: rideId,
            message: `${cancellerName} has cancelled the ride`,
            riderName: cancellerName,
            ride: ride
          });
        }
        
        // If rider cancelled and ride is still SEARCHING (reset for other riders),
        // only remove it from the cancelling rider's screen
        if (ride.status === "SEARCHING_FOR_RIDER") {
          const cancellingRiderSocket = [...req.io.sockets.sockets.values()].find(
            socket => socket.user?.id === userId
          );
          
          if (cancellingRiderSocket) {
            console.log(`🚫 Removing ride ${rideId} from cancelling rider ${userId}'s screen only`);
            cancellingRiderSocket.emit("rideRemovedForYou", rideId);
          }
        } else {
          // If ride was fully cancelled (not reset), remove from all riders
          req.io.to("onDuty").emit("rideOfferCanceled", rideId);
        }
      } else {
        // Customer cancelled or ride fully cancelled - remove from all riders
        console.log(`🚫 Customer cancelled ride ${rideId} - removing from ALL on-duty riders' screens`);
        req.io.to("onDuty").emit("rideOfferCanceled", rideId);
        console.log(`✅ Emitted rideOfferCanceled to onDuty room for ride ${rideId}`);
        
        // Also emit rideCanceled with ride data for additional handling
        req.io.to("onDuty").emit("rideCanceled", {
          rideId: rideId,
          ride: ride,
          cancelledBy: cancelledBy
        });
        console.log(`✅ Emitted rideCanceled to onDuty room for ride ${rideId}`);
      }
      
      console.log(`📢 Broadcasted ride ${rideId} cancellation to all relevant parties`);
    }

    res.status(StatusCodes.OK).json({
      message: "Ride cancelled successfully",
      ride: ride,
      cancelledBy: cancelledBy
    });
  } catch (error) {
    console.error("Error cancelling ride:", error);
    throw new BadRequestError("Failed to cancel ride");
  }
};

export const getMyRides = async (req, res) => {
  const userId = req.user.id;
  const { status } = req.query;

  try {
    const query = {
      $or: [{ customer: userId }, { rider: userId }],
    };

    if (status) {
      query.status = status;
    }

    const rides = await Ride.find(query)
      .populate("customer", "firstName lastName phone email")
      .populate("rider", "firstName lastName phone email vehicleType")
      .sort({ createdAt: -1 });

    res.status(StatusCodes.OK).json({
      message: "Rides retrieved successfully",
      count: rides.length,
      rides,
    });
  } catch (error) {
    console.error("Error retrieving rides:", error);
    throw new BadRequestError("Failed to retrieve rides");
  }
};

export const getSearchingRides = async (req, res) => {
  try {
    const riderId = req.user.id;
    
    // Get rider's vehicle type from database (for logging purposes)
    const User = (await import('../models/User.js')).default;
    const rider = await User.findById(riderId).select('vehicleType');
    const riderVehicleType = rider?.vehicleType || "Unknown";
    
    // Return ALL searching rides (client will handle visual feedback for mismatched rides)
    // Only rides with SEARCHING_FOR_RIDER status (cancelled/timeout rides have different status)
    const allRides = await Ride.find({ 
      status: "SEARCHING_FOR_RIDER"
    }).populate("customer", "firstName lastName phone");
    
    console.log(`API: Found ${allRides.length} searching rides (ALL vehicle types) for rider ${riderId} (vehicle: ${riderVehicleType})`);
    
    // Log vehicle type breakdown
    if (allRides.length > 0) {
      const vehicleBreakdown = allRides.reduce((acc, ride) => {
        acc[ride.vehicle] = (acc[ride.vehicle] || 0) + 1;
        return acc;
      }, {});
      console.log(`API: Vehicle types: ${JSON.stringify(vehicleBreakdown)}`);
    }
    
    res.status(StatusCodes.OK).json({
      message: "Searching rides retrieved successfully (ALL vehicle types)",
      count: allRides.length,
      rides: allRides,
      riderVehicleType: riderVehicleType,
    });
  } catch (error) {
    console.error("Error retrieving searching rides:", error);
    throw new BadRequestError("Failed to retrieve searching rides");
  }
};

export const createRide = async (req, res) => {
  const { vehicle, pickup, drop } = req.body;
  const customerId = req.user.id; // Fixed: Use req.user.id instead of req.user

  if (!vehicle || !pickup || !drop) {
    throw new BadRequestError("Vehicle, pickup, and drop locations are required.");
  }

  try {
    // Calculate distance between pickup and drop
    const distance = calculateDistance(
      pickup.latitude,
      pickup.longitude,
      drop.latitude,
      drop.longitude
    );
    
    console.log(`🛣️ Distance calculated: ${distance.toFixed(2)} km`);
    
    // Calculate fare based on vehicle type and distance
    const fareOptions = await calculateFare(distance);
    const fare = fareOptions[vehicle];
    console.log(`💰 Fare calculated: ${fare} for ${vehicle}`);

    // Generate OTP
    const otp = generateOTP(); // Fixed: Use correct function name
    
    console.log(`🔑 Creating ride with OTP: ${otp}`);

    const ride = await Ride.create({
      customer: customerId,
      pickup,
      drop,
      vehicle,
      distance,
      fare,
      otp,
      status: "SEARCHING_FOR_RIDER",
    });

    console.log(`✅ Ride created with ID: ${ride._id}, OTP: ${otp}`);

    // Populate the ride with customer info
    const populatedRide = await Ride.findById(ride._id).populate("customer", "firstName lastName phone");

    // Broadcast new ride to ALL on-duty riders
    if (req.io) {
      console.log(`🚨 Broadcasting new ride ${ride._id} to all on-duty riders`);
      
      // Get count of on-duty riders
      const onDutyRoom = req.io.sockets.adapter.rooms.get('onDuty');
      const onDutyCount = onDutyRoom ? onDutyRoom.size : 0;
      console.log(`👥 Currently ${onDutyCount} riders on duty`);
      
      // Emit the new ride request to all on-duty riders
      req.io.to("onDuty").emit("newRideRequest", populatedRide);
      console.log(`📢 Emitted 'newRideRequest' event for ride ${ride._id}`);
      
      // Also emit updated list of all searching rides
      const allSearchingRides = await Ride.find({ 
        status: "SEARCHING_FOR_RIDER" 
      }).populate("customer", "firstName lastName phone");
      
      console.log(`📋 Sending updated list of ${allSearchingRides.length} searching rides`);
      req.io.to("onDuty").emit("allSearchingRides", allSearchingRides);
      
      // Log the IDs of all searching rides for debugging
      if (allSearchingRides.length > 0) {
        const rideIds = allSearchingRides.map(r => r._id.toString());
        console.log(`📝 Current searching ride IDs: ${rideIds.join(', ')}`);
      }
      
      // Direct broadcast to each on-duty rider individually as a fallback
      const sockets = await req.io.fetchSockets();
      const riderSockets = sockets.filter(socket => 
        socket.user?.role === 'rider' && 
        socket.rooms.has('onDuty')
      );
      
      console.log(`🔄 Direct broadcasting to ${riderSockets.length} rider sockets`);
      
      riderSockets.forEach(socket => {
        socket.emit("newRideRequest", populatedRide);
        socket.emit("allSearchingRides", allSearchingRides);
        console.log(`📲 Direct emit to rider: ${socket.user?.id}`);
      });
    }

    res
      .status(StatusCodes.CREATED)
      .json({ message: "Ride created successfully", ride: populatedRide });
  } catch (error) {
    console.error("❌ Error creating ride:", error);
    throw new BadRequestError("Failed to create ride");
  }
};
