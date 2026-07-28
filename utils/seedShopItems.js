// Run once: node utils/seedShopItems.js
// Seeds the ShopItem collection with default items

require('dotenv').config();
const mongoose = require('mongoose');
const ShopItem = require('../models/ShopItem');

const ITEMS = [
  // ============================================
  // COMMON AVATARS (20)
  // ============================================

  // ============================================
  // COMMON CARTOON AVATARS (20)
  // ============================================

  {
    name: 'Jerry Mouse',
    category: 'avatar',
    rarity: 'Common',
    cost: 0,
    value: '/avatars/jerry.png',
    description: 'The clever mouse who always outsmarts Tom.'
  },
  {
    name: 'Tom Cat',
    category: 'avatar',
    rarity: 'Common',
    cost: 1000,
    value: '/avatars/tom.png',
    description: 'The lovable cat from Tom & Jerry.'
  },
  {
    name: 'Shinchan',
    category: 'avatar',
    rarity: 'Common',
    cost: 2000,
    value: '/avatars/shinchan.png',
    description: 'The mischievous kid with endless funny adventures.'
  },
  {
    name: 'Doraemon',
    category: 'avatar',
    rarity: 'Common',
    cost: 3000,
    value: '/avatars/doraemon.png',
    description: 'The robotic cat from the future with amazing gadgets.'
  },
  {
    name: 'Nobita',
    category: 'avatar',
    rarity: 'Common',
    cost: 3500,
    value: '/avatars/nobita.png',
    description: 'A kind-hearted boy and Doraemon best friend.'
  },
  {
    name: 'Shizuka',
    category: 'avatar',
    rarity: 'Common',
    cost: 4000,
    value: '/avatars/shizuka.png',
    description: 'A caring and intelligent friend loved by everyone.'
  },
  {
    name: 'Gian',
    category: 'avatar',
    rarity: 'Common',
    cost: 4500,
    value: '/avatars/gian.png',
    description: 'The strong neighborhood bully with a good heart.'
  },
  {
    name: 'Suneo',
    category: 'avatar',
    rarity: 'Common',
    cost: 5000,
    value: '/avatars/suneo.png',
    description: 'The clever and wealthy friend of Nobita.'
  },
  {
    name: 'Pikachu',
    category: 'avatar',
    rarity: 'Common',
    cost: 6000,
    value: '/avatars/pikachu.png',
    description: 'The worlds most famous Electric Pokémon.'
  },
  {
    name: 'Ash Ketchum',
    category: 'avatar',
    rarity: 'Common',
    cost: 7000,
    value: '/avatars/ash.png',
    description: 'The determined Pokémon Trainer chasing his dream.'
  },
  {
    name: 'Ben Tennyson',
    category: 'avatar',
    rarity: 'Common',
    cost: 8000,
    value: '/avatars/ben10.png',
    description: 'Hero of the Omnitrix capable of transforming into aliens.'
  },
  {
    name: 'Gwen Tennyson',
    category: 'avatar',
    rarity: 'Common',
    cost: 9000,
    value: '/avatars/gwen.png',
    description: 'Ben powerful cousin and expert magician.'
  },
  {
    name: 'SpongeBob SquarePants',
    category: 'avatar',
    rarity: 'Common',
    cost: 13000,
    value: '/avatars/spongebob.png',
    description: 'The cheerful fry cook from Bikini Bottom.'
  },
  {
    name: 'Patrick Star',
    category: 'avatar',
    rarity: 'Common',
    cost: 14000,
    value: '/avatars/patrick.png',
    description: 'SpongeBob funny and lovable best friend.'
  },
  {
    name: 'Oggy',
    category: 'avatar',
    rarity: 'Common',
    cost: 15000,
    value: '/avatars/oggy.png',
    description: 'The blue cat always chased by three cockroaches.'
  },
  {
    name: 'Jack',
    category: 'avatar',
    rarity: 'Common',
    cost: 17000,
    value: '/avatars/jack.png',
    description: 'The green cat friend of oggy'
  },
  {
    name: 'Po',
    category: 'avatar',
    rarity: 'Common',
    cost: 20000,
    value: '/avatars/po.png',
    description: 'The Dragon Warrior and protector of the Valley of Peace.'
  },

  // ============================================
  // DEMON SLAYER AVATARS (10)
  // ============================================

  {
    name: 'Tanjiro Kamado',
    category: 'avatar',
    rarity: 'Rare',
    cost: 25000,
    value: '/avatars/tanjiro.png',
    description: 'A brave Demon Slayer determined to save his sister.'
  },
  {
    name: 'Nezuko Kamado',
    category: 'avatar',
    rarity: 'Rare',
    cost: 28000,
    value: '/avatars/nezuko.png',
    description: 'Tanjiro demon sister who protects humans.'
  },
  {
    name: 'Zenitsu Agatsuma',
    category: 'avatar',
    rarity: 'Rare',
    cost: 32000,
    value: '/avatars/zenitsu.png',
    description: 'A Thunder Breathing swordsman with hidden potential.'
  },
  {
    name: 'Inosuke Hashibira',
    category: 'avatar',
    rarity: 'Rare',
    cost: 36000,
    value: '/avatars/inosuke.png',
    description: 'The fearless Beast Breathing warrior.'
  },
  {
    name: 'Giyu Tomioka',
    category: 'avatar',
    rarity: 'Epic',
    cost: 42000,
    value: '/avatars/giyu.png',
    description: 'The calm and powerful Water Hashira.'
  },
  {
    name: 'Kyojuro Rengoku',
    category: 'avatar',
    rarity: 'Epic',
    cost: 50000,
    value: '/avatars/rengoku.png',
    description: 'The legendary Flame Hashira who inspired everyone.'
  },
  {
    name: 'Shinobu Kocho',
    category: 'avatar',
    rarity: 'Epic',
    cost: 58000,
    value: '/avatars/shinobu.png',
    description: 'The graceful Insect Hashira who fights with poison.'
  },
  {
    name: 'Yoriichi Tsugikuni',
    category: 'avatar',
    rarity: 'Legendary',
    cost: 100000,
    value: '/avatars/yoriichi.png',
    description: 'The greatest Demon Slayer and creator of Sun Breathing.'
  },

  // ─── Profile Borders ───
  { name: 'Bronze Border', category: 'border', rarity: 'Common', cost: 0, value: 'bronze-glow', description: 'A solid bronze border' },
  { name: 'Silver Border', category: 'border', rarity: 'Common', cost: 1700, value: 'silver-pulse', description: 'A glowing silver border' },
  { name: 'Gold Border', category: 'border', rarity: 'Rare', cost: 5500, value: 'gold-shimmer', description: 'A premium gold border' },
  { name: 'Diamond Border', category: 'border', rarity: 'Rare', cost: 8000, value: 'diamond-sparkle', description: 'Crystal blue border' },
  { name: 'Fire Border', category: 'border', rarity: 'Epic', cost: 9500, value: 'fire-ring', description: 'Pulsing fiery border' },
  { name: 'Galaxy Border', category: 'border', rarity: 'Epic', cost: 11000, value: 'galaxy-swirl', description: 'An elegant space swirl' },
  { name: 'Neon Border', category: 'border', rarity: 'Legendary', cost: 15000, value: 'lightning-arc', description: 'Supercharged neon border' },
  { name: 'Rainbow Spin Border', category: 'border', rarity: 'Legendary', cost: 17500, value: 'rainbow-spin', description: 'Stunning rotating gradient border' },
  { name: 'Emerald Pulse Border', category: 'border', rarity: 'Common', cost: 11500, value: 'emerald-pulse', description: 'Pulsing magic emerald glow' },
  { name: 'Ruby Fire Border', category: 'border', rarity: 'Rare', cost: 11800, value: 'ruby-fire', description: 'Flickering ruby fire flame aura' },
  { name: 'Nebula Cloud Border', category: 'border', rarity: 'Epic', cost: 14200, value: 'nebula-cloud', description: 'Swirling celestial space nebula' },
  { name: 'Frozen Frost Border', category: 'border', rarity: 'Rare', cost: 12500, value: 'frozen-frost', description: 'Chill your profile with a sub-zero icy crystal aura' },
  { name: 'Shadow Assassin Border', category: 'border', rarity: 'Epic', cost: 55000, value: 'shadow-assassin', description: 'For the silent master coders working in the dark' },

  // ─── Themes ───
  { name: 'Ocean Blue Theme', category: 'theme', rarity: 'Common', cost: 1500, value: 'Ocean', description: 'Deep ocean blue background' },
  { name: 'Slate Theme', category: 'theme', rarity: 'Common', cost: 1800, value: 'Slate', description: 'Professional slate gray layout' },
  { name: 'Mint Green Theme', category: 'theme', rarity: 'Common', cost: 5200, value: 'Mint', description: 'Calming mint green background' },
  { name: 'Midnight Theme', category: 'theme', rarity: 'Rare', cost: 6000, value: 'Midnight', description: 'Midnight dark mode background' },
  { name: 'Cyber Theme', category: 'theme', rarity: 'Rare', cost: 6500, value: 'Cyber', description: 'Futuristic cyan cyber layout' },
  { name: 'Emerald Green Theme', category: 'theme', rarity: 'Rare', cost: 7800, value: 'Emerald', description: 'Rich emerald green theme' },
  { name: 'Sakura Pink Theme', category: 'theme', rarity: 'Epic', cost: 8000, value: 'Sakura', description: 'Beautiful cherry blossom theme' },
  { name: 'Rose Red Theme', category: 'theme', rarity: 'Epic', cost: 9000, value: 'Rose', description: 'Vibrant crimson rose background' },
  { name: 'Crimson Theme', category: 'theme', rarity: 'Epic', cost: 11600, value: 'Crimson', description: 'Warm crimson theme' },
  { name: 'Coral Theme', category: 'theme', rarity: 'Epic', cost: 12200, value: 'Coral', description: 'Bright coral red theme' },

  // ─── Name Colors ───
  { name: 'Green Namecolor', category: 'namecolor', rarity: 'Common', cost: 0, value: 'text-green-500', description: 'Display your name in green' },
  { name: 'Blue Namecolor', category: 'namecolor', rarity: 'Common', cost: 250, value: 'text-blue-500', description: 'Display your name in blue' },
  { name: 'Purple Namecolor', category: 'namecolor', rarity: 'Rare', cost: 600, value: 'text-purple-500', description: 'Display your name in purple' },
  { name: 'Gold Namecolor', category: 'namecolor', rarity: 'Epic', cost: 1500, value: 'text-amber-500', description: 'Display your name in gold shimmer' },
  { name: 'Rainbow Namecolor', category: 'namecolor', rarity: 'Legendary', cost: 5000, value: 'text-transparent bg-clip-text bg-gradient-to-r from-red-500 via-green-500 to-blue-500 font-extrabold', description: 'Rainbow gradient name display' },
  { name: 'Deep Forest Namecolor', category: 'namecolor', rarity: 'Common', cost: 800, value: 'text-emerald-600 font-extrabold', description: 'Display your name in deep forest green' },
  { name: 'Crimson Flame Namecolor', category: 'namecolor', rarity: 'Rare', cost: 1200, value: 'text-red-500 font-bold animate-pulse', description: 'Pulsing crimson flame name display' },
  { name: 'Neon Electric Namecolor', category: 'namecolor', rarity: 'Epic', cost: 2500, value: 'text-cyan-400 font-black animate-pulse', description: 'Supercharged neon electric cyan name display' },

  // ─── Pets ───
  { name: 'Cat Pet', category: 'pet', rarity: 'Common', cost: 0, value: 'Cat', description: 'A cute companion cat' },
  { name: 'Dog Pet', category: 'pet', rarity: 'Common', cost: 900, value: 'Dog', description: 'Your loyal coding friend' },
  { name: 'Robot Pet', category: 'pet', rarity: 'Rare', cost: 1500, value: 'Robot', description: 'A floating mechanical helper' },
  { name: 'Dragon Pet', category: 'pet', rarity: 'Epic', cost: 4500, value: 'Dragon', description: 'A baby dragon to ignite your code' },
  { name: 'Panda Pet', category: 'pet', rarity: 'Rare', cost: 3500, value: 'Panda', description: 'A cute baby panda snacking on bamboo' },
  { name: 'Tiger Pet', category: 'pet', rarity: 'Epic', cost: 6000, value: 'Tiger', description: 'A small tiger cub that rawrs at bugs' },
  { name: 'Alien Pet', category: 'pet', rarity: 'Epic', cost: 5500, value: 'Alien', description: 'A little green alien friend floating in a saucer' },

  // ─── Animated Effects ───
  { name: 'Sparkles Effect', category: 'effect', rarity: 'Common', cost: 0, value: 'sparkles', description: 'Sparkling profile effect' },
  { name: 'Fire Effect', category: 'effect', rarity: 'Rare', cost: 1500, value: 'fire-aura', description: 'Fire aura profile effect' },
  { name: 'Lightning Effect', category: 'effect', rarity: 'Epic', cost: 3000, value: 'lightning-aura', description: 'Crackling lightning effect' },
  { name: 'Galaxy Effect', category: 'effect', rarity: 'Legendary', cost: 6000, value: 'galaxy-aura', description: 'Cosmic space halo effect' },
  { name: 'Snowstorm Effect', category: 'effect', rarity: 'Rare', cost: 2000, value: 'snowstorm', description: 'Winter theme snowflakes falling on your profile' },
  { name: 'Heartbeat Aura', category: 'effect', rarity: 'Epic', cost: 4000, value: 'heartbeat', description: 'Pulsing pink heart aura profile effect' },
  { name: 'Cyber Grid Aura', category: 'effect', rarity: 'Legendary', cost: 5500, value: 'cyber-grid', description: 'Green electronic digital grid scanning effect' },

  // ─── Titles ───
  { name: 'Problem Solver', category: 'title', rarity: 'Common', cost: 500, value: 'Problem Solver', description: 'Solver of algorithms' },
  { name: 'Bug Hunter', category: 'title', rarity: 'Common', cost: 800, value: 'Bug Hunter', description: 'Finder and killer of bugs' },
  { name: 'React Ninja', category: 'title', rarity: 'Rare', cost: 1200, value: 'React Ninja', description: 'React master' },
  { name: 'SQL King', category: 'title', rarity: 'Rare', cost: 1500, value: 'SQL King', description: 'SQL tables master' },
  { name: 'Java Wizard', category: 'title', rarity: 'Epic', cost: 2500, value: 'Java Wizard', description: 'Java design wizard' },
  { name: 'Legend', category: 'title', rarity: 'Legendary', cost: 6000, value: 'Legend', description: 'A placement ready legend' },
  { name: 'Pixel Artist', category: 'title', rarity: 'Common', cost: 600, value: 'Pixel Artist', description: 'Creator of digital block masterpieces' },
  { name: 'Code Optimizer', category: 'title', rarity: 'Rare', cost: 1100, value: 'Code Optimizer', description: 'Expert of runtime complexity' },
  { name: 'Data Scientist', category: 'title', rarity: 'Epic', cost: 2000, value: 'Data Scientist', description: 'Master of analytics and prediction' },
  { name: 'System Architect', category: 'title', rarity: 'Legendary', cost: 4000, value: 'System Architect', description: 'Designer of scalable systems' },

  // ─── Premium / Exclusive Achievement Items ───
  { name: 'Top 10 Border', category: 'border', rarity: 'Epic', cost: 0, isPurchasable: false, achievementRequired: 'Diamond League', value: 'top-10-border', description: 'Exclusive for Diamond League members' },
  { name: 'Perfect Attendance Aura', category: 'effect', rarity: 'Legendary', cost: 0, isPurchasable: false, achievementRequired: 'Attendance Sovereign', value: 'perfect-attendance-aura', description: 'Perfect 60-day attendance achievement' },
  { name: 'Mock Drive #1 Crown', category: 'avatar', rarity: 'Legendary', cost: 0, isPurchasable: false, achievementRequired: 'Century Coder', value: '/avatars/toper.png', description: 'Top ranking weekly mock drive crown' },
  { name: 'Quiz Master Title', category: 'title', rarity: 'Epic', cost: 0, isPurchasable: false, achievementRequired: 'Coding Legend', value: 'Quiz Master', description: '100% Quiz streak special reward' },
  { name: 'Placement Ready Frame', category: 'border', rarity: 'Legendary', cost: 0, isPurchasable: false, achievementRequired: 'Coding Master', value: 'placement-ready', description: 'Placement Ready animated frame' },

  { name: 'Weekly Warrior Shield', category: 'border', rarity: 'Rare', cost: 0, isPurchasable: false, achievementRequired: 'Weekly Warrior', value: 'weekly-warrior-shield', description: 'Exclusive shield frame for 7-day login streak champions' },
  { name: 'Legend League Crown Border', category: 'border', rarity: 'Legendary', cost: 0, isPurchasable: false, achievementRequired: 'Legend League', value: 'legend-league-crown', description: 'Exclusive royal border for reaching the Legend League' },

  { name: 'Legendary Gold Theme', category: 'theme', rarity: 'Legendary', cost: 0, isPurchasable: false, achievementRequired: 'Millionaire', value: 'Amber', description: 'Exclusive golden theme for coin hoarders' },
  { name: 'Master Purple Theme', category: 'theme', rarity: 'Epic', cost: 0, isPurchasable: false, achievementRequired: 'Coding Legend', value: 'Amethyst', description: 'Exclusive theme for 30-day streak programmers' },
  { name: 'Cosmic Diamond Theme', category: 'theme', rarity: 'Legendary', cost: 0, isPurchasable: false, achievementRequired: 'Legend League', value: 'Cyber', description: 'Stunning cosmic cyan diamond theme for reaching Legend League' },
  { name: 'Ruby Sovereign Theme', category: 'theme', rarity: 'Mythic', cost: 0, isPurchasable: false, achievementRequired: 'Coding Titan', value: 'Crimson', description: 'Deep red obsidian sovereign theme for solving 1000 problems' },
  { name: 'Forest Sovereign Theme', category: 'theme', rarity: 'Epic', cost: 0, isPurchasable: false, achievementRequired: 'Perfect Attendance', value: 'Mint', description: 'Pulsing green nature sovereign theme for 30-day attendance streaks' },

  { name: 'Star Coder Namecolor', category: 'namecolor', rarity: 'Legendary', cost: 0, isPurchasable: false, achievementRequired: 'Century Coder', value: 'text-yellow-400 font-black animate-bounce', description: 'Exclusive golden bouncy name for Century Coder achievers' },
  { name: 'Attendance Sovereign Namecolor', category: 'namecolor', rarity: 'Legendary', cost: 0, isPurchasable: false, achievementRequired: 'Attendance Sovereign', value: 'text-teal-400 font-extrabold animate-pulse', description: 'Exclusive glowing teal name for 60-day attendance heroes' },

  { name: 'Phoenix Pet', category: 'pet', rarity: 'Legendary', cost: 0, isPurchasable: false, achievementRequired: 'Legend League', value: 'Phoenix', description: 'The legendary phoenix bird to guide your path' },
  { name: 'Weekly Warrior Owl', category: 'pet', rarity: 'Rare', cost: 0, isPurchasable: false, achievementRequired: 'Weekly Warrior', value: 'Owl', description: 'A wise night owl pet helping you debug code' },

  { name: 'Legend League Crown Effect', category: 'effect', rarity: 'Legendary', cost: 0, isPurchasable: false, achievementRequired: 'Legend League', value: 'legend-crown-aura', description: 'A halo of sparkling legendary crowns' },
  { name: 'Weekly Warrior Flame', category: 'effect', rarity: 'Epic', cost: 0, isPurchasable: false, achievementRequired: 'Weekly Warrior', value: 'warrior-flame', description: 'A bright green flame surrounding your avatar' },

  { name: 'Weekly Warrior Title', category: 'title', rarity: 'Rare', cost: 0, isPurchasable: false, achievementRequired: 'Weekly Warrior', value: 'Weekly Warrior', description: 'Exclusive title for 7-day login streak champions' },
  { name: 'Attendance Sovereign Title', category: 'title', rarity: 'Legendary', cost: 0, isPurchasable: false, achievementRequired: 'Attendance Sovereign', value: 'Attendance Sovereign', description: 'Exclusive title for 60-day perfect attendance heroes' },
  { name: 'Coding Titan Title', category: 'title', rarity: 'Legendary', cost: 0, isPurchasable: false, achievementRequired: 'Coding Titan', value: 'Coding Titan', description: 'Exclusive title for 1000 solved problems champions' }
];

const seed = async () => {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/lms';
    await mongoose.connect(uri);
    console.log('Connected to MongoDB');

    // Wipe existing shop items first to re-seed clean
    await ShopItem.deleteMany({});
    console.log('Cleared existing shop items.');

    await ShopItem.insertMany(ITEMS);
    console.log(`✅ Seeded ${ITEMS.length} shop items successfully`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  }
};

seed();
