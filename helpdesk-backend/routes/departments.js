const express = require("express");
const { requireAuth } = require("../middleware/auth");
const departments = require("../config/departments");

const { isHidden } = require("../services/executorGroups");

module.exports = function departmentRoutes(db) {
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
        // Скрытую группу нет на плитках «Новой заявки» — заявки к ней приходят
        // своими путями (например, по программам из Заявки на доступ). В
        // фильтре списка и в карточке она остаётся.
        hidden: Boolean(db && isHidden(db, d.role)),
      })),
    });
  });

  return router;
};
