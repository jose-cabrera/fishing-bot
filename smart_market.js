const OpenAI = require("openai");
const axios = require("axios");
require("dotenv").config();
const {
  sleep,  
} = require('./helpers.js')
const { 
  gameState
} = require('./state.js')
const { 
  MARKET_COMMAND,
  INVENTORY_COMMAND,
  OVERPRICED,
} = require('./constants.js')

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function parseInventoryResponse(response, client) {
  const goldMatch = response.match(/Gold:\s?(\d+)/);
  gameState.gold = goldMatch ? parseInt(goldMatch[1], 10) : 0;

  const xpMatch = response.match(/XP:\s?(\d+)/);
  gameState.currentXp = xpMatch ? parseInt(xpMatch[1], 10) : 0;

  const lines = response.split('\n').map(line => line.trim());

  gameState.inventory = {}; // Reset inventory

  let inItemsSection = false;

  for (const line of lines) {
    if (line.startsWith("Items:")) {
      inItemsSection = true;
      continue;
    }

    if (inItemsSection) {
      const itemMatch = line.match(/^[a-f0-9\-]+:\s+(.*?)\s+-/i);
      if (itemMatch) {
        const itemName = itemMatch[1].trim();
        gameState.inventory[itemName] = (gameState.inventory[itemName] || 0) + 1;
      }
    }
  }  
  

  gameState.fishToEat = [];
  gameState.fishToSell = [];

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
      const fishMatch = line.match(/^[^\w]*\s*(.*?)\s*\((.*?)\)\s*-\s*x(\d+)\s*-\s*XP:\s*(\d+),\s*Gold:\s*(\d+)/u);
      if (fishMatch) {
        const fishName = fishMatch[1].trim();
        const rarity = fishMatch[2].trim().toLowerCase();
        const quantity = parseInt(fishMatch[3], 10) || 1;
        const xpValue = parseInt(fishMatch[4], 10) || 0;
        const goldValue = parseInt(fishMatch[5], 10) || 0;
        let baseName = fishName.split(' ')[0];
        if (baseName.endsWith("'s")) {
          baseName = baseName.slice(0, -2);
        }

        const fishObj = { name: baseName, rarity, quantity, goldValue, xpValue, totalValue: quantity * goldValue };

        if (rarity === 'legendary' || rarity === 'epic') {
          gameState.fishToEat.push(fishObj);
        } else {
          gameState.fishToSell.push(fishObj);
        }
      }
    }
  }

  // Calculate futureGold and futureXp
  gameState.futureGold = 0;
  gameState.futureXp = 0;

  for (const fish of [...gameState.fishToEat, ...gameState.fishToSell]) {
    gameState.futureGold += fish.goldValue * fish.quantity;
    gameState.futureXp += fish.xpValue * fish.quantity;
  }

  // Now use Enhanced Fishing Rod if available  
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
        usedFishingRod = true; // Only use one rod
      }
    }
  }

  console.log("📦 Inventory gold:", gameState.gold);
  console.log("📦 Inventory items:", gameState.inventory);
  console.log("📦 Fish to eat:", gameState.fishToEat);
  console.log("📦 Fish to sell:", gameState.fishToSell);
  console.log("💰 Current Gold:", gameState.gold);
  console.log("✨ Current XP:", gameState.currentXp);
  console.log("📈 Gold Difference (Future - Current):", gameState.futureGold - gameState.gold);
  console.log("📈 XP Difference (Future - Current):", gameState.futureXp - gameState.currentXp);
  console.log("💰 Future Gold:", gameState.futureGold);
  console.log("✨ Future XP:", gameState.futureXp);

  //Trigger market
  client.write(MARKET_COMMAND);
}

function parseMarketResponse(response) {
  const parsedItems = response
    .split('\n')
    .filter(line => line.match(/^\[\d+\]/))
    .map(line => {
      const match = line.match(/\[(\d+)\] (.*?) - (.*?) - (\d+) gold/);
      if (!match) return null;
      const [, index, name, description, price] = match;
      return {
        index: parseInt(index, 10),
        name,
        description,
        price: parseInt(price, 10),
      };
    })
    .filter(Boolean);

  // Deduplicate by name, keeping the cheapest one
  const uniqueMarket = {};
  for (const item of parsedItems) {
    if (!uniqueMarket[item.name] || item.price < uniqueMarket[item.name].price) {
      uniqueMarket[item.name] = item;
    }
  }

  gameState.market = Object.values(uniqueMarket);

  console.log("🛒 Unique Market Items:", gameState.market);
}

function getMarketTotal() {
  if (!gameState.market || gameState.market.length === 0) {
    console.log("⚠️ No market data available yet.");
    return 0;
  }

  const market = gameState.market;
  console.log("📦 Market snapshot:", market);

  let totalToBuy = 0;
  const prices = market.map(item => item.price);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

  for (const item of market) {
    console.log('item', item);
    if (item.price > 10000) {
      console.log(`⚠️ Skipping overpriced item: ${item.name} at ${item.price}`);
      continue;
    }
    totalToBuy += item.price;
  }

  console.log(`💰 Total to buy after filtering: ${totalToBuy}`);
  return totalToBuy;
}

