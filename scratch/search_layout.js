const fs = require('fs');
const path = require('path');

const layoutPath = path.join(__dirname, '../../frontend/src/components/Layout.jsx');
const content = fs.readFileSync(layoutPath, 'utf8');
const lines = content.split('\n');

console.log('Searching for dashboard or path references...');
lines.forEach((line, index) => {
  if (line.toLowerCase().includes('gamification') || line.toLowerCase().includes('task tracker') || line.toLowerCase().includes('student directory')) {
    console.log(`${index + 1}: ${line.trim()}`);
  }
});
