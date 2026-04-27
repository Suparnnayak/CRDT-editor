const mongoose = require('mongoose');

const MONGO_URI = 'mongodb://127.0.0.1:27017/crdt_editor';

(async () => {
  try {
    await mongoose.connect(MONGO_URI);
    const dbName = mongoose.connection.name;
    await mongoose.connection.dropDatabase();
    console.log(`Dropped database: ${dbName}`);
  } catch (err) {
    console.error('Failed to drop database:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
