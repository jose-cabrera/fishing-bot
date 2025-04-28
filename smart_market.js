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
  INVENTORY_COMMAND
} = require('./constants.js')

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const LEADERBOARD_URL = "https://api-game.bloque.app/game/leaderboard";
const PLAYER_USERNAME = "deltadax728";
const POISON_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

let poisonHistory = {};

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
  gameState.futureGold = gameState.gold;
  gameState.futureXp = gameState.currentXp;

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
  const responseText = `Gold: ${gameState.gold}\n\nMarket:\n${gameState.market
    .map(item => `[${item.index}] ${item.name} - ${item.description} - ${item.price} gold`)
    .join("\n")}\n\n
    Inventory: ${Object.keys(gameState.inventory).map((item) => `\n - ${item} x ${gameState.inventory[item]}`)}`;    

  const prompt = `You are a strategy buyer for a fishing game. 
  Based on the player's current gold, inventory, and the market options, suggest if we should buy anything.
  Do NOT suggest buying overpriced items.
  If the market have any duplicate, buy the cheapest one.  
  Take into consideration how many I have on the inventory to decide try to have more of the cheaper and less of the expensive items,
  Respond ONLY with the /buy command and the number of the option (Don't add a break line).
  If you want to buy more than one of the same item, it should be multiple /buy commands.
  All the /buy commands you responde, separete them by a "|".
  If there is nothing to buy responde with a "no".`;

  const fullPrompt = `${prompt}\n\n${responseText}`;

  console.log('FUll Promtp', fullPrompt);

  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: "You analyze game market responses and suggest optimal purchases" },
      { role: "user", content: fullPrompt },
    ],
  });

  const decision = completion.choices[0].message.content.trim();

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

  gameState.selling = true;
  gameState.buying = false;
}

async function decideSell(client) {
  const responseText = `
    Current Gold: ${gameState.gold}\n\n        
    Market:\n${gameState.market
    .map(item => `[${item.index}] ${item.name} - ${item.description} - ${item.price} gold`)
    .join("\n")}\n\n
    Inventory: ${Object.keys(gameState.inventory).map((item) => `\n - ${item} x ${gameState.inventory[item]}`)}\n\n
    Fish to sell: ${JSON.stringify(gameState.fishToSell)}\n\n
    `;    

  const prompt = `
  You are a strategy seller for a fishing game.

  Your goal is to decide whether we should sell fish to afford buying at least one of each non-overpriced item in the market.

  Process to follow:
    1.	Calculate the total gold required to buy one of each non-overpriced item.
    2.	If the player already has enough gold, respond exactly with "no".
    3.	If not enough gold, select fish to sell:
    •	Prioritize selling common fish first, then uncommon, then rare if necessary.    
    •	Keep at least 1/3 of the total fish across the inventory.
    4.	After selecting which fish to sell:
    •	Calculate the total gold that would be earned by selling them.
    •	Add the earned gold to the current player’s gold.
    5.	Verify:
    •	If after selling, the total gold is enough to buy all needed items, respond ONLY with a JSON array listing the fish names you chose to sell (without quantities).
    •	If after selling, the total gold is still not enough, respond exactly with "no".

  Important Rules:
    •	“Overpriced” items are items costing more than 15,000 gold or items where the price is more than 3x another duplicate’s price.
    •	If there are duplicate items, choose the cheapest one.
    •	Only consider buying non-overpriced items.
    •	Do not respond with any extra text or explanation — only the "no" string or the JSON array.

  Mentality:
  “Sell smart. Only sell if success is guaranteed. Never risk depleting fish supply unnecessarily.”
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
          Sell up to 3/4 of any fish type, prioritizing common fish first.
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
          // client.write(`/sell ${filteredFish[0].name}\n`)
          await sleep(300)
        }        
      }       
    }       
  }

  gameState.selling = false;
  gameState.buying = true;  
  client.write(INVENTORY_COMMAND);
}

const ALLIANCE_MEMBERS = ["friendlyPlayer1", "friendlyPlayer2", "deltadax728"]; // Add your allies here
const END_GAME_DATE = new Date("2024-12-31T23:59:59Z");

async function decidePoisonDelayTarget(client) {
  try {
    const { data } = await axios.get(LEADERBOARD_URL);
    const players = data.players;

    const myRank = players.find(p => p.username === PLAYER_USERNAME)?.rank || null;
    if (!myRank) {
      console.log("⚠️ Player not ranked yet.");
      return;
    }

    const candidates = players.filter(p => p.rank < myRank && !ALLIANCE_MEMBERS.includes(p.username));

    const now = Date.now();
    const safeCandidates = candidates.filter(p => {
      const lastPoisoned = poisonHistory[p.username] || 0;
      return now - lastPoisoned > POISON_COOLDOWN_MS;
    });

    if (safeCandidates.length === 0) {
      console.log("⏳ No valid targets to poison at the moment.");
      return;
    }    

    const prompt = `You are a strategy advisor. 
    Based on the following leaderboard of enemy players, 
    choose the best target to poison using Delay to slow their fishing.
    Do not target any of these alliance members: ${ALLIANCE_MEMBERS.join(', ')}.
    Prioritize higher ranked players (rank 1 is the best). 
    Respond ONLY with the exact command "/poison 2 player" depending on the player you choose . 
    If no action should be taken, respond exactly with "no".`;

    const fullPrompt = `${prompt}\n\nLeaderboard:\n${safeCandidates
      .map(p => `${p.rank}. ${p.username} - XP: ${p.xp}, Gold: ${p.gold}, Level: ${p.level}`)
      .join("\n")}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You choose a player to slow down via poison delay." },
        { role: "user", content: fullPrompt },
      ],
    });

    const result = completion.choices[0].message.content.trim();
    if (result === 'no'){
      console.log("🧠 GPT Decision: No one to poison");
    } {
      console.log(`☠️ Poisoning with Delay: ${result}`);
      client.write(`${result}\n`);
      poisonHistory[result] = now;
    }

    
  } catch (err) {
    console.error("❌ Error fetching leaderboard or poisoning:", err);
  }
}

