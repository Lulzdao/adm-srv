const express = require("express");
const { createProxyMiddleware, fixRequestBody } = require("http-proxy-middleware");
const { requireAuth } = require("../middleware/auth");
const modules = require("../config/modules");

// Единственная точка, где встроенные модули (Сертвивер, журнал звонков и
// т.д.) подключаются к платформе. Сами модули слушают только на 127.0.0.1 и
// ничего не знают про логин — вход и роль проверяются здесь, до того как
// запрос вообще уйдёт дальше. Добавление нового модуля — одна строка в
// config/modules.js, сюда возвращаться не нужно.
module.exports = function () {
  const router = express.Router();

  // Список модулей, доступных текущей роли — фронтенд строит по нему пункты
  // меню, не зная заранее, что вообще подключено на платформе.
  router.get("/api/modules", requireAuth, (req, res) => {
    const visible = modules
      .filter((m) => m.roles.includes(req.session.user.role))
      .map((m) => ({ id: m.id, label: m.label, path: m.path, views: m.views }));
    res.json({ modules: visible });
  });

  for (const mod of modules) {
    router.use(
      mod.path,
      requireAuth,
      (req, res, next) => {
        if (!mod.roles.includes(req.session.user.role)) {
          return res.status(403).json({ error: "Недостаточно прав для этого модуля" });
        }
        next();
      },
      createProxyMiddleware({
        target: mod.target,
        changeOrigin: true,
        // express.json()/urlencoded() в server.js уже разбирают тело запроса
        // раньше, чем оно доходит сюда — без этого POST-запросы (например,
        // форма логина или загрузка сертификата) уходили бы в модуль с
        // пустым телом. fixRequestBody пересобирает req.body обратно перед
        // пересылкой.
        on: {
          proxyReq: (proxyReq, req, res) => {
            // express.json()/urlencoded() кладут в req.body пустой объект {}
            // даже для запросов, которые сами не разбирают (multipart они не
            // трогают). {} — truthy, поэтому fixRequestBody решает, что тело
            // уже разобрано, и пытается пересобрать multipart из пустого
            // объекта — реальный файл при этом теряется, и Сертвивер получает
            // оборванную форму ("Unexpected end of form" в busboy). Файлы
            // должны идти как есть, потоком — fixRequestBody нужен только для
            // JSON/urlencoded тел, которые действительно были разобраны выше
            // (например, форма логина).
            const contentType = req.headers["content-type"] || "";
            if (contentType.startsWith("multipart/form-data")) return;
            fixRequestBody(proxyReq, req);
          },
          // Если сам модуль недоступен, упал или оборвал соединение —
          // отвечаем JSON, а не тем, что вернёт по умолчанию сам прокси
          // (иначе фронтенд ловит "Unexpected token" при попытке разобрать
          // не-JSON ответ).
          error: (err, req, res) => {
            console.error(`[прокси ${mod.id}]`, err.message);
            if (res.headersSent) return;
            res.status(502).json({ error: `Модуль «${mod.label}» временно недоступен` });
          },
        },
        // Express уже срезает mod.path из req.url при router.use(mod.path, ...) —
        // модуль получает запрос так, будто обращаются к его собственному корню.
      })
    );
  }

  return router;
};
