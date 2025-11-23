import dotenv from 'dotenv';

// Load environment variables first, before any other imports
dotenv.config();

// Log environment variables for debugging (without revealing secrets)
console.log('Environment Variables Check:', {
  CLOUDINARY_API_NAME: process.env.CLOUDINARY_API_NAME ? 'Set' : 'Not set',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY ? 'Set' : 'Not set',
  CLOUDINARY_SECRET_KEY: process.env.CLOUDINARY_SECRET_KEY ? 'Set' : 'Not set',
});

import 'express-async-errors';
import EventEmitter from 'events';
import express from 'express';
import http from 'http';
import { Server as socketIo } from 'socket.io'; 
import connectDB from './config/connect.js';
import notFoundMiddleware from './middleware/not-found.js';
import errorHandlerMiddleware from './middleware/error-handler.js';
import authMiddleware from './middleware/authentication.js';

// Routers
import authRouter from './routes/auth.js';
import rideRouter from './routes/ride.js';
import ratingRouter from './routes/rating.js';
import adminRouter from './routes/admin.js';
import adminManagementRouter from './routes/adminManagement.js';
import analyticsRouter from './routes/analytics.js';
import chatRouter from './routes/chat.js';
import fareRateRouter from './routes/fareRate.js';
import termsRouter from './routes/termsAndConditions.js';

// Import socket handler
import handleSocketConnection from './controllers/sockets.js';

// Import scheduled jobs
import { initAutoApprovalJob } from './jobs/autoApprovalJob.js';

EventEmitter.defaultMaxListeners = 20;

const app = express();
app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Debug endpoint to check server status
app.get('/debug/status', async (req, res) => {
  const onDutyRidersCount = req.io.sockets.adapter.rooms.get('onDuty')?.size || 0;
  const connectedSockets = req.io.sockets.sockets.size;
  
  // Get all connected sockets
  const sockets = await req.io.fetchSockets();
  
  // Get socket details
  const socketDetails = sockets.map(socket => ({
    id: socket.id,
    userId: socket.user?.id,
    role: socket.user?.role,
    rooms: Array.from(socket.rooms),
    isOnDuty: socket.rooms.has('onDuty')
  }));
  
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    socketStats: {
      connectedSockets,
      onDutyRiders: onDutyRidersCount,
      sockets: socketDetails
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

// Debug endpoint to check socket rooms
app.get('/debug/rooms', (req, res) => {
  const rooms = req.io.sockets.adapter.rooms;
  const roomData = {};
  
  // Convert Map to object for JSON response
  for (const [roomName, roomSet] of rooms.entries()) {
    // Skip socket IDs (they're also in rooms)
    if (!roomName.includes('#')) {
      roomData[roomName] = {
        size: roomSet.size,
        sockets: Array.from(roomSet)
      };
    }
  }
  
  res.json({
    timestamp: new Date().toISOString(),
    rooms: roomData
  });
});

// Debug endpoint to check searching rides
app.get('/debug/rides', async (req, res) => {
  try {
    // Import Ride model
    const Ride = (await import('./models/Ride.js')).default;
    
    // Get all searching rides
    const searchingRides = await Ride.find({ status: 'SEARCHING_FOR_RIDER' })
      .populate('customer', 'firstName lastName phone');
    
    // Get all rides
    const allRides = await Ride.find({}).sort({ createdAt: -1 }).limit(10);
    
    res.json({
      timestamp: new Date().toISOString(),
      searchingRidesCount: searchingRides.length,
      searchingRides,
      recentRides: allRides.map(ride => ({
        id: ride._id,
        status: ride.status,
        createdAt: ride.createdAt,
        pickup: ride.pickup?.address,
        drop: ride.drop?.address
      }))
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

const server = http.createServer(app);

// Enhanced Socket.IO configuration for better reliability on Render
const io = new socketIo(server, { 
  cors: { origin: "*" },
  // Increase timeouts to handle Render's free tier spin-down
  pingTimeout: 60000, // 60 seconds (default is 20 seconds)
  pingInterval: 25000, // 25 seconds (default is 25 seconds)
  // Enable reconnection
  transports: ['websocket', 'polling'],
  // Increase max HTTP buffer size for large payloads
  maxHttpBufferSize: 1e8, // 100 MB
  // Allow more time for connections
  connectTimeout: 45000, // 45 seconds
});

// Attach the WebSocket instance to the request object
app.use((req, res, next) => {
  req.io = io;
  return next();
});

// Initialize the WebSocket handling logic
handleSocketConnection(io);

// Routes
app.use("/api/auth", authRouter);
app.use("/api/v1/ride", authMiddleware, rideRouter); // Add /api/v1 prefix for consistency
app.use("/ride", authMiddleware, rideRouter);        // Keep old route for backward compatibility
app.use("/rating", authMiddleware, ratingRouter);
app.use("/chat", authMiddleware, chatRouter);
app.use("/admin", adminRouter);
app.use("/api/admin-management", adminManagementRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/fare-rates", fareRateRouter);
app.use("/api/terms", termsRouter);

// Middleware
app.use(notFoundMiddleware);
app.use(errorHandlerMiddleware);

const start = async () => {
  try {
    await connectDB(process.env.MONGO_URI);
    
    // Initialize scheduled jobs after database connection
    console.log('🔧 Initializing scheduled jobs...');
    initAutoApprovalJob(60); // Run every 60 minutes
    
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, "0.0.0.0", () =>
      console.log(`HTTP server is running on port http://localhost:${PORT}`)
    );
  } catch (error) {
    console.log(error);
  }
};

start();