async function decidePoisonLevelingTarget(client) {
  try {
    const now = new Date();
    const diffMinutes = (END_GAME_DATE - now) / (1000 * 60);

    if (diffMinutes > 30) {
      console.log("🕒 Too early for Poison of Leveling.");
      return;
    }

    const { data } = await axios.get(LEADERBOARD_URL);
    const players = data.players;

    const myRank = players.find(p => p.username === PLAYER_USERNAME)?.rank || null;
    if (!myRank) {
      console.log("⚠️ Player not ranked yet.");
      return;
    }

    const candidates = players.filter(p => p.rank < myRank && !ALLIANCE_MEMBERS.includes(p.username));

    const safeCandidates = candidates.filter(p => {
      const lastPoisoned = poisonHistory[p.username] || 0;
      return Date.now() - lastPoisoned > POISON_COOLDOWN_MS;
    });

    if (safeCandidates.length === 0) {
      console.log("⏳ No valid targets to poison at the moment.");
      return;
    }

    const prompt = `You are a strategy advisor. 
    Based on the following leaderboard of enemy players, 
    choose the best target to poison using Leveling to steal their rank. 
    Do not target any of these alliance members: ${ALLIANCE_MEMBERS.join(', ')}.
    Prioritize players with the highest level and XP.
    Respond ONLY with the exact command "/poison 1 player" depending on the player you choose . 
    If no action should be taken, respond exactly with "no".`;

    const fullPrompt = `${prompt}\n\nLeaderboard:\n${safeCandidates
      .map(p => `${p.rank}. ${p.username} - XP: ${p.xp}, Gold: ${p.gold}, Level: ${p.level}`)
      .join("\n")}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You choose a player to target for leveling poison." },
        { role: "user", content: fullPrompt },
      ],
    });

    const result = completion.choices[0].message.content.trim();
    if (result === 'no'){
      console.log("🧠 GPT Decision: No one to poison");
    } {
      console.log(`☠️ Poisoning with Delay: ${result}`);
      client.write(`${result}\n`);
      poisonHistory[result] = now;
    }
  } catch (err) {
    console.error("❌ Error fetching leaderboard or poisoning:", err);
  }
}

module.exports = {
  parseInventoryResponse,
  parseMarketResponse,
  decidePurchases,
  decidePoisonDelayTarget,
  decidePoisonLevelingTarget,
  decideSell,  
};
