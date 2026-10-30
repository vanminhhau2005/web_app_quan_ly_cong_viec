const LOCAL_DB_NAME = "PWA_QuanLy";
const LOCAL_DB_VERSION = 3;

let localDbPromise;
const SYNC_LOCK_LEASE_MS = 60 * 1000;

function moLocalDb() {
    if (!localDbPromise) {
        localDbPromise = new Promise(function (resolve, reject) {
            const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);

            request.onupgradeneeded = function () {
                const database = request.result;
                if (!database.objectStoreNames.contains("congViec")) {
                    database.createObjectStore("congViec", { keyPath: "id" });
                }
                if (!database.objectStoreNames.contains("syncQueue")) {
                    database.createObjectStore("syncQueue", { keyPath: "id" });
                }
                if (!database.objectStoreNames.contains("syncState")) {
                    database.createObjectStore("syncState", { keyPath: "id" });
                }
            };

            request.onsuccess = function () {
                resolve(request.result);
            };
            request.onerror = function () {
                reject(request.error || new Error("Không thể mở kho dữ liệu trên thiết bị."));
            };
        });
    }
    return localDbPromise;
}

async function layTatCaCongViec(userId) {
    const tasks = await layTatCaBanGhi(userId);
    return tasks.filter(function (task) {
        return !task.deleted;
    });
}

async function layTatCaBanGhi(userId) {
    const database = await moLocalDb();
    return new Promise(function (resolve, reject) {
        const request = database.transaction("congViec", "readonly")
            .objectStore("congViec").getAll();
        request.onsuccess = function () {
            resolve(request.result.filter(function (task) {
                return task.ownerId === String(userId);
            }));
        };
        request.onerror = function () {
            reject(request.error || new Error("Không thể đọc danh sách công việc."));
        };
    });
}

async function layCongViecLocal(userId, id) {
    const database = await moLocalDb();
    return new Promise(function (resolve, reject) {
        const request = database.transaction("congViec", "readonly")
            .objectStore("congViec").get(id);
        request.onsuccess = function () {
            const task = request.result;
            resolve(task && task.ownerId === String(userId) ? task : undefined);
        };
        request.onerror = function () {
            reject(request.error || new Error("Không thể đọc công việc."));
        };
    });
}

async function luuCongViec(congViec, queueAction) {
    const database = await moLocalDb();
    return new Promise(function (resolve, reject) {
        const transaction = database.transaction(["congViec", "syncQueue"], "readwrite");
        transaction.objectStore("congViec").put(congViec);
        if (queueAction) {
            transaction.objectStore("syncQueue").put({
                id: congViec.id,
                ownerId: congViec.ownerId,
                action: queueAction,
                queuedAt: Date.now()
            });
        }
        transaction.oncomplete = function () {
            if (queueAction) {
                dangKyBackgroundSync();
            }
            resolve();
        };
        transaction.onerror = function () {
            reject(transaction.error || new Error("Không thể lưu công việc trên thiết bị."));
        };
        transaction.onabort = function () {
            reject(transaction.error || new Error("Không thể lưu thay đổi vào hàng đợi đồng bộ."));
        };
    });
}

function dangKyBackgroundSync() {
    if (!("serviceWorker" in navigator)) {
        return;
    }
    navigator.serviceWorker.ready.then(function (registration) {
        if (registration.sync && typeof registration.sync.register === "function") {
            return registration.sync.register("pwa-task-sync");
        }
        return undefined;
    }).catch(function (error) {
        console.warn("Không thể đăng ký Background Sync:", error);
    });
}

async function luuPhienDongBo(token, userId) {
    const database = await moLocalDb();
    return new Promise(function (resolve, reject) {
        const transaction = database.transaction("syncState", "readwrite");
        transaction.objectStore("syncState")
            .put({ id: "session", token: token, ownerId: String(userId) });
        transaction.oncomplete = resolve;
        transaction.onerror = function () {
            reject(transaction.error || new Error("Không thể lưu phiên cho đồng bộ nền."));
        };
        transaction.onabort = function () {
            reject(transaction.error || new Error("Không thể lưu phiên cho đồng bộ nền."));
        };
    });
}

async function xoaPhienDongBo() {
    const database = await moLocalDb();
    return new Promise(function (resolve, reject) {
        const transaction = database.transaction("syncState", "readwrite");
        transaction.objectStore("syncState").delete("session");
        transaction.oncomplete = resolve;
        transaction.onerror = function () {
            reject(transaction.error || new Error("Không thể xóa phiên đồng bộ nền."));
        };
        transaction.onabort = function () {
            reject(transaction.error || new Error("Không thể xóa phiên đồng bộ nền."));
        };
    });
}

