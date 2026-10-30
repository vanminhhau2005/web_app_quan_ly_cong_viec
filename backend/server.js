const express = require("express");
const cors = require("cors");
require("dotenv").config();

const db = require("./config/database");
const authRoutes = require("./routes/authRoutes");
const taskRoutes = require("./routes/taskRoutes");


// =====================================
// TẠO ỨNG DỤNG EXPRESS
// =====================================

const app = express();


// =====================================
// MIDDLEWARE
// =====================================

// Cho phép Frontend gọi Backend
app.use(cors());

// Cho phép nhận dữ liệu JSON
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/api/tasks", taskRoutes);


// =====================================
// KIỂM TRA BACKEND
// =====================================

app.get("/", (req, res) => {

    res.json({
        success: true,
        message: "Backend PWA đang hoạt động"
    });

});


// =====================================
// KIỂM TRA KẾT NỐI DATABASE
// =====================================

app.get("/api/test-db", async (req, res) => {

    try {

        const [rows] = await db.query(
            "SELECT 1 AS ket_noi"
        );

        res.json({
            success: true,
            message: "Kết nối MariaDB thành công",
            data: rows
        });

    } catch (error) {

        console.error("Lỗi Database:", error);

        res.status(500).json({
            success: false,
            message: "Kết nối MariaDB thất bại",
            error: error.message
        });

    }

});


// =====================================
// KHỞI ĐỘNG SERVER
// =====================================

const PORT = process.env.PORT || 3000;

async function initializeDatabase() {
     await db.query(`
        CREATE TABLE IF NOT EXISTS nguoi_dung (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(80) NOT NULL,
            email VARCHAR(254) NOT NULL UNIQUE,
            password_hash VARCHAR(200) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB
    `);
    await db.query("ALTER TABLE nguoi_dung MODIFY password_hash VARCHAR(200) NOT NULL");
    await db.query(`
        CREATE TABLE IF NOT EXISTS phien_dang_nhap (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            user_id BIGINT UNSIGNED NOT NULL,
            token_hash CHAR(64) NOT NULL UNIQUE,
            expires_at DATETIME NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX sessions_expiry (expires_at),
            CONSTRAINT phien_dang_nhap_user_fk FOREIGN KEY (user_id)
                REFERENCES nguoi_dung(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
    `);
    const [sessionForeignKeys] = await db.query(
        "SELECT CONSTRAINT_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'phien_dang_nhap' " +
        "AND COLUMN_NAME = 'user_id' AND REFERENCED_TABLE_NAME IS NOT NULL"
    );
    if (sessionForeignKeys.length !== 1 ||
        sessionForeignKeys[0].REFERENCED_TABLE_NAME !== "nguoi_dung") {
        const [orphanSessionRows] = await db.query(
            "SELECT COUNT(*) AS count FROM phien_dang_nhap s " +
            "LEFT JOIN nguoi_dung u ON u.id = s.user_id WHERE u.id IS NULL"
        );
        if (Number(orphanSessionRows[0].count) > 0) {
            throw new Error(
                "Không thể sửa khóa ngoại phiên đăng nhập: có dữ liệu gắn với tài khoản không tồn tại trong nguoi_dung."
            );
        }
        for (const foreignKey of sessionForeignKeys) {
            const constraintName = foreignKey.CONSTRAINT_NAME.replace(/`/g, "``");
            await db.query(
                `ALTER TABLE phien_dang_nhap DROP FOREIGN KEY \`${constraintName}\``
            );
        }
        await db.query(
            "ALTER TABLE phien_dang_nhap " +
            "ADD CONSTRAINT phien_dang_nhap_user_fk FOREIGN KEY (user_id) " +
            "REFERENCES nguoi_dung(id) ON DELETE CASCADE"
        );
    }
    await db.query(`
        CREATE TABLE IF NOT EXISTS cong_viec_dong_bo (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            user_id BIGINT UNSIGNED NOT NULL,
            client_id VARCHAR(64) NOT NULL,
            content VARCHAR(1000) NOT NULL,
            description TEXT NULL,
            completed BOOLEAN NOT NULL DEFAULT FALSE,
            category VARCHAR(50) NOT NULL DEFAULT 'Cá nhân',
            due_at DATE NULL,
            reminder BOOLEAN NOT NULL DEFAULT FALSE,
            deleted BOOLEAN NOT NULL DEFAULT FALSE,
            version INT UNSIGNED NOT NULL DEFAULT 1,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY tasks_user_client (user_id, client_id),
            INDEX tasks_user_updated (user_id, updated_at),
            CONSTRAINT cong_viec_dong_bo_user_fk FOREIGN KEY (user_id)
                REFERENCES nguoi_dung(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
    `);
    const [descriptionColumns] = await db.query(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cong_viec_dong_bo' " +
        "AND COLUMN_NAME = 'description'"
    );
    if (!descriptionColumns.length) {
        await db.query(
            "ALTER TABLE cong_viec_dong_bo ADD COLUMN description TEXT NULL AFTER content"
        );
    }
    const [taskForeignKeys] = await db.query(
        "SELECT CONSTRAINT_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cong_viec_dong_bo' " +
        "AND COLUMN_NAME = 'user_id' AND REFERENCED_TABLE_NAME IS NOT NULL"
    );
    if (taskForeignKeys.length !== 1 ||
        taskForeignKeys[0].REFERENCED_TABLE_NAME !== "nguoi_dung") {
        const [orphanTaskRows] = await db.query(
            "SELECT COUNT(*) AS count FROM cong_viec_dong_bo t " +
            "LEFT JOIN nguoi_dung u ON u.id = t.user_id WHERE u.id IS NULL"
        );
        if (Number(orphanTaskRows[0].count) > 0) {
            throw new Error(
                "Không thể sửa khóa ngoại công việc: có dữ liệu gắn với tài khoản không tồn tại trong nguoi_dung."
            );
        }
        for (const foreignKey of taskForeignKeys) {
            const constraintName = foreignKey.CONSTRAINT_NAME.replace(/`/g, "``");
            await db.query(
                `ALTER TABLE cong_viec_dong_bo DROP FOREIGN KEY \`${constraintName}\``
            );
        }
        await db.query(
            "ALTER TABLE cong_viec_dong_bo " +
            "ADD CONSTRAINT cong_viec_dong_bo_user_fk FOREIGN KEY (user_id) " +
            "REFERENCES nguoi_dung(id) ON DELETE CASCADE"
        );
    }
}

initializeDatabase().then(function () {
    app.listen(PORT, () => {
        console.log(`Backend đang chạy tại http://localhost:${PORT}`);
    });
}).catch(function (error) {
    console.error("Không thể khởi tạo cơ sở dữ liệu cho PWA:", error);
    process.exitCode = 1;
});