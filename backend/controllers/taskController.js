const db = require("../config/database");

function formatDate(value) {
    if (!value) {
        return null;
    }
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            return null;
        }
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, "0");
        const day = String(value.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    const text = String(value);
    const isoDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoDate) {
        return isoDate[1];
    }

    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function formatTimestamp(value) {
    if (!value) {
        return new Date(0).toISOString();
    }
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime())
        ? new Date(0).toISOString()
        : parsed.toISOString();
}

function normalizeDueDate(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            return null;
        }
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, "0");
        const day = String(value.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }
    if (typeof value !== "string") {
        return null;
    }

    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
    if (!match) {
        return null;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day) {
        return null;
    }
    return `${match[1]}-${match[2]}-${match[3]}`;
}

function mapTask(row) {
    return {
        clientId: row.client_id,
        content: row.content,
        description: row.description || "",
        completed: Boolean(row.completed),
        category: row.category,
        dueAt: formatDate(row.due_at),
        reminder: Boolean(row.reminder),
        deleted: Boolean(row.deleted),
        version: row.version,
        updatedAt: formatTimestamp(row.updated_at)
    };
}

async function list(req, res) {
    try {
        const [rows] = await db.query(
            "SELECT * FROM cong_viec_dong_bo WHERE user_id = ? ORDER BY updated_at DESC",
            [req.user.id]
        );
        res.json({
            success: true,
            data: { tasks: rows.map(mapTask) }
        });
    } catch (error) {
        console.error("Không thể tải công việc:", error);
        res.status(500).json({
            success: false,
            message: "Không thể tải danh sách công việc."
        });
    }
}

async function remove(req, res) {
    const clientId = req.params.clientId;
    const version = Number((req.body || {}).version);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId) ||
        !Number.isSafeInteger(version) || version < 0) {
        return res.status(400).json({
            success: false,
            message: "Dữ liệu xóa công việc không hợp lệ."
        });
    }

    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const [rows] = await connection.query(
            "SELECT * FROM cong_viec_dong_bo WHERE user_id = ? AND client_id = ? FOR UPDATE",
            [req.user.id, clientId]
        );
        if (rows.length && rows[0].deleted) {
            await connection.commit();
            return res.json({
                success: true,
                data: { task: mapTask(rows[0]) }
            });
        }

        if (rows.length) {
            await connection.query(
                `UPDATE cong_viec_dong_bo
                 SET content = '', description = NULL, completed = FALSE, category = 'Khác',
                     due_at = NULL, reminder = FALSE, deleted = TRUE,
                     version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = ? AND client_id = ?`,
                [req.user.id, clientId]
            );
        } else {
            await connection.query(
                `INSERT INTO cong_viec_dong_bo
                 (user_id, client_id, content, description, completed, category, due_at, reminder, deleted, version)
                 VALUES (?, ?, '', NULL, FALSE, 'Khác', NULL, FALSE, TRUE, ?)`,
                [req.user.id, clientId, Math.max(version + 1, 1)]
            );
        }
        const [deletedRows] = await connection.query(
            "SELECT * FROM cong_viec_dong_bo WHERE user_id = ? AND client_id = ?",
            [req.user.id, clientId]
        );
        await connection.commit();
        res.json({
            success: true,
            data: { task: mapTask(deletedRows[0]) }
        });
    } catch (error) {
        if (connection) {
            await connection.rollback();
        }
        console.error("Không thể xóa công việc:", error);
        res.status(500).json({
            success: false,
            message: "Không thể xóa công việc khỏi máy chủ."
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

async function upsert(req, res) {
    const clientId = req.params.clientId;
    const body = req.body || {};
    const version = body.version === undefined || body.version === null || body.version === ""
        ? 0
        : Number(body.version);
    if (body.deleted) {
        return remove(req, res);
    }
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const requestedCategory = typeof body.category === "string" ? body.category : "Cá nhân";
    const validCategories = ["Cá nhân", "Công việc", "Học tập", "Khác"];
    const category = validCategories.includes(requestedCategory) ? requestedCategory : "Khác";
    const dueAt = normalizeDueDate(body.dueAt);

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId) || !content || content.length > 1000 ||
        description.length > 5000 ||
        !Number.isSafeInteger(version) || version < 0) {
        return res.status(400).json({
            success: false,
            message: "Dữ liệu công việc không hợp lệ.",
            details: {
                clientIdValid: /^[A-Za-z0-9_-]{1,64}$/.test(clientId),
                contentValid: Boolean(content) && content.length <= 1000,
                descriptionValid: description.length <= 5000,
                versionValid: Number.isSafeInteger(version) && version >= 0
            }
        });
    }

    try {
        const [existingRows] = await db.query(
            "SELECT * FROM cong_viec_dong_bo WHERE user_id = ? AND client_id = ?",
            [req.user.id, clientId]
        );
        if (!existingRows.length) {
            if (version !== 0) {
                return res.status(409).json({
                    success: false,
                    message: "Công việc đã thay đổi trên máy chủ.",
                    current: null
                });
            }
            await db.query(
                `INSERT INTO cong_viec_dong_bo
                 (user_id, client_id, content, description, completed, category, due_at, reminder, deleted, version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
                [req.user.id, clientId, content, description, Boolean(body.completed), category, dueAt,
                    Boolean(body.reminder), Boolean(body.deleted)]
            );
        } else {
            const existing = existingRows[0];
            if (existing.version !== version) {
                return res.status(409).json({
                    success: false,
                    message: "Công việc đã được thay đổi trên thiết bị khác.",
                    current: mapTask(existing)
                });
            }
            const [result] = await db.query(
                `UPDATE cong_viec_dong_bo
                 SET content = ?, description = ?, completed = ?, category = ?, due_at = ?, reminder = ?,
                     deleted = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = ? AND client_id = ? AND version = ?`,
                [content, description, Boolean(body.completed), category, dueAt, Boolean(body.reminder),
                    Boolean(body.deleted), req.user.id, clientId, version]
            );
            if (!result.affectedRows) {
                const [latestRows] = await db.query(
                    "SELECT * FROM cong_viec_dong_bo WHERE user_id = ? AND client_id = ?",
                    [req.user.id, clientId]
                );
                return res.status(409).json({
                    success: false,
                    message: "Công việc vừa được thay đổi trên thiết bị khác.",
                    current: latestRows.length ? mapTask(latestRows[0]) : null
                });
            }
        }
        const [savedRows] = await db.query(
            "SELECT * FROM cong_viec_dong_bo WHERE user_id = ? AND client_id = ?",
            [req.user.id, clientId]
        );
        res.json({ success: true, data: { task: mapTask(savedRows[0]) } });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            const [rows] = await db.query(
                "SELECT * FROM cong_viec_dong_bo WHERE user_id = ? AND client_id = ?",
                [req.user.id, clientId]
            );
            return res.status(409).json({
                success: false,
                message: "Công việc đã được tạo trên thiết bị khác.",
                current: rows.length ? mapTask(rows[0]) : null
            });
        }
        console.error("Không thể lưu công việc:", error);
        res.status(500).json({
            success: false,
            message: "Không thể lưu công việc lên máy chủ."
        });
    }
}

module.exports = { list, upsert, remove };
