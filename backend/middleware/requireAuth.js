const crypto = require("crypto");
const db = require("../config/database");

async function requireAuth(req, res, next) {
    const authorization = req.get("authorization") || "";
    const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{40,})$/);
    if (!match) {
        return res.status(401).json({
            success: false,
            message: "Vui lòng đăng nhập để tiếp tục."
        });
    }

    try {
        const tokenHash = crypto.createHash("sha256").update(match[1]).digest("hex");
        const [rows] = await db.query(
            `SELECT u.id, u.name, u.email
             FROM phien_dang_nhap s
             JOIN nguoi_dung u ON u.id = s.user_id
             WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP`,
            [tokenHash]
        );
        if (!rows.length) {
            return res.status(401).json({
                success: false,
                message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."
            });
        }
        req.user = {
            id: rows[0].id,
            name: rows[0].name,
            email: rows[0].email
        };
        next();
    } catch (error) {
        console.error("Không thể xác minh phiên đăng nhập:", error);
        res.status(500).json({
            success: false,
            message: "Không thể xác minh phiên đăng nhập."
        });
    }
}

module.exports = requireAuth;
