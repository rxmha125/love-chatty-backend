import { parseJwtPayload } from "../utils/token.js";

export const requireAuth = (req, res, next) => {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  const userUuid =
    req.headers["x-user-uuid"] ||
    req.query.userUuid ||
    req.body?.userUuid ||
    req.body?.sender_id ||
    req.body?.senderUuid ||
    "";

  if (!token || !userUuid) {
    return res.status(401).json({
      success: false,
      message: "Missing authentication token or user uuid",
    });
  }

  const payload = parseJwtPayload(token);
  if (payload?.uuid && payload.uuid !== userUuid) {
    return res.status(401).json({
      success: false,
      message: "Token uuid mismatch",
    });
  }

  req.auth = {
    token,
    userUuid,
    tokenPayload: payload,
  };

  next();
};

