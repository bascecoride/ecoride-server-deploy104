import geolib from "geolib";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Ride from "../models/Ride.js";
import Rating from "../models/Rating.js";
import Chat from "../models/Chat.js";
import Message from "../models/Message.js";
import AppSettings from "../models/AppSettings.js";

// Helper function to get distance radius from database (with caching)
let cachedDistanceRadius = null;
let cacheTimestamp = null;
const CACHE_DURATION = 30000; // 30 seconds cache (reduced for faster updates)

// Export function to invalidate cache (called when admin updates setting)
export const invalidateDistanceRadiusCache = () => {
  cachedDistanceRadius = null;
  cacheTimestamp = null;
  console.log("🔄 Distance radius cache invalidated");
};

const getDistanceRadiusInMeters = async () => {
  try {
    // Check if cache is valid
    if (cachedDistanceRadius !== null && cacheTimestamp && (Date.now() - cacheTimestamp < CACHE_DURATION)) {
      console.log(`📏 Using cached distance radius: ${cachedDistanceRadius}m`);
      return cachedDistanceRadius;
    }
    
    // Fetch from database
    let setting = await AppSettings.findOne({ settingKey: "DISTANCE_RADIUS" });
    
    // If setting doesn't exist, create default (3km)
    if (!setting) {
      setting = await AppSettings.create({
        settingKey: "DISTANCE_RADIUS",
        value: 3,
        unit: "km",
        description: "Maximum distance radius for showing nearby riders/bookings"
      });
      console.log("✅ Created default distance radius setting: 3km");
    }
    
    // Convert km to meters and cache
    cachedDistanceRadius = setting.value * 1000;
    cacheTimestamp = Date.now();
    
    console.log(`📏 Distance radius loaded from DB: ${setting.value}km (${cachedDistanceRadius}m)`);
    return cachedDistanceRadius;
  } catch (error) {
    console.error("❌ Error fetching distance radius:", error);
    // Default fallback: 3km = 3000 meters
    return 3000;
  }
};

const onDutyRiders = new Map();

