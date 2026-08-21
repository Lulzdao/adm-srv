const express = require("express");
const { requireAuth } = require("../middleware/auth");
const departments = require("../config/departments");

module.exports = function departmentRoutes() {
  const router = express.Router();
  router.use(requireAuth);

  router.get("/", (req, res) => {
    res.json({ departments: departments.map((d) => ({ name: d.name, role: d.role })) });
  });

  return router;
};
