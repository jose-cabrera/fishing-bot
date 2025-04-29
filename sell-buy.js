const net = require('net');
const readline = require('readline');
const {
    parseInventoryResponse,
    parseMarketResponse,
    decideEat,
    decideSell,
  } = require('./smart_market.js');
const {
    sleep,
    getRandomMs
} = require('./helpers.js')
const { 
    HOST,
    PORT,    
    INVENTORY_COMMAND,    
    INVITATION_CODE,
    LONG_WAIT_MAX_SECONDS,
    LONG_WAIT_MIN_SECONDS,    
    INVENTORY_INTERVAL
} = require('./constants.js')
const {
  gameState
} = require('./state.js')

let client;
let isConnected = false;
let buffer = '';
let statusInterval;

let fishToEat = [];
let fishToSell = [];
let inventoryInverval;

// Main connection
async function connect() {
  client = new net.Socket();

  setupUserInput();
  // setInventoryInterval();

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
      return; // skip further processing for this message
    }

    if (text.includes('Press any key now to skip animations')){        
        client.write('s'); // so it removes the animation
    }    

    if (text.includes('used a Level Poison on')) {
        // TODO, check if the one poisoned was me, and poison back,
        // if I don't have a positon add the user name to a list of users to poison, check theyr status before sending poison
    }
    
    if(text.includes('MARKET ITEMS')) {                
        parseMarketResponse(text);                                        
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

function setInventoryInterval() {
    inventoryInverval = setInterval(triggerInventoryProcessing, INVENTORY_INTERVAL);
    console.log('Inventory interval set');
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
  
  parseInventoryResponse(inventoryText, client);
  
  inventoryHandling = false;
}

async function eatFishList() {
  if (fishToEat.length > 0) {
    console.log(`🍽️ Eating legendary and epic fish:`, fishToEat.map(f => `${f.name} x${f.quantity}`).join(', '));
    for (let i = 0; i < fishToEat.length; i++) {
      const fish = fishToEat[i];
      const eatCommand = `/eat ${fish.name} ${fish.quantity}\n`;
      client.write(eatCommand);
      await sleep(1000);
    }
    fishToEat = [];
  } else {
    console.log(`🤷 No legendary or epic fish found to eat.`);
  }
}

async function sellFishList() {
  if (fishToSell.length > 0) {
    console.log(`💰 Selling common fish:`, fishToSell.map(f => `${f.name} x${f.quantity}`).join(', '));
    for (let i = 0; i < fishToSell.length; i++) {
      const fish = fishToSell[i];
      const sellCommand = `/sell ${fish.name} ${fish.quantity}\n`;
      client.write(sellCommand);
      await sleep(500);
    }
    fishToSell = [];
  } else {
    console.log('🤷 No common fish to sell.');
  }
}

function clearIntervals() {
    clearInterval(inventoryInverval);
    console.log('Intervals cleared');
}

// Reconnect handler
async function handleReconnect() {
  const waitMs = getRandomMs(LONG_WAIT_MIN_SECONDS, LONG_WAIT_MAX_SECONDS);
  console.log(`🔄 Reconnecting in ${waitMs / 1000}s...`);
  await sleep(waitMs);  
  clearIntervals();
  connect();
}

// Terminal input
function setupUserInput() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on('line', async (input) => {
    const command = input.trim();
        
    if (command.includes('decide-eat')) {      
      await decideEat(client);
    } else if (command.includes('decide-sell')){
      await decideSell(client);
    } else if (isConnected) {
      client.write(command + '\n');
      console.log(`➡️ Sent manual command: "${command}"`);
    } else {
      console.log('⚠️ Cannot send, not connected.');
    }    
  });
}

connect();