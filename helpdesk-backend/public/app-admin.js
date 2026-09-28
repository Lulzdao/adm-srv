// Фронтенд платформы: дашборд, администрирование, сертификаты.
// Обычный скрипт без сборщика — функции общие для всех файлов страницы (см. index.html: app.js
// подключается первым, запуск — в нём по DOMContentLoaded, когда загружены все).
// ====== Дашборд ======
async function renderDashboard(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Статистика</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;
  try {
    // Раньше здесь скачивался весь список заявок, чтобы посчитать в браузере
    // шесть чисел и гистограмму: 1,87 МБ ради полутора сотен байт полезного.
    // Теперь всё считает SQL одним проходом.
    const stats = await api("/admin/stats");
    const open = stats.open;
    const critical = stats.critical;
    const closed = stats.closedTotal;

    // Состав и порядок отделов берём из своего справочника, а не из ответа:
    // отдел, по которому заявок ещё не было, должен остаться на гистограмме.
    const byCategory = state.departments.map(d => ({ name: d.name, count: (stats.byCategory || {})[d.name] || 0 }));
    const maxCount = Math.max(...byCategory.map(c => c.count), 1);

    const topList = (rows) => rows.length
      ? rows.map((r, i) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;${i > 0 ? "border-top:1px solid var(--line-soft);" : ""}">
          <span style="font-size:12.5px;">${i + 1}. ${esc(r.full_name)}</span>
          <span class="mono" style="font-size:12.5px;color:var(--ink-soft);">${r.n} закрыто</span>
        </div>`).join("")
      : `<div style="font-size:12.5px;color:var(--ink-soft);padding:8px 0;">Пока нет закрытых заявок за этот период.</div>`;

    main.querySelector(".page").innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">ОТКРЫТО СЕЙЧАС</div><div class="stat-value mono">${open}</div></div>
        <div class="stat-card"><div class="stat-label">КРИТИЧНЫХ АКТИВНЫХ</div><div class="stat-value mono" style="color:${critical ? "var(--red)" : "var(--ink)"};">${critical}</div></div>
        <div class="stat-card"><div class="stat-label">ЗАКРЫТО ЗА 7 ДНЕЙ</div><div class="stat-value mono">${stats.closed7}</div></div>
        <div class="stat-card"><div class="stat-label">ЗАКРЫТО ЗА 30 ДНЕЙ</div><div class="stat-value mono">${stats.closed30}</div></div>
      </div>
      <div class="stat-grid" style="grid-template-columns:1fr 1fr;">
        <div class="stat-card"><div class="stat-label">ЗАКРЫТО ВСЕГО</div><div class="stat-value mono">${closed}</div></div>
        <div class="stat-card"><div class="stat-label">ВСЕГО ЗАЯВОК</div><div class="stat-value mono">${stats.total}</div></div>
      </div>
      <div class="card" style="margin-bottom:20px;">
        <div class="section-label" style="margin-bottom:16px;">Заявки по отделам</div>
        ${byCategory.map(c => `
          <div class="bar-row">
            <div style="width:130px;font-size:12.5px;">${esc(c.name)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${(c.count/maxCount)*100}%"></div></div>
            <div style="width:20px;font-size:12px;text-align:right;" class="mono">${c.count}</div>
          </div>`).join("")}
      </div>
      <div style="display:flex;gap:14px;">
        <div class="card" style="flex:1;">
          <div class="section-label">Топ по закрытым — неделя</div>
          ${topList(stats.topWeek)}
        </div>
        <div class="card" style="flex:1;">
          <div class="section-label">Топ по закрытым — месяц</div>
          ${topList(stats.topMonth)}
        </div>
      </div>`;
  } catch (e) {
    main.querySelector(".page").innerHTML = `<div class="empty-state">Не удалось загрузить статистику: ${esc(e.message)}</div>`;
  }
}

// ====== Администрирование ======
async function renderAdmin(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Администрирование</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;
  try {
    const [{ departments: deptSettings, adminGroups }, { admins, executors }] = await Promise.all([
      api("/admin/settings"), api("/admin/admins"),
    ]);

    const ROLE_LABEL = Object.fromEntries(deptSettings.map(d => [d.role, d.name]));

    const groupRow = (id, label, value, placeholder) => `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
        <span style="width:70px;font-size:12px;color:var(--ink-soft);font-weight:600;">${label}</span>
        <input class="input" id="${id}" style="flex:1;" value="${esc(value)}" placeholder="${esc(placeholder)}">
      </div>`;

    const groupCard = (dept) => `
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label">Группа АД — исполнители отдела ${esc(dept.name)}</div>
        ${groupRow(`group_${dept.role}_A`, "Домен А", dept.groupA, "имя группы")}
        ${groupRow(`group_${dept.role}_B`, "Домен Б", dept.groupB, "имя группы")}
      </div>`;

    const человек = (a, показатьРоль) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid var(--line-soft);">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:13px;font-weight:600;">${esc(a.full_name)}</span>
          <span class="mono" style="font-size:12px;color:var(--ink-soft);">${esc(a.ad_login)}</span>
          ${показатьРоль ? (a.roles || [a.role]).map(r => `<span class="badge" style="color:var(--wire);background:var(--wire-soft);">${esc(ROLE_LABEL[r] || r)}</span>`).join("") : ""}
          <span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">${a.last_domain === "local" ? "Локальный" : "Домен " + esc(a.last_domain)}</span>
        </div>
        <span style="font-size:11px;color:var(--ink-soft);">вход ${fmtDate(a.last_login_at)}</span>
      </div>`;

    const пусто = (текст) => `<div style="font-size:12.5px;color:var(--ink-soft);">${текст}</div>`;

    main.querySelector(".page").innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <div class="section-label">Администраторы платформы</div>
        <div style="font-size:11.5px;color:var(--ink-soft);margin-bottom:6px;">
          Права даёт членство в группе, указанной в <code class="mono">.env</code> на сервере:
          <span class="mono">${esc(adminGroups.A || "— не задана —")}</span> (домен А),
          <span class="mono">${esc(adminGroups.B || "— не задана —")}</span> (домен Б).
          Отсюда список не редактируется и группами отделов ниже не расширяется.
        </div>
        ${admins.length ? admins.map(a => человек(a, false)).join("") : пусто("Ни один администратор ещё не входил.")}
      </div>

      <div class="card" style="margin-bottom:20px;">
        <div class="section-label">Исполнители по отделам</div>
        <div style="font-size:11.5px;color:var(--ink-soft);margin-bottom:6px;">
          Читается из членства в группах отделов на момент последнего входа. Прав администратора не даёт.
        </div>
        ${executors.length ? executors.map(a => человек(a, true)).join("") : пусто("Пока никто не входил под ролью исполнителя.")}
      </div>

      <div style="display:flex;gap:20px;align-items:flex-start;">
        <div style="flex:1;min-width:0;">
          <div class="card">
            <div class="section-label">Как добавить ещё одну группу исполнителей</div>
            <div style="font-size:12.5px;line-height:1.7;color:var(--ink);">
              1. На сервере откройте файл <code class="mono" style="background:var(--line-soft);padding:1px 5px;border-radius:3px;">config/departments.js</code><br>
              2. Добавьте одну строку в список, например:<br>
              <code class="mono" style="display:block;background:var(--line-soft);padding:8px 10px;border-radius:5px;margin:6px 0;font-size:11.5px;">{ name: "БУХ", prefix: "БУХ", role: "buh" }</code>
              3. Перезапустите сервер (<code class="mono" style="background:var(--line-soft);padding:1px 5px;border-radius:3px;">npm start</code>)<br>
              4. Новый отдел появится в форме создания заявки, в фильтре списка и справа на этой странице — впишите туда название AD-группы, как для остальных отделов.
            </div>
          </div>
        </div>
        <div style="width:380px;flex-shrink:0;">
          ${deptSettings.map(groupCard).join("")}
          <button class="btn btn-wire" id="saveGroups" style="width:100%;justify-content:center;">Сохранить</button>
          <div id="saveMsg" style="margin-top:8px;font-size:12px;color:var(--green);display:none;text-align:center;">Сохранено</div>
        </div>
      </div>`;

    document.getElementById("saveGroups").onclick = async () => {
      try {
        const payload = deptSettings.map(dept => ({
          role: dept.role,
          groupA: document.getElementById(`group_${dept.role}_A`).value.trim(),
          groupB: document.getElementById(`group_${dept.role}_B`).value.trim(),
        }));
        await api("/admin/settings", { method: "PUT", body: { departments: payload } });
        const msg = document.getElementById("saveMsg");
        msg.style.display = "block"; setTimeout(() => msg.style.display = "none", 2500);
      } catch (e) { toast(e.message, true); }
    };
  } catch (e) {
    main.querySelector(".page").innerHTML = `<div class="empty-state">Не удалось загрузить: ${esc(e.message)}</div>`;
  }
}

// ====== Сертификаты ======
// Экран про «сертификаты» — это на самом деле про две разные вещи, которые
// постоянно путают, и разница между ними определяет всю раскладку:
//
//   • СЕРТИФИКАТ СЕРВЕРА — что мы ПРЕДЪЯВЛЯЕМ клиентам. Это вся повседневная
//     работа: продлили — загрузили. Поэтому загрузка здесь же, на видном
//     месте, а не «положите файл вот в эту папку на сервере». Файл ОДИН и
//     общий с «Искрой»: обе службы на одной машине и отвечают на одно имя.
//
//   • ДОВЕРЕННЫЕ КОРНИ — кому верим МЫ, когда сами ходим наружу (LDAPS к
//     контроллерам домена, проксирование в «Искру»). Клиентов это не касается
//     совсем: они берут корни из хранилища Windows, куда те приезжают
//     групповыми политиками. На доменной машине раздел не нужен вообще,
//     поэтому он свёрнут и лежит внизу.
async function renderCertificates(main) {
  main.innerHTML = `<div class="topbar"><div class="topbar-title">Сертификаты</div></div><div class="page"><div class="spinner">Загрузка…</div></div>`;

  const days = (n) => {
    if (n === null || n === undefined) return "";
    if (n < 0) return `<span class="badge" style="color:var(--red);background:var(--red-soft);">истёк ${-n} дн. назад</span>`;
    if (n < 30) return `<span class="badge" style="color:var(--amber);background:var(--amber-soft);">осталось ${n} дн.</span>`;
    return `<span class="badge" style="color:var(--green);background:var(--green-soft);">осталось ${n} дн.</span>`;
  };
  const row = (label, value) => `
    <div class="field-mini"><div class="field-mini-label">${esc(label)}</div>
    <div class="field-mini-value">${value}</div></div>`;

  try {
    const [server, trusted, mods] = await Promise.all([
      api("/certificates/server"), api("/certificates/trusted"), api("/certificates/modules"),
    ]);

    const c = server.certificate;
    const serverCard = !server.secure
      ? `<div class="warn-box">Платформа работает по HTTP — сертификат не задан. Пароли и переписка идут открытым текстом.</div>`
      : c
        ? `${row("Кому выдан", esc(c.subject || "—"))}
           ${row("Имена в сертификате (SAN)", `<span class="mono" style="font-size:12px;">${esc(c.san || "—")}</span>`)}
           ${row("Кем выдан", esc(c.issuer || "—"))}
           ${row("Действителен до", `${esc(c.validTo || "—")} ${days(c.daysLeft)}`)}
           ${row("Корень цепочки", esc(c.rootSubject || "—"))}
           ${row("Цепочка", c.chainComplete
              ? `<span class="badge" style="color:var(--green);background:var(--green-soft);">полная (${c.certificates} серт.)</span>`
              : `<span class="badge" style="color:var(--amber);background:var(--amber-soft);">неполная — клиент может не достроить доверие</span>`)}
           ${row("Отпечаток", `<span class="mono" style="font-size:11px;word-break:break-all;">${esc(c.fingerprint || "—")}</span>`)}`
        : `<div style="font-size:12.5px;color:var(--ink-soft);">Сертификат применён, подробности ещё читаются…</div>`;

    const rootRow = (r) => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--line-soft);">
        <div style="min-width:0;">
          <div style="font-size:13px;font-weight:600;">${esc(r.subject || r.file)}</div>
          <div style="font-size:11.5px;color:var(--ink-soft);">
            <span class="mono">${esc(r.file)}</span>${r.error ? ` · <span style="color:var(--red);">${esc(r.error)}</span>` : ""}
            ${r.warning ? ` · <span style="color:var(--amber);">${esc(r.warning)}</span>` : ""}
            ${r.selfSigned === false ? " · промежуточный, не корень" : ""}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
          ${r.daysLeft !== undefined && r.daysLeft !== null ? days(r.daysLeft) : ""}
          <button class="btn btn-ghost del-root" data-file="${esc(r.file)}">Удалить</button>
        </div>
      </div>`;

    const modRow = (m) => {
      let status;
      if (!m.secure) status = `<span class="badge" style="color:var(--ink-soft);background:var(--line-soft);">без шифрования</span>`;
      else if (m.error) status = `<span class="badge" style="color:var(--red);background:var(--red-soft);">${esc(m.error)}</span>`;
      else if (!m.authorized) status = `<span class="badge" style="color:var(--red);background:var(--red-soft);">не проходит проверку: ${esc(m.authorizationError || "")}</span>`;
      else status = `<span class="badge" style="color:var(--green);background:var(--green-soft);">проверку проходит</span>`;
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--line-soft);">
          <div style="min-width:0;">
            <div style="font-size:13px;font-weight:600;">${esc(m.label)}</div>
            <div class="mono" style="font-size:11.5px;color:var(--ink-soft);">${esc(m.target)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
            ${m.certificate && m.certificate.daysLeft !== null ? days(m.certificate.daysLeft) : ""}
            ${status}
          </div>
        </div>`;
    };

    main.querySelector(".page").innerHTML = `
      <div style="max-width:900px;">
        <div>
          <div class="card" style="margin-bottom:20px;">
            <div class="section-label">Сертификат сервера — что мы предъявляем</div>
            <div style="font-size:12px;color:var(--ink-soft);margin-bottom:14px;">
              Сертификат один на обе службы: платформа и «Искра» стоят на одной машине и отвечают
              на одно имя. ${server.managedBy === "store"
                ? `Файл лежит в <span class="mono">${esc(server.sharedStore)}</span>; загрузить новый можно здесь же (форма ниже) или в панели «Искры» — разницы нет, файл тот же. Платформа перечитывает его сама; «Искре» нужен перезапуск службы — своего слежения за хранилищем у неё нет.`
                : `Сейчас путь задан переменными окружения: <span class="mono">${esc(server.where || "")}</span>. Тогда сертификат <b>не общий</b> с «Искрой» — она читает своё хранилище и может предъявлять другой файл, — а загрузка из панели отключена.`}
            </div>
            ${server.managedBy === "env" ? `<div class="warn-box" style="margin-bottom:14px;">
              <div>
              Чтобы вернуть общий сертификат и загрузку отсюда: уберите <span class="mono">TLS_PFX</span>
              (или <span class="mono">TLS_CERT</span>/<span class="mono">TLS_KEY</span>) из
              <span class="mono">.env</span> и укажите путь к каталогу <span class="mono">certs</span>
              работающей «Искры»: <span class="mono">SHARED_CERT_DIR=&lt;папка Искры&gt;\\certs</span>.
              Сейчас платформа ищет хранилище в <span class="mono">${esc(server.storeDir || "")}</span> —
              если «Искра» стоит не там, сертификат она не найдёт. После правки нужен перезапуск.
              </div>
            </div>` : ""}
            ${serverCard}

            ${server.managedBy === "store" ? `
            <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line-soft);">
              <div class="section-label" style="margin-bottom:8px;">Заменить сертификат</div>
              <div style="font-size:12px;color:var(--ink-soft);margin-bottom:12px;">
                PFX (.pfx или .p12) — экспортированный из удостоверяющего центра домена вместе с
                закрытым ключом и всеми сертификатами пути. Файл сначала проверяется (пароль, срок,
                цепочка) и только потом заменяет действующий: испортить работающую платформу
                загрузкой не того файла нельзя. Прежний остаётся рядом с суффиксом
                <span class="mono">.bak</span>.
              </div>
              <div class="form-row" style="margin-bottom:12px;">
                <div>
                  <div class="field-label">Файл</div>
                  <input class="field-input" id="certFile" type="file" accept=".pfx,.p12" style="margin-bottom:0;padding:10px 12px;">
                </div>
                <div>
                  <div class="field-label">Пароль к файлу</div>
                  <input class="field-input" id="certPass" type="password" placeholder="если он есть" style="margin-bottom:0;">
                </div>
              </div>
              <button class="btn btn-wire" id="certUpload">Загрузить и применить</button>
              <div id="certMsg" style="margin-top:10px;font-size:12.5px;"></div>
            </div>` : ""}
          </div>

          <div class="card">
            <div class="section-label">Модули — что предъявляют они</div>
            <div style="font-size:12px;color:var(--ink-soft);margin-bottom:6px;">
              Платформа проверяет сертификат модуля по-настоящему, поэтому модуль должен быть
              адресован именем из его сертификата, а не по IP.
            </div>
            ${mods.modules.map(modRow).join("")}
          </div>
        </div>

      </div>

      <details class="card" style="margin-top:20px;">
        <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--ink-soft);">
          Доверенные корни — кому верим мы. Обычно трогать не нужно
        </summary>
        <div style="font-size:12px;color:var(--ink-soft);margin:14px 0 12px;max-width:760px;">
          Это не про клиентов: они берут корни из хранилища Windows, куда те приезжают групповыми
          политиками, и панель на это никак не влияет. Список ниже — про исходящие соединения самой
          платформы: LDAPS к контроллерам доменов и проверка сертификата «Искры» при
          проксировании. Удостоверяющий центр у нас один, и на доменной машине здесь не нужно
          ничего: платформа запускается с <span class="mono">--use-system-ca</span> и доверяет тому
          же хранилищу Windows. Раздел пригождается в двух случаях: машина вне домена и переходный
          период при смене УЦ. Файлы лежат в <span class="mono">${esc(trusted.dir)}</span>,
          подключаются переменной <span class="mono">NODE_EXTRA_CA_CERTS</span> и начинают
          действовать только после перезапуска платформы.
        </div>
        <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;">
          <div style="flex:1;min-width:320px;">
            ${trusted.roots.length ? trusted.roots.map(rootRow).join("")
              : `<div style="font-size:12.5px;color:var(--ink-soft);">Пока пусто — и это нормальное состояние.</div>`}
          </div>
          <div style="width:380px;flex-shrink:0;">
            <div class="field-label">Добавить корень</div>
            <input class="field-input" id="rootName" placeholder="например domain-b-root.crt" style="margin-bottom:10px;">
            <textarea class="input" id="rootPem" rows="5" placeholder="-----BEGIN CERTIFICATE-----" style="width:100%;font-family:var(--mono);font-size:11px;margin-bottom:10px;"></textarea>
            <button class="btn btn-wire" id="addRoot" style="width:100%;justify-content:center;">Добавить</button>
            <div id="rootMsg" style="margin-top:8px;font-size:12px;text-align:center;"></div>
          </div>
        </div>
      </details>`;

    const uploadBtn = document.getElementById("certUpload");
    if (uploadBtn) uploadBtn.onclick = async () => {
      const msg = document.getElementById("certMsg");
      const input = document.getElementById("certFile");
      const file = input.files && input.files[0];
      if (!file) { msg.style.color = "var(--red)"; msg.textContent = "Выберите файл"; return; }
      msg.style.color = "var(--ink-soft)"; msg.textContent = "Проверяю файл…";
      try {
        // Читаем в base64 на клиенте: так тело остаётся обычным JSON и не
        // требует отдельной обработки multipart ради одного файла.
        const b64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1] || "");
          r.onerror = () => reject(new Error("Файл не читается"));
          r.readAsDataURL(file);
        });
        const res = await api("/certificates/server", {
          method: "POST",
          body: { pfx: b64, password: document.getElementById("certPass").value },
        });
        renderCertificates(main);
        toast(res.restartRequired
          ? "Файл сохранён. Нужен перезапуск: включить шифрование на работающем HTTP-сервере нельзя."
          : "Сертификат применён — платформе перезапуск не нужен. «Искру» перезапустите: она читает то же хранилище, но следить за ним не умеет и до перезапуска будет предъявлять прежний сертификат.");
      } catch (e) { msg.style.color = "var(--red)"; msg.textContent = e.message; }
    };

    document.getElementById("addRoot").onclick = async () => {
      const msg = document.getElementById("rootMsg");
      msg.style.color = "var(--ink-soft)"; msg.textContent = "Проверяю…";
      try {
        await api("/certificates/trusted", {
          method: "POST",
          body: {
            name: document.getElementById("rootName").value.trim(),
            pem: document.getElementById("rootPem").value,
          },
        });
        renderCertificates(main);
        toast("Корень добавлен. Перезапустите платформу, чтобы он начал действовать.");
      } catch (e) { msg.style.color = "var(--red)"; msg.textContent = e.message; }
    };

    main.querySelectorAll(".del-root").forEach(btn => {
      btn.onclick = async () => {
        if (!confirm(`Удалить ${btn.dataset.file} из доверенных?`)) return;
        try {
          await api(`/certificates/trusted/${encodeURIComponent(btn.dataset.file)}`, { method: "DELETE" });
          renderCertificates(main);
        } catch (e) { toast(e.message, true); }
      };
    });
  } catch (e) {
    main.querySelector(".page").innerHTML = `<div class="empty-state">Не удалось загрузить: ${esc(e.message)}</div>`;
  }
}