const handleSocketConnection = (io) => {
  io.use(async (socket, next) => {
    try {
      console.log(`🔐 Socket auth attempt from ${socket.id}`);
      
      // Get token from headers
      const token = socket.handshake.headers.access_token;
      if (!token) {
        console.log(`❌ Socket auth failed: No token provided`);
        return next(new Error("Authentication invalid: No token"));
      }
      
      console.log(`🔍 Verifying token: ${token.substring(0, 15)}...`);
      
      // Verify token
      const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
      console.log(`✅ Token verified for user: ${payload.id}, role: ${payload.role}`);
      
      // Find user in database
      const user = await User.findById(payload.id);
      if (!user) {
        console.log(`❌ User not found: ${payload.id}`);
        return next(new Error("Authentication invalid: User not found"));
      }
      
      console.log(`👤 User authenticated: ${user.firstName} ${user.lastName} (${user.role})`);
      
      // Attach user to socket
      socket.user = { id: payload.id, role: user.role };
      next();
    } catch (error) {
      console.error(`⚠️ Socket Auth Error for ${socket.id}:`, error.message);
      next(new Error(`Authentication invalid: ${error.message}`));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.user;
    console.log(`👤 User Joined: ${user.id} (${user.role}) - Socket ID: ${socket.id}`);
    
    // Join user-specific room for targeted notifications (like account disapproval)
    socket.join(`user_${user.id}`);
    console.log(`🏠 User ${user.id} joined room: user_${user.id}`);
    
    // Log all registered event listeners for debugging
    console.log(`📋 Registering socket events for ${user.role}...`);

    if (user.role === "rider") {
      console.log(`🏍️ Setting up rider-specific events for ${user.id}`);
      
      socket.on("goOnDuty", async (coords) => {
        console.log(`📥 Received goOnDuty event from rider ${user.id}`);
        console.log(`📥 Raw coords received:`, coords);
        // Get rider's vehicle type from database
        const riderInfo = await User.findById(user.id).select("vehicleType firstName lastName");
        
        console.log(`🚗 Rider ${user.id} (${riderInfo?.firstName} ${riderInfo?.lastName}) going on duty with coords:`, coords);
        console.log(`🚗 Rider ${user.id} vehicle type:`, riderInfo?.vehicleType);
        
        // Validate coordinates before storing
        if (!coords || typeof coords.latitude !== 'number' || typeof coords.longitude !== 'number') {
          console.error(`❌ Rider ${user.id} provided invalid coordinates:`, coords);
          return;
        }
        
        // Ensure coordinates are valid numbers
        const validCoords = {
          latitude: parseFloat(coords.latitude),
          longitude: parseFloat(coords.longitude),
          heading: coords.heading || 0
        };
        
        if (isNaN(validCoords.latitude) || isNaN(validCoords.longitude)) {
          console.error(`❌ Rider ${user.id} coordinates are NaN after parsing:`, validCoords);
          return;
        }
        
        console.log(`✅ Rider ${user.id} validated coords:`, validCoords);
        
        onDutyRiders.set(user.id, { 
          socketId: socket.id, 
          coords: validCoords,
          riderId: user.id,
          vehicleType: riderInfo?.vehicleType || "Tricycle", // Store vehicle type
          name: `${riderInfo?.firstName || ''} ${riderInfo?.lastName || ''}`
        });
        
        // Join the onDuty room
        socket.join("onDuty");
        console.log(`✅ Rider ${user.id} is now on duty with vehicle: ${riderInfo?.vehicleType || "Tricycle"}`);
        console.log(`👥 Total on-duty riders: ${onDutyRiders.size}`);
        
        // Immediately send ALL searching rides to the newly on-duty rider (client will handle visual feedback for mismatched rides)
        try {
          const riderVehicleType = riderInfo?.vehicleType || "Tricycle";
          // Only get rides with SEARCHING_FOR_RIDER status (cancelled/timeout rides have different status)
          // Filter out rides where this rider is blacklisted
          const searchingRides = await Ride.find({ 
            status: "SEARCHING_FOR_RIDER",
            blacklistedRiders: { $ne: user.id } // Exclude rides where rider is blacklisted
          }).populate("customer", "firstName lastName phone");
          
          console.log(`📤 Sending ${searchingRides.length} searching rides (ALL vehicle types) to newly on-duty rider ${user.id} (vehicle: ${riderVehicleType})`);
          
          // Force a small delay to ensure socket is ready (helps with race conditions)
          setTimeout(() => {
            // Send all rides at once
            socket.emit("allSearchingRides", searchingRides);
            
            // Also send individual ride notifications to ensure they're received
            if (searchingRides.length > 0) {
              console.log(`📝 Sending individual ride notifications for ${searchingRides.length} rides`);
              searchingRides.forEach(ride => {
                socket.emit("newRideRequest", ride);
              });
              
              // Log the ride IDs and vehicle types
              const rideIds = searchingRides.map(r => r._id.toString());
              console.log(`📝 Ride IDs: ${rideIds.join(', ')}`);
              
              // Log vehicle type breakdown
              const vehicleBreakdown = searchingRides.reduce((acc, ride) => {
                acc[ride.vehicle] = (acc[ride.vehicle] || 0) + 1;
                return acc;
              }, {});
              console.log(`🚗 Vehicle types: ${JSON.stringify(vehicleBreakdown)}`);
            } else {
              console.log(`🚧 No searching rides found for newly on-duty rider ${user.id}`);
            }
            
            // Confirm successful send
            console.log(`✅ Successfully sent ${searchingRides.length} rides to newly on-duty rider ${user.id}`);
          }, 500); // Small delay to ensure socket is ready
        } catch (error) {
          console.error("❌ Error sending rides to newly on-duty rider:", error);
        }
        
        updateNearbyriders();
      });

      socket.on("goOffDuty", () => {
        onDutyRiders.delete(user.id);
        socket.leave("onDuty");
        console.log(`rider ${user.id} is now off duty.`);
        updateNearbyriders();
      });

      socket.on("updateLocation", async (coords) => {
        // Validate coordinates before updating
        if (!coords || typeof coords.latitude !== 'number' || typeof coords.longitude !== 'number') {
          console.warn(`⚠️ Rider ${user.id} sent invalid location update:`, coords);
          return;
        }
        
        const validCoords = {
          latitude: parseFloat(coords.latitude),
          longitude: parseFloat(coords.longitude),
          heading: coords.heading || 0
        };
        
        if (isNaN(validCoords.latitude) || isNaN(validCoords.longitude)) {
          console.warn(`⚠️ Rider ${user.id} location update has NaN values:`, validCoords);
          return;
        }
        
        // Check if rider is in the onDuty room but not in the Map (race condition fix)
        const isInOnDutyRoom = socket.rooms.has('onDuty');
        
        if (onDutyRiders.has(user.id)) {
          // Normal case: rider is in the Map, just update coords
          onDutyRiders.get(user.id).coords = validCoords;
          console.log(`📍 Rider ${user.id} updated location: (${validCoords.latitude}, ${validCoords.longitude})`);
        } else if (isInOnDutyRoom) {
          // Race condition case: rider is in onDuty room but not in Map
          // Re-register them in the Map
          console.log(`🔄 Rider ${user.id} is in onDuty room but not in Map - re-registering...`);
          
          // Get rider info from database
          const riderInfo = await User.findById(user.id).select("vehicleType firstName lastName");
          
          onDutyRiders.set(user.id, { 
            socketId: socket.id, 
            coords: validCoords,
            riderId: user.id,
            vehicleType: riderInfo?.vehicleType || "Tricycle",
            name: `${riderInfo?.firstName || ''} ${riderInfo?.lastName || ''}`
          });
          
          console.log(`✅ Rider ${user.id} re-registered in onDutyRiders Map with vehicle: ${riderInfo?.vehicleType || "Tricycle"}`);
        } else {
          // Rider is not on duty at all - ignore the update
          console.log(`⚠️ Rider ${user.id} sent location update but is not on duty - ignoring`);
          return;
        }
        
        updateNearbyriders();
        socket.to(`rider_${user.id}`).emit("riderLocationUpdate", {
          riderId: user.id,
          coords: validCoords,
        });
      });

      // Handle request for all searching rides (city-wide)
      socket.on("requestAllSearchingRides", async () => {
        try {
          console.log(`🔍 Rider ${user.id} requesting all searching rides`);
          
          // Get rider's vehicle type from database
          const riderUser = await User.findById(user.id).select('vehicleType firstName lastName');
          const vehicleType = riderUser?.vehicleType || "Single Motorcycle";
          console.log(`🚗 Rider ${user.id} vehicle type: ${vehicleType}`);
          
          // RACE CONDITION FIX: Ensure rider is properly registered in onDutyRiders Map
          // This handles the case where rider is in onDuty room but not in the Map
          const isInOnDutyRoom = socket.rooms.has('onDuty');
          const isInMap = onDutyRiders.has(user.id);
          
          if (isInOnDutyRoom && !isInMap) {
            console.log(`🔄 Rider ${user.id} is in onDuty room but not in Map during requestAllSearchingRides - requesting location sync`);
            socket.emit("requestLocationSync", { 
              message: "Please sync your location to receive ride requests",
              reason: "map_registration_missing"
            });
          }
          
          // Find ALL rides with SEARCHING_FOR_RIDER status (NO vehicle filter - client will handle visual feedback)
          // Only rides with SEARCHING_FOR_RIDER status (cancelled/timeout rides have different status)
          // Filter out rides where this rider is blacklisted
          const searchingRides = await Ride.find({ 
            status: "SEARCHING_FOR_RIDER",
            blacklistedRiders: { $ne: user.id } // Exclude rides where rider is blacklisted
          }).populate("customer", "firstName lastName phone");
          
          console.log(`📋 Found ${searchingRides.length} searching rides (ALL vehicle types) for rider ${user.id}`);
          
          // Send all rides to the rider
          console.log(`📤 Emitting ${searchingRides.length} rides to rider ${user.id}`);
          
          // Force a small delay to ensure socket is ready (helps with race conditions)
          setTimeout(() => {
            socket.emit("allSearchingRides", searchingRides);
            
            // Log success message
            console.log(`✅ Successfully sent ${searchingRides.length} rides to rider ${user.id}`);
            
            // Log the ride IDs for debugging
            if (searchingRides.length > 0) {
              const rideIds = searchingRides.map(r => r._id.toString());
              console.log(`📝 Ride IDs: ${rideIds.join(', ')}`);
              
              // Log vehicle type breakdown
              const vehicleBreakdown = searchingRides.reduce((acc, ride) => {
                acc[ride.vehicle] = (acc[ride.vehicle] || 0) + 1;
                return acc;
              }, {});
              console.log(`🚗 Vehicle types: ${JSON.stringify(vehicleBreakdown)}`);
              
              // Log more details about each ride
              searchingRides.forEach(ride => {
                console.log(`📍 Ride ${ride._id}: ${ride.pickup?.address} to ${ride.drop?.address}, Vehicle: ${ride.vehicle}, Fare: ${ride.fare}`);
              });
            } else {
              console.log(`🚧 No searching rides found for rider ${user.id}`);
            }
          }, 100); // Small delay to ensure socket is ready
        } catch (error) {
          console.error(`❌ Error fetching searching rides for rider ${user.id}:`, error);
          socket.emit("allSearchingRides", []);
        }
      });
    }

    if (user.role === "customer") {
      socket.on("subscribeToZone", (customerCoords) => {
        console.log(`Customer ${user.id} subscribing to zone with coords:`, customerCoords);
        
        // Validate customer coordinates
        if (!customerCoords || typeof customerCoords.latitude !== 'number' || typeof customerCoords.longitude !== 'number') {
          console.error(`❌ Customer ${user.id} provided invalid coordinates:`, customerCoords);
          socket.emit("nearbyriders", []);
          return;
        }
        
        const validCoords = {
          latitude: parseFloat(customerCoords.latitude),
          longitude: parseFloat(customerCoords.longitude)
        };
        
        if (isNaN(validCoords.latitude) || isNaN(validCoords.longitude)) {
          console.error(`❌ Customer ${user.id} coordinates are NaN:`, validCoords);
          socket.emit("nearbyriders", []);
          return;
        }
        
        console.log(`✅ Customer ${user.id} validated coords:`, validCoords);
        socket.user.coords = validCoords;
        sendNearbyRiders(socket, validCoords);
      });

      socket.on("getDriverDetails", async ({ riderId }) => {
        try {
          if (!riderId) {
            return socket.emit("error", { message: "Driver ID is required" });
          }
          
          const driver = await User.findById(riderId).select("firstName lastName phone licenseId photo vehicleType plateNumber _id");
          
          if (!driver) {
            return socket.emit("error", { message: "Driver not found" });
          }
          
          // Get driver's ratings
          const ratings = await Rating.find({ rider: riderId });
          
          // Calculate average rating
          const totalRatings = ratings.length;
          const sumRatings = ratings.reduce((sum, rating) => sum + rating.rating, 0);
          const averageRating = totalRatings > 0 ? (sumRatings / totalRatings).toFixed(1) : "0.0";
          
          // Get vehicle type from onDuty data or database
          const vehicleType = onDutyRiders.get(riderId)?.vehicleType || driver?.vehicleType || "Tricycle";
          
          // Send driver details back to the customer
          socket.emit("driverDetailsResponse", {
            _id: driver._id,
            firstName: driver.firstName,
            lastName: driver.lastName,
            phone: driver.phone,
            licenseId: driver.licenseId,
            plateNumber: driver.plateNumber || null,
            photo: driver.photo || null,
            averageRating: averageRating,
            totalRatings: totalRatings,
            vehicleType: vehicleType
          });
          
          console.log(`Sent driver ${riderId} details to customer ${user.id} (photo: ${driver.photo ? 'yes' : 'no'})`);
        } catch (error) {
          console.error("Error fetching driver details:", error);
          socket.emit("error", { message: "Error fetching driver details" });
        }
      });

      socket.on("searchrider", async (rideId) => {
        try {
          const ride = await Ride.findById(rideId).populate("customer rider");
          if (!ride) return socket.emit("error", { message: "Ride not found" });

          const { latitude: pickupLat, longitude: pickupLon } = ride.pickup;

          let retries = 0;
          let rideAccepted = false;
          let canceled = false;
          const MAX_RETRIES = 60; // Increased from 20 to 60 (10 minutes instead of 3.3 minutes)

          const retrySearch = async () => {
            if (canceled) return;
            
            // CRITICAL: Check ride status in database before every retry
            const currentRide = await Ride.findById(rideId);
            
            // If ride doesn't exist or has been accepted/completed, stop the interval
            if (!currentRide) {
              console.log(`🔒 Ride ${rideId} no longer exists - stopping retry interval`);
              clearInterval(retryInterval);
              return;
            }
            
            // If ride status is anything other than SEARCHING_FOR_RIDER, stop the interval
            if (currentRide.status !== "SEARCHING_FOR_RIDER") {
              console.log(`🔒 Ride ${rideId} status is ${currentRide.status} (not SEARCHING) - stopping retry interval`);
              clearInterval(retryInterval);
              rideAccepted = true; // Mark as accepted to prevent timeout
              return;
            }
            
            retries++;
            console.log(`🔄 Retry ${retries}/${MAX_RETRIES} for ride ${rideId}`);

            const riders = sendNearbyRiders(socket, { latitude: pickupLat, longitude: pickupLon }, ride);
            if (riders.length > 0 || retries >= MAX_RETRIES) {
              clearInterval(retryInterval);
              if (!rideAccepted && retries >= MAX_RETRIES) {
                // Double-check ride status before timing out
                const finalCheck = await Ride.findById(rideId);
                if (!finalCheck || finalCheck.status !== "SEARCHING_FOR_RIDER") {
                  console.log(`🔒 Ride ${rideId} was accepted during final check - NOT timing out`);
                  return;
                }
                // ✅ FIXED: Update status to TIMEOUT instead of deleting, but ONLY if still SEARCHING
                const timeoutRide = await Ride.findById(rideId);
                if (timeoutRide) {
                  // CRITICAL: Only timeout if ride is still SEARCHING_FOR_RIDER
                  if (timeoutRide.status !== "SEARCHING_FOR_RIDER") {
                    console.log(`🔒 Ride ${rideId} status is ${timeoutRide.status} - NOT timing out (ride was accepted/completed)`);
                  } else {
                    // Ride is still searching after max retries - mark as TIMEOUT
                    timeoutRide.status = "TIMEOUT";
                    await timeoutRide.save();
                    console.log(`🕐 Ride ${rideId} timed out after ${MAX_RETRIES} retries - status updated to TIMEOUT`);
                    
                    // Broadcast ride timeout to all on-duty riders
                    io.to("onDuty").emit("rideOfferTimeout", rideId);
                    
                    // Also emit rideCanceled to ensure removal from all lists
                    io.to("onDuty").emit("rideCanceled", { 
                      ride: timeoutRide,
                      rideId: rideId,
                      cancelledBy: "system",
                      cancellerName: "System (Timeout)"
                    });
                  }
                }
                
                socket.emit("error", { message: "No riders found within 5 minutes." });
              }
            }
          };

          const retryInterval = setInterval(retrySearch, 10000);

          socket.on("rideAccepted", () => {
            rideAccepted = true;
            clearInterval(retryInterval);
          });
          
          // Add listener for ride completion to prevent any status changes after completion
          socket.on("rideCompleted", () => {
            console.log(`🔒 Ride ${rideId} completed - ensuring no further status changes`);
            rideAccepted = true;
            clearInterval(retryInterval);
          });

          socket.on("cancelRide", async (data) => {
            canceled = true;
            clearInterval(retryInterval);
            
            // Extract reason from data (can be object with rideId and reason, or just rideId)
            const reason = typeof data === 'object' ? data.reason : null;
            
            // ✅ FIXED: Update status to CANCELLED instead of deleting, but protect COMPLETED rides
            const cancelRide = await Ride.findById(rideId)
              .populate("customer", "firstName lastName phone")
              .populate("rider", "firstName lastName phone photo");
            
            if (cancelRide) {
              // CRITICAL: Never change a COMPLETED ride's status
              if (cancelRide.status === "COMPLETED") {
                console.log(`🔒 Ride ${rideId} is COMPLETED - protected from status change to CANCELLED`);
              } else {
                const cancellerName = `${cancelRide.customer.firstName} ${cancelRide.customer.lastName}`;
                
                cancelRide.status = "CANCELLED";
                cancelRide.cancelledBy = "customer";
                cancelRide.cancelledByName = cancellerName;
                cancelRide.cancelledAt = new Date();
                
                // Save cancellation reason if provided
                if (reason) {
                  cancelRide.cancellationReason = reason;
                  console.log(`📝 Cancellation reason saved: "${reason}" by customer`);
                }
                
                await cancelRide.save();
                console.log(`🚫 Customer ${user.id} canceled ride ${rideId} - status updated to CANCELLED (NOT DELETED)`);
                
                // Broadcast to ride room with cancellation details
                io.to(`ride_${rideId}`).emit("rideCanceled", { 
                  message: "Ride has been cancelled",
                  ride: cancelRide,
                  cancelledBy: "customer",
                  cancellerName: cancellerName
                });
                
                // If rider was assigned, send alert
                if (cancelRide.rider) {
                  const riderSocket = getRiderSocket(cancelRide.rider._id);
                  if (riderSocket) {
                    console.log(`🚨 Sending cancellation alert to rider ${cancelRide.rider._id}`);
                    riderSocket.emit("passengerCancelledRide", {
                      rideId: rideId,
                      message: `${cancellerName} has cancelled the ride`,
                      passengerName: cancellerName,
                      ride: cancelRide
                    });
                  }
                }
                
                // Remove from ALL on-duty riders' screens immediately
                console.log(`🚫 Customer cancelled ride ${rideId} via socket - removing from ALL on-duty riders' screens`);
                io.to("onDuty").emit("rideOfferCanceled", rideId);
                console.log(`✅ Emitted rideOfferCanceled to onDuty room for ride ${rideId}`);
                
                // Also emit rideCanceled with full data for comprehensive handling
                io.to("onDuty").emit("rideCanceled", {
                  rideId: rideId,
                  ride: cancelRide,
                  cancelledBy: "customer",
                  cancellerName: cancellerName
                });
                console.log(`✅ Emitted rideCanceled to onDuty room for ride ${rideId}`);
                console.log(`📢 Successfully removed ride ${rideId} from all on-duty riders' screens`);
              }
            }
            
            socket.emit("rideCanceled", { message: "Ride canceled", ride: cancelRide });
          });
        } catch (error) {
          console.error("Error searching for rider:", error);
          socket.emit("error", { message: "Error searching for rider" });
        }
      });
    }

    socket.on("subscribeToriderLocation", (riderId) => {
      const rider = onDutyRiders.get(riderId);
      if (rider) {
        socket.join(`rider_${riderId}`);
        socket.emit("riderLocationUpdate", { riderId, coords: rider.coords });
        console.log(`User ${user.id} subscribed to rider ${riderId}'s location.`);
      }
    });

    socket.on("subscribeRide", async (rideId) => {
      console.log(`User ${user.id} (${user.role}) subscribing to ride ${rideId}`);
      socket.join(`ride_${rideId}`);
      try {
        const rideData = await Ride.findById(rideId).populate("customer rider");
        console.log(`Sending ride data to user ${user.id}: Status=${rideData?.status}, OTP=${rideData?.otp}`);
        socket.emit("rideData", rideData);
      } catch (error) {
        console.error(`Error fetching ride ${rideId}:`, error);
        socket.emit("error", { message: "Failed to receive ride data" });
      }
    });

    socket.on("leaveRide", (rideId) => {
      console.log(`🚪 User ${user.id} (${user.role}) leaving ride room ${rideId}`);
      socket.leave(`ride_${rideId}`);
      console.log(`✅ User ${user.id} successfully left ride room ${rideId}`);
    });

    // ============ CHAT SOCKET EVENTS ============
    
    // Join a chat room
    socket.on("joinChat", (chatId) => {
      console.log(`💬 User ${user.id} (${user.role}) joining chat room ${chatId}`);
      socket.join(`chat_${chatId}`);
      console.log(`✅ User ${user.id} joined chat room ${chatId}`);
    });

    // Leave a chat room
    socket.on("leaveChat", (chatId) => {
      console.log(`💬 User ${user.id} (${user.role}) leaving chat room ${chatId}`);
      socket.leave(`chat_${chatId}`);
      console.log(`✅ User ${user.id} left chat room ${chatId}`);
    });

    // Send a message in real-time
    socket.on("sendMessage", async (data) => {
      try {
        const { chatId, content } = data;
        console.log(`💬 User ${user.id} sending message in chat ${chatId}`);

        // Verify user is participant in this chat
        const chat = await Chat.findOne({
          _id: chatId,
          "participants.userId": user.id,
        });

        if (!chat) {
          socket.emit("error", { message: "Chat not found or access denied" });
          return;
        }

        // Create message
        const message = await Message.create({
          chatId,
          sender: {
            userId: user.id,
            role: user.role,
          },
          content: content.trim(),
          messageType: "text",
        });

        // Update chat's last message
        chat.lastMessage = message._id;
        chat.lastMessageTime = message.createdAt;

        // Increment unread count for the other participant
        const otherParticipantRole = user.role === "customer" ? "rider" : "customer";
        chat.unreadCount[otherParticipantRole] += 1;

        await chat.save();

        // Populate message
        const populatedMessage = await Message.findById(message._id).populate(
          "sender.userId",
          "firstName lastName photo"
        );

        // Broadcast message to all users in the chat room
        io.to(`chat_${chatId}`).emit("newMessage", populatedMessage);

        // Also send to both participants directly (fallback)
        for (const participant of chat.participants) {
          const participantSockets = await io.in(`user_${participant.userId}`).fetchSockets();
          participantSockets.forEach(sock => {
            sock.emit("newMessage", populatedMessage);
          });
        }

        // Send unread count update to the recipient (other participant)
        const otherParticipant = chat.participants.find(p => p.userId.toString() !== user.id);
        if (otherParticipant) {
          // Calculate total unread count for the recipient across all their chats
          const recipientChats = await Chat.find({
            "participants.userId": otherParticipant.userId,
          });
          
          const totalUnread = recipientChats.reduce((sum, c) => {
            return sum + (c.unreadCount[otherParticipant.role] || 0);
          }, 0);

          // Emit unread count update to recipient's personal room
          io.to(`user_${otherParticipant.userId}`).emit("unreadCountUpdate", {
            unreadCount: totalUnread,
            chatId: chatId,
          });
          
          console.log(`🔔 Sent unread count update to user ${otherParticipant.userId}: ${totalUnread} unread messages`);
        }

        console.log(`✅ Message sent in chat ${chatId}: ${message._id}`);
      } catch (error) {
        console.error(`❌ Error sending message:`, error);
        socket.emit("error", { message: "Failed to send message" });
      }
    });

    // Broadcast image message after upload (called from REST API)
    socket.on("broadcastImageMessage", async (data) => {
      try {
        const { messageId, chatId } = data;
        console.log(`📸 Broadcasting image message ${messageId} in chat ${chatId}`);

        // Get the populated message
        const populatedMessage = await Message.findById(messageId).populate(
          "sender.userId",
          "firstName lastName photo"
        );

        if (!populatedMessage) {
          console.error(`❌ Message ${messageId} not found`);
          return;
        }

        // Get chat for unread count update
        const chat = await Chat.findById(chatId);
        if (!chat) {
          console.error(`❌ Chat ${chatId} not found`);
          return;
        }

        // Broadcast message to all users in the chat room
        io.to(`chat_${chatId}`).emit("newMessage", populatedMessage);

        // Also send to both participants directly (fallback)
        for (const participant of chat.participants) {
          const participantSockets = await io.in(`user_${participant.userId}`).fetchSockets();
          participantSockets.forEach(sock => {
            sock.emit("newMessage", populatedMessage);
          });
        }

        // Send unread count update to the recipient (other participant)
        const senderId = populatedMessage.sender.userId._id.toString();
        const otherParticipant = chat.participants.find(p => p.userId.toString() !== senderId);
        
        if (otherParticipant) {
          // Calculate total unread count for the recipient across all their chats
          const recipientChats = await Chat.find({
            "participants.userId": otherParticipant.userId,
          });
          
          const totalUnread = recipientChats.reduce((sum, c) => {
            return sum + (c.unreadCount[otherParticipant.role] || 0);
          }, 0);

          // Emit unread count update to recipient's personal room
          io.to(`user_${otherParticipant.userId}`).emit("unreadCountUpdate", {
            unreadCount: totalUnread,
            chatId: chatId,
          });
          
          console.log(`🔔 Sent unread count update to user ${otherParticipant.userId}: ${totalUnread} unread messages`);
        }

        console.log(`✅ Image message broadcasted in chat ${chatId}`);
      } catch (error) {
        console.error(`❌ Error broadcasting image message:`, error);
      }
    });

    // User is typing indicator
    socket.on("typing", (data) => {
      const { chatId, isTyping } = data;
      console.log(`⌨️ User ${user.id} ${isTyping ? 'started' : 'stopped'} typing in chat ${chatId}`);
      
      // Broadcast to other users in the chat
      socket.to(`chat_${chatId}`).emit("userTyping", {
        userId: user.id,
        role: user.role,
        isTyping,
      });
    });

    // Mark messages as read in real-time
    socket.on("markAsRead", async (data) => {
      try {
        const { chatId } = data;
        console.log(`💬 User ${user.id} marking messages as read in chat ${chatId}`);

        const chat = await Chat.findOne({
          _id: chatId,
          "participants.userId": user.id,
        });

        if (!chat) {
          socket.emit("error", { message: "Chat not found" });
          return;
        }

        // Get unread messages
        const unreadMessages = await Message.find({
          chatId,
          "sender.userId": { $ne: user.id },
          "readBy.userId": { $ne: user.id },
          isDeleted: false,
        });

        // Mark messages as read
        for (const message of unreadMessages) {
          message.readBy.push({
            userId: user.id,
            readAt: new Date(),
          });
          await message.save();
        }

        // Reset unread count
        chat.unreadCount[user.role] = 0;
        await chat.save();

        // Notify other participants
        socket.to(`chat_${chatId}`).emit("messagesRead", {
          chatId,
          userId: user.id,
          count: unreadMessages.length,
        });

        // Calculate and send updated unread count to current user
        const userChats = await Chat.find({
          "participants.userId": user.id,
        });
        
        const totalUnread = userChats.reduce((sum, c) => {
          return sum + (c.unreadCount[user.role] || 0);
        }, 0);

        // Emit unread count update to current user's personal room
        io.to(`user_${user.id}`).emit("unreadCountUpdate", {
          unreadCount: totalUnread,
          chatId: chatId,
        });
        
        console.log(`🔔 Sent unread count update to user ${user.id}: ${totalUnread} unread messages`);
        console.log(`✅ Marked ${unreadMessages.length} messages as read in chat ${chatId}`);
      } catch (error) {
        console.error(`❌ Error marking messages as read:`, error);
        socket.emit("error", { message: "Failed to mark messages as read" });
      }
    });

    // Get online status
    socket.on("checkOnlineStatus", async (data) => {
      const { userId } = data;
      const userSockets = await io.in(`user_${userId}`).fetchSockets();
      const isOnline = userSockets.length > 0;
      
      socket.emit("onlineStatus", {
        userId,
        isOnline,
      });
    });

    // Join user's personal room for direct messaging
    socket.join(`user_${user.id}`);
    console.log(`👤 User ${user.id} joined personal room`);

    // Fetch messages for a chat via socket
    socket.on("fetchMessages", async (data) => {
      try {
        const { chatId, page = 1, limit = 50 } = data;
        console.log(`💬 Socket: Fetching messages for chat ${chatId}, page ${page}`);

        // Verify user is participant in this chat
        const chat = await Chat.findOne({
          _id: chatId,
          "participants.userId": user.id,
        });

        if (!chat) {
          socket.emit("messagesError", { message: "Chat not found or you don't have access" });
          return;
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const messages = await Message.find({
          chatId,
          isDeleted: false,
        })
          .populate("sender.userId", "firstName lastName photo")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit));

        const totalMessages = await Message.countDocuments({
          chatId,
          isDeleted: false,
        });

        console.log(`✅ Socket: Found ${messages.length} messages (total: ${totalMessages})`);

        socket.emit("messagesFetched", {
          messages: messages.reverse(), // Reverse to show oldest first
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: totalMessages,
            hasMore: skip + messages.length < totalMessages,
          },
        });
      } catch (error) {
        console.error(`❌ Socket: Error fetching messages:`, error);
        socket.emit("messagesError", { message: "Failed to fetch messages", error: error.message });
      }
    });

    // Mark messages as read via socket
    socket.on("markMessagesRead", async (data) => {
      try {
        const { chatId } = data;
        console.log(`💬 Socket: User ${user.id} marking messages as read in chat ${chatId}`);

        const chat = await Chat.findOne({
          _id: chatId,
          "participants.userId": user.id,
        });

        if (!chat) {
          socket.emit("markReadError", { message: "Chat not found" });
          return;
        }

        // Get unread messages
        const unreadMessages = await Message.find({
          chatId,
          "sender.userId": { $ne: user.id },
          "readBy.userId": { $ne: user.id },
          isDeleted: false,
        });

        // Mark messages as read
        for (const message of unreadMessages) {
          message.readBy.push({
            userId: user.id,
            readAt: new Date(),
          });
          await message.save();
        }

        // Reset unread count
        chat.unreadCount[user.role] = 0;
        await chat.save();

        // Notify other participants
        socket.to(`chat_${chatId}`).emit("messagesRead", {
          chatId,
          userId: user.id,
          count: unreadMessages.length,
        });

        socket.emit("markReadSuccess", {
          chatId,
          count: unreadMessages.length,
        });

        // Calculate and send updated unread count to current user
        const userChats = await Chat.find({
          "participants.userId": user.id,
        });
        
        const totalUnread = userChats.reduce((sum, c) => {
          return sum + (c.unreadCount[user.role] || 0);
        }, 0);

        // Emit unread count update to current user's personal room
        io.to(`user_${user.id}`).emit("unreadCountUpdate", {
          unreadCount: totalUnread,
          chatId: chatId,
        });
        
        console.log(`🔔 Socket: Sent unread count update to user ${user.id}: ${totalUnread} unread messages`);
        console.log(`✅ Socket: Marked ${unreadMessages.length} messages as read in chat ${chatId}`);
      } catch (error) {
        console.error(`❌ Socket: Error marking messages as read:`, error);
        socket.emit("markReadError", { message: "Failed to mark messages as read", error: error.message });
      }
    });

    // Get or create chat via socket
    socket.on("getOrCreateChat", async (data) => {
      try {
        const { otherUserId, otherUserRole } = data;
        const currentUserId = user.id;
        const currentUserRole = user.role;

        console.log(`💬 Socket: Getting/Creating chat between ${currentUserId} (${currentUserRole}) and ${otherUserId} (${otherUserRole})`);

        // Validate that user is not trying to chat with themselves
        if (currentUserId === otherUserId) {
          console.log(`❌ Socket: User trying to chat with themselves`);
          socket.emit("chatError", { message: "Cannot create chat with yourself" });
          return;
        }

        // Check if chat already exists
        let chat = await Chat.findOne({
          "participants.userId": { $all: [currentUserId, otherUserId] },
        })
          .populate("participants.userId", "firstName lastName photo role vehicleType")
          .populate({
            path: "lastMessage",
            select: "content createdAt sender",
          });

        if (chat) {
          console.log(`✅ Socket: Found existing chat: ${chat._id}`);
          console.log(`📋 Socket: Chat participants:`, chat.participants.map(p => ({
            userId: p.userId?._id,
            name: `${p.userId?.firstName} ${p.userId?.lastName}`,
            role: p.role
          })));
          socket.emit("chatCreated", { chat });
          return;
        }

        // Create new chat
        console.log(`🆕 Socket: Creating new chat with participants:`, [
          { userId: currentUserId, role: currentUserRole },
          { userId: otherUserId, role: otherUserRole }
        ]);
        
        chat = await Chat.create({
          participants: [
            { userId: currentUserId, role: currentUserRole },
            { userId: otherUserId, role: otherUserRole },
          ],
        });

        console.log(`💾 Socket: Chat created in DB with ID: ${chat._id}`);

        // Verify chat was saved by querying it back
        const verifyChat = await Chat.findById(chat._id);
        console.log(`🔍 Socket: Verification - Chat exists in DB:`, !!verifyChat);
        console.log(`🔍 Socket: Verification - Participants:`, verifyChat?.participants);

        // Populate the newly created chat
        chat = await Chat.findById(chat._id)
          .populate("participants.userId", "firstName lastName photo role vehicleType")
          .populate("lastMessage");

        console.log(`✅ Socket: Created new chat: ${chat._id}`);
        console.log(`📋 Socket: New chat participants:`, chat.participants.map(p => ({
          userId: p.userId?._id,
          name: `${p.userId?.firstName} ${p.userId?.lastName}`,
          role: p.role
        })));
        
        // Verify both users can find this chat
        const currentUserChats = await Chat.find({ "participants.userId": currentUserId });
        const otherUserChats = await Chat.find({ "participants.userId": otherUserId });
        console.log(`🔍 Socket: Current user (${currentUserId}) has ${currentUserChats.length} chats`);
        console.log(`🔍 Socket: Other user (${otherUserId}) has ${otherUserChats.length} chats`);
        
        socket.emit("chatCreated", { chat });
      } catch (error) {
        console.error(`❌ Socket: Error creating chat:`, error);
        console.error(`❌ Socket: Error stack:`, error.stack);
        socket.emit("chatError", { message: "Failed to create chat", error: error.message });
      }
    });

    // ============ END CHAT SOCKET EVENTS ============

    // ============ GLOBAL RIDE CANCELLATION (works for any ride status) ============
    socket.on("customerCancelRide", async (data) => {
      try {
        const { rideId, reason } = data;
        console.log(`🚫 Customer ${user.id} requesting to cancel ride ${rideId} with reason: "${reason}"`);
        
        if (!rideId) {
          socket.emit("cancelError", { message: "Ride ID is required" });
          return;
        }
        
        // Find the ride
        const ride = await Ride.findById(rideId)
          .populate("customer", "firstName lastName phone")
          .populate("rider", "firstName lastName phone photo");
        
        if (!ride) {
          console.log(`❌ Ride ${rideId} not found`);
          socket.emit("cancelError", { message: "Ride not found" });
          return;
        }
        
        // Verify the customer owns this ride
        if (ride.customer._id.toString() !== user.id) {
          console.log(`❌ Customer ${user.id} does not own ride ${rideId}`);
          socket.emit("cancelError", { message: "You can only cancel your own rides" });
          return;
        }
        
        // Check if ride can be cancelled (not already completed or cancelled)
        if (ride.status === "COMPLETED") {
          console.log(`🔒 Ride ${rideId} is COMPLETED - cannot cancel`);
          socket.emit("cancelError", { message: "Cannot cancel a completed ride" });
          return;
        }
        
        if (ride.status === "CANCELLED") {
          console.log(`🔒 Ride ${rideId} is already CANCELLED`);
          socket.emit("cancelError", { message: "Ride is already cancelled" });
          return;
        }
        
        // Get canceller name
        const cancellerName = `${ride.customer.firstName} ${ride.customer.lastName}`;
        
        // Update ride status to CANCELLED
        ride.status = "CANCELLED";
        ride.cancelledBy = "customer";
        ride.cancelledByName = cancellerName;
        ride.cancelledAt = new Date();
        
        if (reason) {
          ride.cancellationReason = reason;
          console.log(`📝 Cancellation reason saved: "${reason}" by customer`);
        }
        
        await ride.save();
        console.log(`✅ Ride ${rideId} cancelled by customer ${user.id}`);
        
        // Broadcast to ride room
        io.to(`ride_${rideId}`).emit("rideCanceled", {
          message: "Ride has been cancelled by passenger",
          ride: ride,
          cancelledBy: "customer",
          cancellerName: cancellerName
        });
        
        // If rider was assigned, send direct notification
        if (ride.rider) {
          const riderSocketId = onDutyRiders.get(ride.rider._id.toString())?.socketId;
          if (riderSocketId) {
            console.log(`🚨 Sending cancellation alert to rider ${ride.rider._id}`);
            io.to(riderSocketId).emit("passengerCancelledRide", {
              rideId: rideId,
              message: `${cancellerName} has cancelled the ride`,
              passengerName: cancellerName,
              reason: reason,
              ride: ride
            });
          }
          
          // Also emit to rider's personal room
          io.to(`user_${ride.rider._id}`).emit("passengerCancelledRide", {
            rideId: rideId,
            message: `${cancellerName} has cancelled the ride`,
            passengerName: cancellerName,
            reason: reason,
            ride: ride
          });
        }
        
        // Broadcast to all on-duty riders to remove from their lists
        io.to("onDuty").emit("rideCanceled", {
          rideId: rideId,
          ride: ride,
          cancelledBy: "customer",
          cancellerName: cancellerName
        });
        
        // Send success response to customer
        socket.emit("rideCanceled", { 
          message: "Ride cancelled successfully", 
          ride: ride,
          success: true
        });
        
        console.log(`✅ Ride ${rideId} cancellation complete - all parties notified`);
      } catch (error) {
        console.error(`❌ Error cancelling ride:`, error);
        socket.emit("cancelError", { message: "Failed to cancel ride", error: error.message });
      }
    });
    // ============ END GLOBAL RIDE CANCELLATION ============

    socket.on("disconnect", () => {
      console.log(`${user.role} ${user.id} disconnected (socket: ${socket.id}).`);
      
      if (user.role === "rider") {
        // RACE CONDITION FIX: Add a delay before removing rider from Map
        // This gives the socket a chance to reconnect (e.g., during brief network issues)
        // If the rider reconnects within 5 seconds, they won't be removed from the Map
        const disconnectDelay = 5000; // 5 seconds
        
        console.log(`⏳ Rider ${user.id} will be removed from onDutyRiders in ${disconnectDelay/1000}s if not reconnected`);
        
        setTimeout(() => {
          // Check if the rider has reconnected with a new socket
          const currentRiderData = onDutyRiders.get(user.id);
          
          if (currentRiderData && currentRiderData.socketId === socket.id) {
            // The rider hasn't reconnected (same socket ID), remove them
            onDutyRiders.delete(user.id);
            console.log(`🚫 Rider ${user.id} removed from onDutyRiders after disconnect timeout`);
            updateNearbyriders();
          } else if (currentRiderData) {
            // The rider has reconnected with a new socket, don't remove
            console.log(`✅ Rider ${user.id} reconnected with new socket ${currentRiderData.socketId} - keeping in onDutyRiders`);
          } else {
            // Rider was already removed (e.g., went off duty)
            console.log(`ℹ️ Rider ${user.id} was already removed from onDutyRiders`);
          }
        }, disconnectDelay);
      }
    });

    function updateNearbyriders() {
      io.sockets.sockets.forEach((socket) => {
        if (socket.user?.role === "customer") {
          const customerCoords = socket.user.coords;
          if (customerCoords) sendNearbyRiders(socket, customerCoords);
        }
      });
    }

    async function sendNearbyRiders(socket, location, ride = null) {
      try {
        console.log('🔍 Finding riders near location:', location);
        console.log('👥 Total on-duty riders:', onDutyRiders.size);
        
        // Validate customer location
        if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
          console.error('❌ Invalid customer location:', location);
          socket.emit("nearbyriders", []);
          return [];
        }
        
        // Log all on-duty riders for debugging
        console.log('📋 On-duty riders list:');
        for (const [riderId, rider] of onDutyRiders.entries()) {
          console.log(`  - Rider ${riderId}: coords=${JSON.stringify(rider.coords)}, vehicle=${rider.vehicleType}`);
        }
        
        const nearbyRidersArray = [];
        
        // Process each rider to get complete information
        for (const [riderId, rider] of onDutyRiders.entries()) {
          try {
            // Validate rider coordinates
            if (!rider.coords || 
                typeof rider.coords.latitude !== 'number' || 
                typeof rider.coords.longitude !== 'number' ||
                isNaN(rider.coords.latitude) ||
                isNaN(rider.coords.longitude)) {
              console.warn(`⚠️ Rider ${riderId} has invalid coordinates:`, rider.coords);
              continue; // Skip this rider
            }
            
            // Get rider's info from database
            const riderInfo = await User.findById(riderId).select("firstName lastName photo vehicleType plateNumber licenseId phone");
            
            // Calculate distance in meters
            const distance = geolib.getDistance(
              { latitude: location.latitude, longitude: location.longitude },
              { latitude: rider.coords.latitude, longitude: rider.coords.longitude }
            );
            
            console.log(`📏 Distance calculation: Customer(${location.latitude}, ${location.longitude}) -> Rider(${rider.coords.latitude}, ${rider.coords.longitude}) = ${distance}m`);
            
            // Get rider's ratings
            const ratings = await Rating.find({ rider: riderId });
            const totalRatings = ratings.length;
            const averageRating = totalRatings > 0 
              ? ratings.reduce((sum, r) => sum + r.rating, 0) / totalRatings 
              : 0;
            
            const riderData = {
              riderId: rider.riderId,
              coords: rider.coords,
              vehicleType: rider.vehicleType || riderInfo?.vehicleType || "Tricycle",
              name: rider.name || `${riderInfo?.firstName || ''} ${riderInfo?.lastName || ''}`.trim() || `Rider ${riderId.substring(0, 6)}`,
              firstName: riderInfo?.firstName || "",
              lastName: riderInfo?.lastName || "",
              photo: riderInfo?.photo || null,
              phone: riderInfo?.phone || null,
              plateNumber: riderInfo?.plateNumber || null,
              licenseId: riderInfo?.licenseId || null,
              distance: distance,
              averageRating: parseFloat(averageRating.toFixed(1)),
              totalRatings: totalRatings,
              heading: rider.coords.heading || 0,
              socketId: rider.socketId
            };
            
            console.log(`📍 Added rider ${riderId} (${riderInfo?.firstName || 'unknown'}) at ${distance.toFixed(0)}m`);
            nearbyRidersArray.push(riderData);
          } catch (error) {
            console.error(`❌ Error processing rider ${riderId}:`, error);
          }
        }
        
        // Get dynamic distance radius from database
        const maxDistanceRadius = await getDistanceRadiusInMeters();
        
        console.log(`📏 Max distance radius: ${maxDistanceRadius}m (${maxDistanceRadius/1000}km)`);
        console.log(`📊 Total riders before filter: ${nearbyRidersArray.length}`);
        
        // Log each rider's distance vs max radius
        nearbyRidersArray.forEach(rider => {
          const withinRadius = rider.distance <= maxDistanceRadius;
          console.log(`  - ${rider.firstName || rider.riderId}: ${rider.distance}m ${withinRadius ? '✅ WITHIN' : '❌ OUTSIDE'} radius`);
        });
        
        // Sort by distance and filter by dynamic radius
        const nearbyriders = nearbyRidersArray
          .filter(rider => rider.distance <= maxDistanceRadius)
          .sort((a, b) => a.distance - b.distance);
        
        console.log(`📤 Sending ${nearbyriders.length} nearby riders to customer (within ${maxDistanceRadius/1000}km radius)`);
        socket.emit("nearbyriders", nearbyriders);
        
        // If this was triggered by a new ride, notify the riders
        if (ride) {
          nearbyriders.forEach((rider) => {
            if (rider.socketId) {
              io.to(rider.socketId).emit("rideOffer", ride);
            }
          });
        }

        return nearbyriders;
      } catch (error) {
        console.error("Error sending nearby riders:", error);
        return [];
      }
    }

    function getRiderSocket(riderId) {
      const rider = onDutyRiders.get(riderId);
      return rider ? io.sockets.sockets.get(rider.socketId) : null;
    }
  });
};

