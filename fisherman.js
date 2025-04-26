// Filename: fisher.js

const net = require('net');
const readline = require('readline');
const {
    parseInventoryResponse,
    parseMarketResponse,
    decidePurchases,
    decidePoisonTargetAndType,
  } = require('./smart_market.js');

// Constants
const HOST = 'game.bloque.app';
const PORT = 2812;
const FISH_COMMAND = '/fish\n';
const INVENTORY_COMMAND = '/inventory\n';
const SELL_COMMAND = '/sell all\n';
const INVITATION_CODE = 'BLQ-SNF0CINS';
const LONG_WAIT_MIN_SECONDS = 31;
const LONG_WAIT_MAX_SECONDS = 45;

const FISH_DELAY_MS = 1000;
const STATUS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INVENTORY_TRIGGER_COUNT = 30;

let client;
let isConnected = false;
let firstConnection = true;
let fishingActive = false;
let totalFishCommandsSent = 0;
let buffer = '';
let statusInterval;
let cooldownMs = 30000; // Default 30 seconds

// Helper functions
function getRandomMs(minSeconds, maxSeconds) {
  return Math.floor(Math.random() * ((maxSeconds - minSeconds + 1) * 1000)) + minSeconds * 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Main connection
async function connect() {
  client = new net.Socket();

  client.connect(PORT, HOST, () => {    
    isConnected = true;
    console.log('✅ Connected to the resistance');
    setupUserInput();
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

    if (firstConnection){
        firstConnection = false;
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
    
    if(text.includes('MARKET ITEMS')) {                
        parseMarketResponse(text);
        await decidePurchases(client);   
        await decidePoisonTargetAndType(client);
    }
  
    // Inventory handler
    if (buffer.includes('Fish:')) {
      await handleInventoryResponse(buffer);
      buffer = '';
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

        if (totalFishCommandsSent % INVENTORY_TRIGGER_COUNT === 0) {
          triggerInventoryProcessing();
        }
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

function stopFishingLoop() {
  if (!fishingActive) {
    console.log('🚫 Fishing loop is not active.');
    return;
  }
  fishingActive = false;
  console.log('🛑 Stopping fishing loop...');
}

// Inventory trigger logic
function triggerInventoryProcessing() {
  if (isConnected) {
    console.log('📦 Checking inventory...');
    buffer = '';
    client.write(INVENTORY_COMMAND);
  }
}

// Parses the inventory response and executes eat/sell
async function handleInventoryResponse(inventoryText) {
  parseInventoryResponse(inventoryText);
  const lines = inventoryText.split('\n');
  const legendaryFishNames = [];
  const epicFishNames = []    

  for (const line of lines) {
    if (line.includes('(legendary)')) {
      const match = line.match(/[\u{1F300}-\u{1FAFF}]?\s*(.*?)\s*\(legendary\)/u);
      if (match && match[1]) {
        legendaryFishNames.push(match[1].trim());
      }
    }
    if (line.includes('(epic)')) {
        const match = line.match(/[\u{1F300}-\u{1FAFF}]?\s*(.*?)\s*\(epic\)/u);
        if (match && match[1]) {
            epicFishNames.push(match[1].trim());
        }
      }
  }

  if (legendaryFishNames.length > 0) {
    console.log(`🍽️ Eating legendary fish: ${legendaryFishNames.join(', ')}`);
    for (const name of legendaryFishNames) {
      const eatCommand = `/eat ${name}\n`;
      client.write(eatCommand);
      await sleep(500);
    }
  } else {
    console.log('🤷 No legendary fish found to eat.');
  }

  if (epicFishNames.length > 0) {
    console.log(`🍽️ Eating epic fish: ${epicFishNames.join(', ')}`);
    for (const name of epicFishNames) {
      const eatCommand = `/eat ${name}\n`;
      client.write(eatCommand);
      await sleep(500);
    }
  } else {
    console.log('🤷 No epic fish found to eat.');
  }

  client.write(SELL_COMMAND);
  console.log('💰 Selling all remaining fish...');
  client.write('/market\n');    
}

// Reconnect handler
async function handleReconnect() {
  const waitMs = getRandomMs(LONG_WAIT_MIN_SECONDS, LONG_WAIT_MAX_SECONDS);
  console.log(`🔄 Reconnecting in ${waitMs / 1000}s...`);
  await sleep(waitMs);
  firstConnection = true;
  connect();
}

// Status log
function startStatusLog() {
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(() => {
    console.log(`🧭 Still fishing... Total commands sent: ${totalFishCommandsSent}`);
  }, STATUS_INTERVAL_MS);
}

// Terminal input
function setupUserInput() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('🛠️ Type commands: /fish, /stop, or anything else to send manually.');

  rl.on('line', (input) => {
    const command = input.trim();

    if (command === '/fish') {
      startFishingLoop();
    } else if (command === '/stop') {
      stopFishingLoop();
    } else {
      if (isConnected) {
        client.write(command + '\n');
        console.log(`➡️ Sent manual command: "${command}"`);
      } else {
        console.log('⚠️ Cannot send, not connected.');
      }
    }
  });
}

connect();