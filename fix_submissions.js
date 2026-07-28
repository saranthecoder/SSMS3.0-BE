const mongoose = require('mongoose');
require('dotenv').config({path: './.env'});
const Submission = require('./models/Submission');
const Grade = require('./models/Grade');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to DB");

  const submissions = await Submission.find({ status: { $ne: 'graded' } });
  console.log(`Checking ${submissions.length} ungraded/pending submissions...`);

  let fixCount = 0;
  for (const sub of submissions) {
    const grade = await Grade.findOne({ submissionId: sub._id });
    if (grade) {
      console.log(`Fixing Submission: ${sub._id} (${sub.status} -> graded) for task: ${sub.taskId}`);
      sub.status = 'graded';
      await sub.save();
      fixCount++;
    }
  }

  console.log(`Successfully fixed ${fixCount} submissions.`);
  mongoose.disconnect();
}
run();
