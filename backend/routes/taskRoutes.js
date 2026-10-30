const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const { list, upsert, remove } = require("../controllers/taskController");

const router = express.Router();

router.use(requireAuth);
router.get("/", list);
router.put("/:clientId", upsert);
router.delete("/:clientId", remove);

module.exports = router;
