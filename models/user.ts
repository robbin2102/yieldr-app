import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  walletAddress: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    match: /^0x[a-fA-F0-9]{40}$/,
  },
  role: {
    type: String,
    required: true,
    enum: ['manager', 'investor'],
    default: 'manager',
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'suspended'],
    default: 'active',
  },
  username: {
    type: String,
    unique: true,
    sparse: true,
  },
  createdAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Update the updatedAt field before saving
UserSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.models.User || mongoose.model('User', UserSchema);
