// Helper functions
function getRandomMs(minSeconds, maxSeconds) {
  return Math.floor(Math.random() * ((maxSeconds - minSeconds + 1) * 1000)) + minSeconds * 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  getRandomMs,
  sleep
}