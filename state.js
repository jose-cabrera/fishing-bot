// Global game state tracker
let gameState = {
    gold: 0,
    currentXp: 0,
    inventory: {},
    market: [],
    ownedItems: {},
    fishToEat: [],
    fishToSell: [],
    futureGold: 0,
    futureXp: 0,
    selling: true,
    buying: false,
  };

  module.exports = {
    gameState
  }