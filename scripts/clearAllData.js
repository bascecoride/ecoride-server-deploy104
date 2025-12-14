import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';

const clearAllData = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // Get all collections
    const collections = await mongoose.connection.db.collections();
    
    console.log(`\n📋 Found ${collections.length} collections:\n`);

    // Clear each collection
    for (let collection of collections) {
      const count = await collection.countDocuments();
      await collection.deleteMany({});
      console.log(`   🗑️  Cleared "${collection.collectionName}" (${count} documents deleted)`);
    }

    console.log('\n✅ All data cleared successfully!');
    console.log('📁 Collections preserved (empty but still exist)\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error clearing data:', error.message);
    process.exit(1);
  }
};

clearAllData();
