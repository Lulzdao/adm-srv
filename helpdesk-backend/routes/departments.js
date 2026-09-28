const express = require("express");
const { requireAuth } = require("../middleware/auth");
const departments = require("../config/departments");

module.exports = function departmentRoutes() {
  const router = express.Router();
  router.use(requireAuth);

  router.get("/", (req, res) => {
    // hint/icon/color — оформление плитки отдела на экране новой заявки.
    // Отдаём их вместе с именем: иначе фронтенду пришлось бы держать вторую
    // копию справочника отделов и та рано или поздно разошлась бы с конфигом.
    res.json({
      departments: departments.map((d) => ({
        name: d.name, role: d.role,
        hint: d.hint || "", icon: d.icon || "", color: d.color || "",
      })),
    });
  });

  return router;
};
