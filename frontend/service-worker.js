const CACHE_NAME = "pwa-quan-ly-v63";
const LOCAL_DB_NAME = "PWA_QuanLy";
const LOCAL_DB_VERSION = 3;
const BACKGROUND_SYNC_TAG = "pwa-task-sync";
const SYNC_LOCK_LEASE_MS = 60 * 1000;

const FILES_TO_CACHE = [
    "./",
    "./index.html",
    "./login.html",
    "./add.html",
    "./tasks.html",
    "./sync.html",
    "./css/style.css",
    "./vendor/bootstrap.min.css",
    "./js/core.js",
    "./js/storage.js",
    "./manifest.json?v=3",
    "./images/icon.svg?v=2",
    "./images/app-icon-teal-192.png",
    "./images/app-icon-teal-512.png"
];

self.addEventListener("install", function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(function (cache) {
                return cache.addAll(FILES_TO_CACHE);
            })
    );

    self.skipWaiting();
});

self.addEventListener("activate", function (event) {
    event.waitUntil(
        caches.keys().then(function (cacheNames) {
            return Promise.all(
                cacheNames
                    .filter(function (name) {
                        return name.indexOf("pwa-quan-ly-") === 0 && name !== CACHE_NAME;
                    })
                    .map(function (name) {
                        return caches.delete(name);
                    })
            );
        })
    );

    self.clients.claim();
});

self.addEventListener("sync", function (event) {
    if (event.tag === BACKGROUND_SYNC_TAG) {
        event.waitUntil(syncPendingTasks());
    }
});

self.addEventListener("fetch", function (event) {
    if (event.request.method !== "GET" ||
        new URL(event.request.url).origin !== self.location.origin) {
        return;
    }

    event.respondWith(
        fetch(event.request).then(function (networkResponse) {
            if (networkResponse.ok) {
                const responseCopy = networkResponse.clone();
                caches.open(CACHE_NAME).then(function (cache) {
                    cache.put(event.request, responseCopy);
                });
            }
            return networkResponse;
        }).catch(function () {
            return caches.match(event.request).then(function (response) {
                if (response) return response;
                if (event.request.mode === "navigate") {
                    return caches.match("./index.html");
                }
                return Response.error();
            });
        })
    );
});

function openLocalDb() {
    return new Promise(function (resolve, reject) {
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
            reject(request.error || new Error("Không thể mở dữ liệu đồng bộ nền."));
        };
    });
}

async function readStore(storeName, key) {
    const database = await openLocalDb();
    return new Promise(function (resolve, reject) {
        const request = database.transaction(storeName, "readonly")
            .objectStore(storeName).get(key);
        request.onsuccess = function () {
            resolve(request.result);
        };
        request.onerror = function () {
            reject(request.error || new Error("Không thể đọc dữ liệu đồng bộ nền."));
        };
    });
}

async function readAllFromStore(storeName) {
    const database = await openLocalDb();
    return new Promise(function (resolve, reject) {
        const request = database.transaction(storeName, "readonly")
            .objectStore(storeName).getAll();
        request.onsuccess = function () {
            resolve(request.result);
        };
        request.onerror = function () {
            reject(request.error || new Error("Không thể đọc hàng đợi đồng bộ."));
        };
    });
}

async function writeStore(storeName, value) {
    const database = await openLocalDb();
    return new Promise(function (resolve, reject) {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put(value);
        transaction.oncomplete = resolve;
        transaction.onerror = function () {
            reject(transaction.error || new Error("Không thể lưu kết quả đồng bộ nền."));
        };
        transaction.onabort = function () {
            reject(transaction.error || new Error("Không thể lưu kết quả đồng bộ nền."));
        };
    });
}

async function deleteQueueEntry(id) {
    const database = await openLocalDb();
    return new Promise(function (resolve, reject) {
        const transaction = database.transaction("syncQueue", "readwrite");
        transaction.objectStore("syncQueue").delete(id);
        transaction.oncomplete = resolve;
        transaction.onerror = function () {
            reject(transaction.error || new Error("Không thể cập nhật hàng đợi đồng bộ."));
        };
    });
}

async function updateQueueError(entry, message) {
    await writeStore("syncQueue", Object.assign({}, entry, {
        lastError: message,
        lastAttemptAt: Date.now()
    }));
}

async function acquireSyncLock(owner) {
    const database = await openLocalDb();
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
            reject(transaction.error || new Error("Không thể khóa tiến trình đồng bộ nền."));
        };
        transaction.onabort = function () {
            reject(transaction.error || new Error("Không thể khóa tiến trình đồng bộ nền."));
        };
    });
}

async function renewSyncLock(owner) {
    const database = await openLocalDb();
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
            reject(transaction.error || new Error("Không thể gia hạn khóa đồng bộ nền."));
        };
        transaction.onabort = function () {
            reject(transaction.error || new Error("Không thể gia hạn khóa đồng bộ nền."));
        };
    });
}

async function releaseSyncLock(owner) {
    const database = await openLocalDb();
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
            reject(transaction.error || new Error("Không thể mở khóa đồng bộ nền."));
        };
    });
}

function apiBase() {
    return self.location.protocol + "//" + self.location.hostname + ":3000/api";
}