async function decideSell(client) {

  const goldNeeded = getMarketTotal();

  console.log('marketTotal', goldNeeded)

  let totalFishGold = 0;
  for (const fish of gameState.fishToSell) {
    const sellableQuantity = Math.floor(fish.quantity * 0.75);
    totalFishGold += sellableQuantity * fish.goldValue;
  }

  // Check if selling fish is even enough
  const futureGold = gameState.gold + totalFishGold;
  if (futureGold < goldNeeded) {
    console.log("🧠 GPT Decision: No sell needed");    
  } else {
    const responseText = `
      Current Gold: ${gameState.gold}\n\n        
      Gold Needed: ${goldNeeded}\n\n
      Total Gold Sellable: ${totalFishGold}\n\n
      Market:\n${gameState.market
      .map(item => `[${item.index}] ${item.name} - ${item.description} - ${item.price} gold`)
      .join("\n")}\n\n
      Inventory: ${Object.keys(gameState.inventory).map((item) => `\n - ${item} x ${gameState.inventory[item]}`)}\n\n
      Fish to sell: ${JSON.stringify(gameState.fishToSell)}\n\n
      `;    

    const prompt = `
      You are a strategy seller for a fishing game.

      Your goal is to decide whether we should sell fish to afford buying at least one of each non-overpriced item in the market.

      Process:
      1. You will receive the current gold, needed gold, total gold sellable, market list, and fish inventory.
      2. If the current gold plus the sellable gold is still not enough to afford at least one of each non-overpriced item, respond exactly with "no".
      3. If it is possible to afford it, select fish to sell:
        • Prioritize selling common fish first, then uncommon, then rare if necessary.   
        • Always keep at least 1/3 of the total fish across all inventory.

      After selecting fish:
      - Calculate the total gold that would be earned by selling the selected fish.
      - Add it to the current gold.
      - If after selling, the new total gold is enough to buy the required items, respond ONLY with a JSON array listing the fish names (without duplicates and no quantities).
      - If not enough after selling, respond exactly with "no".

      Important Rules:
      - "Overpriced" means items priced above ${OVERPRICED} gold or priced 3x more than another duplicate.
      - If there are duplicate items, prefer the cheaper one.
      - Only consider buying non-overpriced items.
      - Do NOT respond with any extra text, headers, reasoning, or explanations — respond ONLY with "no" or the JSON array.

      Mentality:
      "Sell smart, never oversell, never risk resources unless it's guaranteed to meet the goal."
    `;

    const fullPrompt = `${prompt}\n\n${responseText}`;

    console.log('FUll Promtp', fullPrompt);

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: `
            You analyze the player’s gold, fish inventory, and market prices.
            You decide whether to sell fish in order to afford at least 1 of each non-overpriced item.
            Always keep at least 1/3 of the total fish.            
            If after selling, we cannot afford the items, respond exactly with no.
            If possible to afford, respond ONLY with a JSON array of the fish names to sell (no extra text).
          ` },
        { role: "user", content: fullPrompt },
      ],
    });

    const decision = completion.choices[0].message.content.trim();  

    if (decision.toLowerCase() === "no") {
      console.log("🧠 GPT Decision: No sell needed");    
    } else {
      console.log("🧠 GPT Decision:", decision);
      const arrayOfDecision = JSON.parse(decision);    
      for(const index in arrayOfDecision){      
        const fishName = arrayOfDecision[index];
        const filteredFish = gameState.fishToSell.filter((fish) => fish.name === fishName);
        console.log('Fishes to sell', filteredFish);
        const fishToSell = filteredFish[0]
        if(fishToSell) {
          for (var i = 0; i < filteredFish[0].quantity; i++) {          
            client.write(`/sell ${filteredFish[0].name}\n`)
            await sleep(300)
          }        
        }       
      }       
    }  
  }

  gameState.selling = false;
  gameState.buying = true;  
  client.write(INVENTORY_COMMAND);
}

async function decideEat(client) {
  console.log('🧠 Deciding how much to eat for XP gain...');

  if (!gameState.fishToEat || gameState.fishToEat.length === 0) {
    console.log('🤷 No legendary or epic fish to eat.');
    return;
  }

  const responseText = `
    Current XP: ${gameState.currentXp}\n\n
    Fish to eat: ${JSON.stringify(gameState.fishToEat)}
  `;

  const prompt = `
    You are a strategic XP optimizer for a fishing game.
    
    Goal:
    - Help increase the player's XP moderately by eating legendary and epic fish.
    - Only eat up to 50% of each fish type available (round down).
    - Never eat more than half to avoid calling too much attention.

    Respond with a JSON array listing the fish names to eat with the quantity to eat per fish.

    Important:
    - If no fish should be eaten, respond exactly with "no".
    - Otherwise respond ONLY with the JSON array without extra text.

    Example valid response:
    [{"name": "Thunder Fin", "quantity": 1}, {"name": "Sea Serpent Jr.", "quantity": 2}]
  `;

  const fullPrompt = `${prompt}\n\n${responseText}`;

  console.log('🧠 Full Prompt for Eating:', fullPrompt);

  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: `
          You decide how many legendary/epic fish to eat for XP.
          Always keep at least half of each fish type.
          Respond with a JSON array or "no".
        ` },
      { role: "user", content: fullPrompt },
    ],
  });

  const decision = completion.choices[0].message.content.trim();

  if (decision.toLowerCase() === "no") {
    console.log("🧠 GPT Decision: No eating needed.");
  } else {
    console.log("🧠 GPT Decision:", decision);
    const eatList = JSON.parse(decision);
    for (const item of eatList) {
      const { name, quantity } = item;
      for (let i = 0; i < quantity; i++) {
        client.write(`/eat ${name}\n`);
        await sleep(300);
      }
    }
  }  
}

module.exports = {
  parseInventoryResponse,
  parseMarketResponse,  
  decideSell,  
  decideEat,
};
