const net = require('net');
const {
    sleep,
    getRandomMs
} = require('./helpers.js')
const { 
    HOST,
    PORT,
    FISH_COMMAND,    
    INVITATION_CODE,
    LONG_WAIT_MAX_SECONDS,
    LONG_WAIT_MIN_SECONDS,
    FISH_DELAY_MS,
    STATUS_INTERVAL_MS,    
} = require('./constants.js')

let client;
let isConnected = false;
let fishingActive = false;
let totalFishCommandsSent = 0;
let buffer = '';
let statusInterval;
let cooldownMs = 30000; // Default 30 seconds

// Main connection
async function connect() {
  client = new net.Socket();

  client.connect(PORT, HOST, () => {    
    isConnected = true;
    console.log('✅ Connected to the resistance');    
  });

  client.on('data', async (data) => {
    const text = data.toString();    
    console.log('📩 Response:', text.trim());
    buffer += text;        
  
    // Auto respond to invite code prompt
    if (text.includes('Enter your Operative ID (invite code):')) {
      console.log('🔑 Invite code prompt detected. Sending code...');
      client.write(`${INVITATION_CODE}\n`);
  
      if (!fishingActive) {
        console.log('♻️ Resuming fishing loop...');
        startFishingLoop();
      }
  
      return; // skip further processing for this message
    }

    if (text.includes('Press any key now to skip animations')){        
        client.write('s'); // so it removes the animation
    }

    const cooldownMatch = text.match(/(?:Please wait|Cooldown activated)[^\d]*(\d+)\s?(second|minute|seconds|minutes)/i);
    if (cooldownMatch) {
        const amount = parseInt(cooldownMatch[1], 10);
        const unit = cooldownMatch[2].toLowerCase();
        if (unit.startsWith('second')) {
            cooldownMs = amount * 1000;
        } else if (unit.startsWith('minute')) {
            cooldownMs = amount * 60 * 1000;
        }
        console.log(`⏳ Cooldown message received. Updated wait time to ${cooldownMs / 1000}s`);
    }
    
  });

  client.on('close', async () => {
    console.log('❌ Connection closed.');
    isConnected = false;
    fishingActive = false;
    clearInterval(statusInterval);
    await handleReconnect();
  });

  client.on('error', async (err) => {
    console.error('⚠️ Connection error:', err.message);
    isConnected = false;
    fishingActive = false;
    clearInterval(statusInterval);
    await handleReconnect();
  });
}

// Fishing loop
async function startFishingLoop() {
  if (fishingActive) {
    console.log('⏳ Fishing already active...');
    return;
  }

  fishingActive = true;
  totalFishCommandsSent = 0;
  console.log('🎣 Starting fishing loop...');
  startStatusLog();

  while (isConnected && fishingActive) {
    try {
      for (let i = 0; i < 3; i++) {
        if (!fishingActive) break;
        client.write(FISH_COMMAND);
        totalFishCommandsSent++;
        console.log(`🎣 /fish executed (${i + 1}/3) — Total: ${totalFishCommandsSent}`);
        await sleep(FISH_DELAY_MS);        
      }

      const longWait = cooldownMs;
      console.log(`🕒 Waiting ${longWait / 1000}s before next batch...`);
      await sleep(longWait);

    } catch (err) {
      console.error('⚡ Error during fishing loop:', err.message);
      isConnected = false;
      fishingActive = false;
      clearInterval(statusInterval);
      await handleReconnect();
    }
  }

  console.log('🛑 Fishing loop stopped.');
  clearInterval(statusInterval);
}

// Reconnect handler
async function handleReconnect() {
  const waitMs = getRandomMs(LONG_WAIT_MIN_SECONDS, LONG_WAIT_MAX_SECONDS);
  console.log(`🔄 Reconnecting in ${waitMs / 1000}s...`);
  await sleep(waitMs);  
  connect();
}

// Status log
function startStatusLog() {
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(() => {
    console.log(`🧭 Still fishing... Total commands sent: ${totalFishCommandsSent}`);
  }, STATUS_INTERVAL_MS);
}

connect();