const BackendServer = require('../models/BackendServer');
const TrafficConfig = require('../models/TrafficConfig');

const seedTraffic = async () => {
  try {
    const port = process.env.PORT || 5020;
    const defaultUrl = `http://localhost:${port}`;

    const serverCount = await BackendServer.countDocuments();
    if (serverCount === 0) {
      await BackendServer.create({
        name: 'Primary Server (Default)',
        url: defaultUrl,
        isActive: true,
        status: 'online',
        isPrimary: true,
        responseTime: 0
      });
      console.log(`Seeded default primary backend server pointing to ${defaultUrl}`);
    }

    const configCount = await TrafficConfig.countDocuments();
    if (configCount === 0) {
      await TrafficConfig.create({
        policy: 'failover',
        manualSelectedServerId: null
      });
      console.log('Seeded default traffic routing config (Failover)');
    }
  } catch (err) {
    console.error('Error seeding traffic configuration:', err);
  }
};

module.exports = seedTraffic;
