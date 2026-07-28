const mongoose = require('mongoose');
require('dotenv').config({path: './.env'});
const User = require('./models/User');
const Submission = require('./models/Submission');
const Grade = require('./models/Grade');
const Task = require('./models/Task');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to DB");
  
  // Find Chethan B
  const chethan = await User.findOne({ name: /Chethan/i });
  if (!chethan) {
    console.log("Chethan B not found");
    mongoose.disconnect();
    return;
  }
  console.log(`Found User: ${chethan.name} (_id: ${chethan._id}, email: ${chethan.email})`);

  // Find submissions
  const submissions = await Submission.find({ studentId: chethan._id }).populate('taskId', 'title maxMarks');
  console.log(`\nSubmissions count: ${submissions.length}`);
  for (const s of submissions) {
    console.log(`- SubID: ${s._id}, Task: ${s.taskId?.title} (${s.taskId?._id}), Status: ${s.status}, Type: ${s.submissionType}, CreatedAt: ${s.createdAt}`);
    
    // Find grades for this submission
    const grade = await Grade.findOne({ submissionId: s._id });
    if (grade) {
      console.log(`  -> Grade: marksObtained: ${grade.marksObtained}, feedback: ${grade.feedback}, reviewedAt: ${grade.reviewedAt}`);
    } else {
      console.log(`  -> No Grade record found`);
    }
  }

  mongoose.disconnect();
}
run();
