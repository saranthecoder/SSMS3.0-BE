const mongoose = require('mongoose');
const ShopItem = require('../models/ShopItem');

async function testCRUD() {
  const uri = 'mongodb+srv://saranthecodder:saransaran@cluster0.hz2ibvp.mongodb.net/lms';
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(uri);
    console.log('Connected!');

    // 1. Create
    console.log('Testing CREATE...');
    const newItem = await ShopItem.create({
      name: 'Test Dragon Pet',
      category: 'pet',
      rarity: 'Common',
      cost: 100,
      isPurchasable: true,
      achievementRequired: '',
      imageUrl: '',
      value: 'dragon-aura',
      description: 'Test description',
      isLimited: false,
      isActive: true,
      requiredLevel: 1,
      sortOrder: 0
    });
    console.log('CREATE Succeeded! Item ID:', newItem._id);

    // 2. Update
    console.log('Testing UPDATE...');
    newItem.name = 'Test Dragon Pet Updated';
    await newItem.save();
    console.log('UPDATE Succeeded!');

    // 3. Delete
    console.log('Testing DELETE...');
    await ShopItem.findByIdAndDelete(newItem._id);
    console.log('DELETE Succeeded!');

    console.log('All CRUD operations completed successfully on backend models!');
  } catch (error) {
    console.error('CRUD operation failed with error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected!');
  }
}

testCRUD();
