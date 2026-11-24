const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    // If connection already established or in progress, reuse existing connection
    if (mongoose.connection.readyState === 1) {
      return mongoose.connection;
    }

    if (!process.env.MONGODB_URI) {
      console.warn("WARNING: MONGODB_URI environment variable is not defined!");
    }
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lms';
    const conn = await mongoose.connect(uri, {
      maxPoolSize: process.env.MONGO_MAX_POOL_SIZE ? parseInt(process.env.MONGO_MAX_POOL_SIZE) : 35,
      minPoolSize: 1, // Keep 1 warm connection to avoid socket exhaustion across multiple instances
      maxIdleTimeMS: 30000, // Reclaim idle pool sockets after 30 seconds
      socketTimeoutMS: 45000,
      connectTimeoutMS: 20000,
      serverSelectionTimeoutMS: 15000
    });
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    return conn.connection;
  } catch (error) {
    console.error(`Error connecting to MongoDB: ${error.message}`);
    setTimeout(connectDB, 5000);
  }
};

module.exports = connectDB;