async function khoaDongBo(owner) {
    const database = await moLocalDb();
    return new Promise(function (resolve, reject) {
        const transaction = database.transaction("syncState", "readwrite");
        const store = transaction.objectStore("syncState");
        const request = store.get("lock");
        let acquired = false;
        request.onsuccess = function () {
            const lock = request.result;
            const staleLegacyLock = lock && !Number.isFinite(lock.heartbeatAt);
            if (!lock || lock.expiresAt <= Date.now() || staleLegacyLock) {
                store.put({
                    id: "lock",
                    owner: owner,
                    expiresAt: Date.now() + SYNC_LOCK_LEASE_MS,
                    heartbeatAt: Date.now()
                });
                acquired = true;
            }
        };
        transaction.oncomplete = function () {
            resolve(acquired);
        };
        transaction.onerror = function () {
            reject(transaction.error || new Error("Không thể khóa tiến trình đồng bộ."));
        };
        transaction.onabort = function () {
            reject(transaction.error || new Error("Không thể khóa tiến trình đồng bộ."));
        };
    });
}

async function giaHanKhoaDongBo(owner) {
    const database = await moLocalDb();
    return new Promise(function (resolve, reject) {
        const transaction = database.transaction("syncState", "readwrite");
        const store = transaction.objectStore("syncState");
        const request = store.get("lock");
        let renewed = false;
        request.onsuccess = function () {
            const lock = request.result;
            if (lock && lock.owner === owner) {
                const now = Date.now();
                store.put({
                    id: "lock",
                    owner: owner,
                    expiresAt: now + SYNC_LOCK_LEASE_MS,
                    heartbeatAt: now
                });
                renewed = true;
            }
        };
        transaction.oncomplete = function () {
            resolve(renewed);
        };
        transaction.onerror = function () {
            reject(transaction.error || new Error("Không thể gia hạn khóa đồng bộ."));
        };
        transaction.onabort = function () {
            reject(transaction.error || new Error("Không thể gia hạn khóa đồng bộ."));
        };
    });
}

async function moKhoaDongBo(owner) {
    const database = await moLocalDb();
    return new Promise(function (resolve, reject) {
        const transaction = database.transaction("syncState", "readwrite");
        const store = transaction.objectStore("syncState");
        const request = store.get("lock");
        request.onsuccess = function () {
            if (request.result && request.result.owner === owner) {
                store.delete("lock");
            }
        };
        transaction.oncomplete = resolve;
        transaction.onerror = function () {
            reject(transaction.error || new Error("Không thể mở khóa tiến trình đồng bộ."));
        };
    });
}

async function layHangDoiDongBo(userId) {
    const database = await moLocalDb();
    return new Promise(function (resolve, reject) {
        const request = database.transaction("syncQueue", "readonly")
            .objectStore("syncQueue").getAll();
        request.onsuccess = function () {
            resolve(request.result.filter(function (entry) {
                return entry.ownerId === String(userId);
            }));
        };
        request.onerror = function () {
            reject(request.error || new Error("Không thể đọc hàng đợi đồng bộ."));
        };
    });
}

async function xoaKhoiHangDoi(id) {
    const database = await moLocalDb();
    return new Promise(function (resolve, reject) {
        const request = database.transaction("syncQueue", "readwrite")
            .objectStore("syncQueue").delete(id);
        request.onsuccess = resolve;
        request.onerror = function () {
            reject(request.error || new Error("Không thể cập nhật hàng đợi đồng bộ."));
        };
    });
}

async function capNhatLoiHangDoi(entry, message) {
    const database = await moLocalDb();
    return new Promise(function (resolve, reject) {
        const request = database.transaction("syncQueue", "readwrite")
            .objectStore("syncQueue").put(Object.assign({}, entry, {
                lastError: message,
                lastAttemptAt: Date.now()
            }));
        request.onsuccess = resolve;
        request.onerror = function () {
            reject(request.error || new Error("Không thể cập nhật lỗi hàng đợi."));
        };
    });
}

async function xoaCongViecDB(id, userId) {
    const database = await moLocalDb();
    const task = await layCongViecLocal(userId, id);
    if (!task) {
        return;
    }
    task.deleted = true;
    task.dirty = true;
    await luuCongViec(task, "upsert");
}
