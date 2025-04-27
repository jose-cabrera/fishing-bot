const OpenAI = require("openai");
const axios = require("axios");
require("dotenv").config();
const {
  sleep,  
} = require('./helpers.js')

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const LEADERBOARD_URL = "https://api-game.bloque.app/game/leaderboard";
const PLAYER_USERNAME = "deltadax728";
const POISON_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

let poisonHistory = {};

// Global game state tracker
let gameState = {
  gold: 0,
  inventory: {},
  market: [],
  ownedItems: {},
};

function parseInventoryResponse(response) {
  const goldMatch = response.match(/Gold:\s?(\d+)/);
  gameState.gold = goldMatch ? parseInt(goldMatch[1], 10) : 0;

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

  console.log("📦 Inventory gold:", gameState.gold);
  console.log("📦 Inventory items:", gameState.inventory);
}

function parseMarketResponse(response) {
  gameState.market = response
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

  console.log("🛒 Market Items:", gameState.market);
}

async function decidePurchases(client) { 
  if (gameState.gold < 25000) {
    console.log("💰 Not enough gold to buy anything (requires 25,000+)");
    return;
  }

  const affordableMarket = gameState.market.filter(item => {
    if (item.name === 'Poison of Recovery' && item.price <= 60000) return false;
    return true;
  });

  if (affordableMarket.length === 0) {
    console.log("⚠️ No suitable items to buy at this time.");
    return;
  }

  const filteredMarket = affordableMarket.filter(item => !gameState.ownedItems[item.name]);

  const responseText = `Gold: ${gameState.gold}\n\nMarket:\n${filteredMarket
    .map(item => `[${item.index}] ${item.name} - ${item.description} - ${item.price} gold`)
    .join("\n")}\n\n
    Inventory: ${Object.keys(gameState.inventory).map((item) => `\n - ${item} x ${gameState.inventory[item]}`)}`;    

  const prompt = `You are a strategy buyer for a fishing game. 
  Based on the player's current gold, inventory, and the market options, suggest if we should buy anything. 
  Only a max of 5 of each item. Do NOT suggest buying overpriced items.
  If the market have any duplicate, buy the cheapest one.  
  Take into consideration how many I have on the inventory to decide,
  try to always buy the limit.   
  The ones that have priority are the Enhanced Fishing Rod and Poison of Leveling.  
  Try to get more of the priority items. 
  Respond ONLY with the /buy command and the number of the option (Don't add a break line).
  If you want to buy more than one of the same item, it should be multiple /buy commands.
  All the /buy commands you responde, separete them by a "|".
  If there is nothing to buy responde with a "no".`;

  const fullPrompt = `${prompt}\n\n${responseText}`;

  console.log('FUll Promtp', fullPrompt);

  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: "You analyze game market responses and suggest optimal purchases with only /buy commands." },
      { role: "user", content: fullPrompt },
    ],
  });

  const decision = completion.choices[0].message.content.trim();

  console.log('decision', decision);

  if (decision.toLowerCase() === "no") {
    console.log("🧠 GPT Decision: No purchase needed");
  } else {
    console.log("🧠 GPT Decision:", decision);
    const decisionList = decision.split('|')
    for(const index in decisionList){      
      client.write(`${decisionList[index]}\n`);
      await sleep(1000)
    }
    
  }
}

async function decidePoisonTargetAndType(client) {
  try {
    const { data } = await axios.get(LEADERBOARD_URL);
    const players = data.players;

    const myRank = players.find(p => p.username === PLAYER_USERNAME)?.rank || null;
    if (!myRank) {
      console.log("⚠️ Player not ranked yet.");
      return;
    }

    const candidates = players.filter(p => p.rank < myRank);

    const now = Date.now();
    const safeCandidates = candidates.filter(p => {
      const lastPoisoned = poisonHistory[p.username] || 0;
      return now - lastPoisoned > POISON_COOLDOWN_MS;
    });

    if (safeCandidates.length === 0) {
      console.log("⏳ No valid targets to poison at the moment.");
      return;
    }

    const prompt = `You're a strategy expert for a fishing RPG game. The goal is to climb to rank 1. Based on the leaderboard, choose the best player to poison and the type of poison (Leveling or Delay). Consider player XP, level, gold, and price of each poison. Only poison players ranked above the player. Respond with /poison <username> <type>, or "no" if no action should be taken.`;

    const fullPrompt = `${prompt}\n\nLeaderboard:\n${safeCandidates
      .map(p => `${p.rank}. ${p.username} - XP: ${p.xp}, Gold: ${p.gold}, Level: ${p.level}`)
      .join("\n")}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You decide on the best strategic poison usage in a leaderboard game." },
        { role: "user", content: fullPrompt },
      ],
    });

    const result = completion.choices[0].message.content.trim();

    if (result.toLowerCase() === "no") {
      console.log("🧠 GPT: No poison needed now.");
      return;
    }

    const poisonMatch = result.match(/\/poison\s+(\w+)\s+(Leveling|Delay)/i);
    if (poisonMatch) {
      const [, username, type] = poisonMatch;
      console.log(`☠️ Poisoning: ${username} with ${type}`);
      client.write(`/poison ${username} ${type}\n`);
      poisonHistory[username] = now;
    } else {
      console.log("⚠️ GPT poison response unrecognized:", result);
    }
  } catch (err) {
    console.error("❌ Error fetching leaderboard or poisoning:", err);
  }
}

module.exports = {
  parseInventoryResponse,
  parseMarketResponse,
  decidePurchases,
  decidePoisonTargetAndType,
  gameState,
};