async function apiRequest(path, token, options) {
    const requestOptions = Object.assign({}, options || {});
    requestOptions.headers = Object.assign({}, requestOptions.headers || {}, {
        Authorization: "Bearer " + token
    });
    if (requestOptions.body) {
        requestOptions.headers["Content-Type"] = "application/json";
    }
    const controller = new AbortController();
    const timeout = setTimeout(function () {
        controller.abort();
    }, 20000);
    requestOptions.signal = controller.signal;
    try {
        const response = await fetch(apiBase() + path, requestOptions);
        const result = await response.json().catch(function () {
            return {};
        });
        return { response: response, data: result };
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("Máy chủ không phản hồi sau 20 giây.");
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function taskFromServer(remote, ownerId, localId) {
    return {
        id: localId === undefined ? remote.clientId : localId,
        ownerId: String(ownerId),
        noiDung: remote.content,
        description: remote.description || "",
        hoanThanh: remote.completed,
        category: remote.category,
        dueAt: remote.dueAt,
        reminder: remote.reminder,
        deleted: remote.deleted,
        serverVersion: remote.version,
        dirty: false,
        updatedAt: remote.updatedAt || new Date().toISOString()
    };
}

function apiTask(task) {
    const categories = ["Cá nhân", "Công việc", "Học tập", "Khác"];
    const version = Number(task.serverVersion);
    return {
        content: typeof task.noiDung === "string" ? task.noiDung.trim() : "",
        description: typeof task.description === "string" ? task.description.trim() : "",
        completed: Boolean(task.hoanThanh),
        category: categories.includes(task.category) ? task.category : "Khác",
        dueAt: task.dueAt || null,
        reminder: Boolean(task.reminder),
        deleted: Boolean(task.deleted),
        version: Number.isSafeInteger(version) && version >= 0 ? version : 0
    };
}

async function broadcastSyncComplete() {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    clients.forEach(function (client) {
        client.postMessage({ type: "BACKGROUND_SYNC_COMPLETE" });
    });
}

async function syncPendingTasks() {
    const owner = "worker-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    let lockAcquired = false;
    let lockHeartbeat;
    try {
        lockAcquired = await acquireSyncLock(owner);
        if (!lockAcquired) {
            return;
        }
        lockHeartbeat = setInterval(function () {
            renewSyncLock(owner).catch(function (error) {
                console.error("Không thể gia hạn khóa đồng bộ nền:", error);
            });
        }, 15000);

        const session = await readStore("syncState", "session");
        if (!session || !session.token || !session.ownerId) {
            return;
        }
        const ownerId = String(session.ownerId);
        const queue = (await readAllFromStore("syncQueue")).filter(function (entry) {
            return entry.ownerId === ownerId;
        });

        for (const entry of queue) {
            const task = await readStore("congViec", entry.id);
            if (!task || task.ownerId !== ownerId) {
                await deleteQueueEntry(entry.id);
                continue;
            }
            const result = task.deleted
                ? await apiRequest("/tasks/" + encodeURIComponent(task.id), session.token, {
                    method: "DELETE",
                    body: JSON.stringify({ version: Number(task.serverVersion) || 0 })
                })
                : await apiRequest("/tasks/" + encodeURIComponent(task.id), session.token, {
                    method: "PUT",
                    body: JSON.stringify(apiTask(task))
                });
            if (result.response.status === 409 && result.data.current) {
                task.conflict = taskFromServer(result.data.current, ownerId);
                await writeStore("congViec", task);
                continue;
            }
            if (result.response.status === 400) {
                await updateQueueError(entry, result.data.message || "Dữ liệu công việc không hợp lệ.");
                continue;
            }
            if (result.response.status === 401) {
                return;
            }
            if (!result.response.ok) {
                throw new Error(result.data.message || "Máy chủ chưa thể đồng bộ công việc.");
            }

            await writeStore("congViec", taskFromServer(result.data.data.task, ownerId, task.id));
            await deleteQueueEntry(task.id);
        }

        const listResult = await apiRequest("/tasks", session.token);
        if (listResult.response.status === 401) {
            return;
        }
        if (!listResult.response.ok) {
            throw new Error(listResult.data.message || "Không thể tải công việc từ máy chủ.");
        }
        const localTasks = (await readAllFromStore("congViec")).filter(function (task) {
            return task.ownerId === ownerId;
        });
        for (const remote of listResult.data.data.tasks) {
            const local = localTasks.find(function (task) {
                return String(task.id) === String(remote.clientId);
            });
            if (!local) {
                await writeStore("congViec", taskFromServer(remote, ownerId));
            } else if (!local.dirty &&
                (remote.version !== local.serverVersion || remote.updatedAt !== local.updatedAt)) {
                await writeStore("congViec", taskFromServer(remote, ownerId, local.id));
            } else if (local.dirty && remote.version > (local.serverVersion || 0)) {
                local.conflict = taskFromServer(remote, ownerId, local.id);
                await writeStore("congViec", local);
            }
        }
        await broadcastSyncComplete();
    } finally {
        if (lockHeartbeat) {
            clearInterval(lockHeartbeat);
        }
        if (lockAcquired) {
            await releaseSyncLock(owner);
        }
    }
}
