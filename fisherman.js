const net = require('net');
const readline = require('readline');
const {
    parseInventoryResponse,
    parseMarketResponse,
    decidePurchases,
    decidePoisonTargetAndType,
  } = require('./smart_market.js');
const {
    sleep,
    getRandomMs
} = require('./helpers.js')

// Constants
const HOST = 'game.bloque.app';
const PORT = 2812;
const FISH_COMMAND = '/fish\n';
const INVENTORY_COMMAND = '/inventory\n';
const MARKET_COMMAND = '/market\n';
const SELL_ALL_COMMAND = '/sell all\n';
const INVITATION_CODE = 'BLQ-SNF0CINS';
const LONG_WAIT_MIN_SECONDS = 31;
const LONG_WAIT_MAX_SECONDS = 45;

const FISH_DELAY_MS = 1000;
const STATUS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INVENTORY_TRIGGER_COUNT = 10;
const MARKET_TRIGGER_COUNT = 30;

let client;
let isConnected = false;
let firstConnection = true;
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
        // startFishingLoop();
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
        // await decidePoisonTargetAndType(client);
    }
  
    // Inventory handler
    if (buffer.includes('Inventory for deltadax')) {
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

        if (totalFishCommandsSent % MARKET_TRIGGER_COUNT === 0) {
            triggerMarketProcessing();
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

// Trigger market logic
function triggerMarketProcessing() {
    if(isConnected){
        console.log('Checking market');
        client.write(MARKET_COMMAND);
    }
}

// Inventory trigger logic
function triggerInventoryProcessing() {
  if (isConnected) {
    console.log('📦 Checking inventory...');
    buffer = '';
    client.write(INVENTORY_COMMAND);
  }
}

let inventoryHandling = false;

async function handleInventoryResponse(inventoryText) {
  if (inventoryHandling) {
    console.log('⏳ Inventory handling already in progress, skipping...');
    return;
  }
  inventoryHandling = true;

  parseInventoryResponse(inventoryText);
  const lines = inventoryText.split('\n');
  const fishToEat = [];  

  let inFishSection = false;
  for (const line of lines) {
    if (line.startsWith('Fish:')) {
      inFishSection = true;
      continue;
    }
    if (inFishSection) {
      if (line.startsWith('Items:')) {
        inFishSection = false;
        break;
      }
      const fishMatch = line.match(/^[^\w]*\s*(.*?)\s*\((.*?)\)\s*-\s*x(\d+)/u);      
      if (fishMatch) {
        const fishName = fishMatch[1].trim();
        const rarity = fishMatch[2].trim().toLowerCase();
        const quantity = parseInt(fishMatch[3], 10) || 1;        
        let baseName = fishName.split(' ')[0];
        if (baseName.endsWith("'s")) {
          baseName = baseName.slice(0, -2);
        }

        const fishObj = { name: baseName, quantity };

        if (rarity === 'legendary' || rarity === 'epic') {
            fishToEat.push(fishObj);
        }
      }
    }
  }

  async function eatFishList(fishList, rarityLabel) {
    if (fishList.length > 0) {
      console.log(`🍽️ Eating legendary and epic fish:`, fishList.map(f => `${f.name} x${f.quantity}`).join(', '));
      for (let i = 0; i < fishList.length; i++) {
        const fish = fishList[i];    
        const eatCommand = `/eat ${fish.name} ${fish.quantity}\n`;
        client.write(eatCommand);        
        await sleep(1000);        
      }
    } else {
      console.log(`🤷 No ${rarityLabel} fish found to eat.`);
    }
  }

  await eatFishList(fishToEat);  

  // Now use Enhanced Fishing Rod if available
  let inItemsSection = false;
  let usedFishingRod = false;
  for (const line of lines) {
    if (line.startsWith('Items:')) {
      inItemsSection = true;
      continue;
    }
    if (inItemsSection && !usedFishingRod) {
      const match = line.match(/^([a-f0-9\-]+):\s+(Enhanced Fishing Rod)/i);
      if (match) {
        const uuid = match[1];
        console.log(`🎣 Using Enhanced Fishing Rod with UUID: ${uuid}`);
        client.write(`/use ${uuid}\n`);
        await sleep(500);
        usedFishingRod = true; // Only use one rod
      }
    }
  }

  client.write(SELL_ALL_COMMAND)
  console.log('💰 Selling all remaining fish...');
  inventoryHandling = false;
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