const ALLIANCE_MEMBERS = ["friendlyPlayer1", "friendlyPlayer2", "deltadax728"]; // Add your allies here
const END_GAME_DATE = new Date("2024-12-31T23:59:59Z");

const OpenAI = require("openai");
const axios = require("axios");
require("dotenv").config();
const {
  sleep,  
} = require('./helpers.js')
const { 
  gameState
} = require('./state.js')

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

let poisonHistory = {};

const LEADERBOARD_URL = "https://api-game.bloque.app/game/leaderboard";
const PLAYER_USERNAME = "deltadax728";
const POISON_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

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
    decidePoisonDelayTarget,
    decidePoisonLevelingTarget
}