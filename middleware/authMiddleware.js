// ═══════════════════════════════════════════
// middleware/authMiddleware.js — JWT Guard
// ═══════════════════════════════════════════
const jwt = require("jsonwebtoken");

function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "No token provided. Please log in.",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, email, iat, exp }
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        error: "TokenExpired",
        message: "Your session has expired. Please log in again.",
      });
    }
    return res.status(401).json({
      error: "InvalidToken",
      message: "Invalid authentication token.",
    });
  }
}

module.exports = verifyToken;
