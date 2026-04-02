import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error('MONGODB_URI environment variable is not defined');
}

// Separate cached connection for the agent-test database
// Uses same cluster as main app but targets yieldr_agent_test DB
declare global {
  // eslint-disable-next-line no-var
  var _agentTestConn: mongoose.Connection | null;
  // eslint-disable-next-line no-var
  var _agentTestPromise: Promise<mongoose.Connection> | null;
}

if (!global._agentTestConn) global._agentTestConn = null;
if (!global._agentTestPromise) global._agentTestPromise = null;

async function connectAgentDB(): Promise<mongoose.Connection> {
  if (global._agentTestConn && global._agentTestConn.readyState === 1) {
    return global._agentTestConn;
  }

  if (!global._agentTestPromise) {
    global._agentTestPromise = mongoose
      .createConnection(MONGODB_URI!, {
        dbName: 'yieldr_agent_test',
        bufferCommands: false,
      })
      .asPromise();
  }

  try {
    global._agentTestConn = await global._agentTestPromise;
  } catch (e) {
    global._agentTestPromise = null;
    throw e;
  }

  return global._agentTestConn;
}

export default connectAgentDB;
