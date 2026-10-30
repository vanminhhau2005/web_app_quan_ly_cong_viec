const crypto = require("crypto");
const { promisify } = require("util");
const db = require("../config/database");

const scrypt = promisify(crypto.scrypt);

function publicUser(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email
    };
}

async function createSession(user, res) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    await db.query(
        "INSERT INTO phien_dang_nhap (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 DAY))",
        [user.id, tokenHash]
    );
    res.json({
        success: true,
        data: {
            token,
            user: publicUser(user)
        }
    });
}

async function register(req, res) {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (name.length < 2 || name.length > 80 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
        password.length < 8 || password.length > 128) {
        return res.status(400).json({
            success: false,
            message: "Vui lòng nhập tên, email hợp lệ và mật khẩu từ 8 đến 128 ký tự."
        });
    }

    try {
        const salt = crypto.randomBytes(16);
        const hash = await scrypt(password, salt, 64);
        const passwordHash = salt.toString("hex") + ":" + hash.toString("hex");
        const [result] = await db.query(
            "INSERT INTO nguoi_dung (name, email, password_hash) VALUES (?, ?, ?)",
            [name, email, passwordHash]
        );
        await createSession({ id: result.insertId, name, email }, res);
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message: "Email này đã được đăng ký."
            });
        }
        console.error("Không thể tạo tài khoản:", error);
        res.status(500).json({
            success: false,
            message: "Không thể tạo tài khoản lúc này."
        });
    }
}

async function login(req, res) {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: "Vui lòng nhập email và mật khẩu."
        });
    }

    try {
        const [rows] = await db.query(
            "SELECT id, name, email, password_hash FROM nguoi_dung WHERE email = ?",
            [email]
        );
        if (!rows.length) {
            return res.status(401).json({
                success: false,
                message: "Email hoặc mật khẩu chưa chính xác."
            });
        }
        const [saltHex, expectedHex] = rows[0].password_hash.split(":");
        const actual = await scrypt(password, Buffer.from(saltHex, "hex"), 64);
        const expected = Buffer.from(expectedHex, "hex");
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
            return res.status(401).json({
                success: false,
                message: "Email hoặc mật khẩu chưa chính xác."
            });
        }
        await createSession(rows[0], res);
    } catch (error) {
        console.error("Không thể đăng nhập:", error);
        res.status(500).json({
            success: false,
            message: "Không thể đăng nhập lúc này."
        });
    }
}

async function me(req, res) {
    res.json({ success: true, data: { user: req.user } });
}

async function logout(req, res) {
    const token = req.get("authorization").slice("Bearer ".length);
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    try {
        await db.query("DELETE FROM phien_dang_nhap WHERE token_hash = ?", [tokenHash]);
        res.json({ success: true });
    } catch (error) {
        console.error("Không thể kết thúc phiên:", error);
        res.status(500).json({
            success: false,
            message: "Không thể kết thúc phiên lúc này."
        });
    }
}

module.exports = { register, login, me, logout };