// Function to broadcast new ride requests to ALL on-duty riders (client will handle visual feedback for mismatched rides)
export const broadcastNewRideRequest = async (io, rideData) => {
  try {
    console.log(`🚨 Broadcasting new ride request ${rideData._id} to ALL on-duty riders`);
    
    // Populate the ride data with customer info
    const populatedRide = await Ride.findById(rideData._id).populate("customer", "firstName lastName phone");
    
    if (!populatedRide) {
      console.error(`❌ Cannot broadcast ride ${rideData._id}: Ride not found or was deleted`);
      return;
    }
    
    // Log ride details
    console.log(`📍 Ride details: ${populatedRide.pickup?.address} to ${populatedRide.drop?.address}`);
    console.log(`💰 Fare: ${populatedRide.fare}, Vehicle: ${populatedRide.vehicle}`);
    console.log(`📱 Customer: ${populatedRide.customer?.firstName} ${populatedRide.customer?.lastName}`);
    
    // Check if ride has blacklisted riders
    const blacklistedRiderIds = populatedRide.blacklistedRiders || [];
    console.log(`🚫 Blacklisted riders for this ride: ${blacklistedRiderIds.length > 0 ? blacklistedRiderIds.join(', ') : 'None'}`);
    
    // Send to each on-duty rider individually, excluding blacklisted ones
    let sentCount = 0;
    for (const [riderId, riderData] of onDutyRiders.entries()) {
      // Skip if rider is blacklisted for this ride
      if (blacklistedRiderIds.some(id => id.toString() === riderId)) {
        console.log(`⏭️ Skipping rider ${riderId} - blacklisted for this ride`);
        continue;
      }
      
      // Send to this specific rider
      const riderSocket = io.sockets.sockets.get(riderData.socketId);
      if (riderSocket) {
        riderSocket.emit("newRideRequest", populatedRide);
        sentCount++;
      }
    }
    
    console.log(`💬 Broadcasted ride ${rideData._id} (${populatedRide.vehicle}) to ${sentCount}/${onDutyRiders.size} on-duty riders (${blacklistedRiderIds.length} blacklisted)`);
    
    // Send updated list of ALL searching rides to each rider (filtered by their blacklist)
    for (const [riderId, riderData] of onDutyRiders.entries()) {
      const riderSocket = io.sockets.sockets.get(riderData.socketId);
      if (riderSocket) {
        // Get rides excluding those where this rider is blacklisted
        const ridesForRider = await Ride.find({ 
          status: "SEARCHING_FOR_RIDER",
          blacklistedRiders: { $ne: riderId }
        }).populate("customer", "firstName lastName phone");
        
        riderSocket.emit("allSearchingRides", ridesForRider);
      }
    }
    
    // Log all on-duty rider IDs
    if (onDutyRiders.size > 0) {
      const riderIds = Array.from(onDutyRiders.keys());
      console.log(`👥 On-duty riders: ${riderIds.join(', ')}`);
    }
  } catch (error) {
    console.error(`❌ Error broadcasting new ride request ${rideData?._id}:`, error);
  }
};

// Function to broadcast ride cancellations
export const broadcastRideCancellation = (io, rideId, reason = "canceled") => {
  console.log(`Broadcasting ride ${reason}: ${rideId}`);
  
  if (reason === "timeout") {
    io.to("onDuty").emit("rideOfferTimeout", rideId);
  } else {
    io.to("onDuty").emit("rideOfferCanceled", rideId);
  }
};

// Function to broadcast ride acceptance
export const broadcastRideAccepted = (io, rideId) => {
  console.log(`Broadcasting ride accepted: ${rideId}`);
  io.to("onDuty").emit("rideAccepted", rideId);
};

// Export getDistanceRadiusInMeters for use in ride controller (distance validation)
export { getDistanceRadiusInMeters };

// Export onDutyRiders map for distance validation in ride acceptance
export const getOnDutyRiders = () => onDutyRiders;

export default handleSocketConnection;
