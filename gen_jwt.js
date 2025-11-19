const jwt = require("jsonwebtoken");

const SECRET = "supersecret"; // samakan dengan JWT_SECRET milik server kamu!

console.log("User 2:", jwt.sign({ userId: 2 }, SECRET));
console.log("User 3:", jwt.sign({ userId: 3 }, SECRET));
